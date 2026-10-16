import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { Infrastructure } from "../server/infrastructure.ts";
import { Operations, opsMailFromEnv } from "../server/operations.ts";
import { createApplication } from "../server/app.ts";
import { digest, secret } from "../server/auth.ts";
import { locales, translate } from "../src/i18n/messages.ts";

function fixture(t: any, path = ":memory:") {
  const store = new Store(path),
    infra = new Infrastructure(store),
    ops = new Operations(store, infra);
  t.after(() => store.close());
  return { store, infra, ops };
}
function clock(t: any) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  return (ms: number) => (now += ms);
}
function node(s: Store, data: object = {}) {
  const id = randomUUID();
  s.run(
    "INSERT INTO servers(id,data,tokenHash,lastHeartbeat,capabilities) VALUES(?,?,?,?,?)",
    id,
    JSON.stringify({
      name: "Test node",
      workMode: "inference",
      schedulingEnabled: true,
      maintenance: false,
      ...data,
    }),
    digest(secret()),
    Date.now(),
    JSON.stringify({ dockerReady: true, inferenceReady: true }),
  );
  return id;
}
function deployment(s: Store, serverId: string, phase: string) {
  const id = randomUUID(),
    user = s.createUser(
      "Operator",
      randomUUID() + "@tests.invalid",
      "original-secret-hash",
      "admin",
    ),
    model = s.get<{ id: string }>(
      "SELECT id FROM models WHERE deleted=0 LIMIT 1",
    )!;
  s.run(
    "INSERT INTO deployments(id,serverId,modelId,phase,spec,actorId,requestKey,fingerprint,createdAt,healthAt) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id,
    serverId,
    model.id,
    phase,
    "{}",
    user.id,
    randomUUID(),
    "private-fingerprint",
    Date.now(),
    Date.now(),
  );
  return id;
}
function fakeMail(ops: Operations) {
  const messages: any[] = [];
  ops.mail = {
    recipient: "ops@tests.invalid",
    locale: "zh-CN",
    mail: {
      origin: "https://control.tests.invalid",
      send: async (m) => {
        messages.push(m);
      },
    },
  };
  return messages;
}

test("alerts persist, acknowledge without clearing, recover and recur; financial checks change no money", (t) => {
  const { store: s, ops } = fixture(t),
    advance = clock(t),
    u = s.createUser("Buyer", "buyer@tests.invalid", "private-hash");
  s.run("UPDATE users SET balance=100,paymentDebt=10 WHERE id=?", u.id);
  const money = () =>
      JSON.stringify([
        s.all("SELECT * FROM users"),
        s.all("SELECT * FROM ledger"),
        s.all("SELECT * FROM gpu_allocations"),
      ]),
    before = money();
  ops.scan();
  assert.equal(money(), before); // Store.transaction would repay this debt; monitoring must not.
  const report = ops.list(null, null);
  assert.equal(report.counts?.active, 2);
  assert.equal(report.notifications.length, 0);
  assert.equal(report.notificationsEnabled, false);
  const alert = report.alerts.find((a) => a.code === "audit.balance_mismatch")!;
  ops.acknowledge(alert.id, u.id);
  advance(1000);
  ops.acknowledge(alert.id, u.id);
  ops.scan();
  assert.equal(ops.list(null, null).counts?.active, 2);
  assert.equal(
    s.get<{ ackAt: number }>(
      "SELECT ackAt FROM ops_alerts WHERE id=?",
      alert.id,
    )!.ackAt,
    Date.now() - 1000,
  );
  s.run("UPDATE users SET balance=0,paymentDebt=0 WHERE id=?", u.id);
  ops.scan();
  assert.equal(ops.list(null, null).counts?.active, 0);
  assert.equal(ops.list("resolved", null).alerts.length, 2);
  s.run("UPDATE users SET balance=100 WHERE id=?", u.id);
  ops.scan();
  assert.notEqual(ops.list(null, null).alerts[0].id, alert.id);
  assert.equal(s.all("PRAGMA foreign_key_check").length, 0);
});

test("node and deployment grace periods suppress flaps, keep physical claims and honour maintenance", (t) => {
  const { store: s, ops } = fixture(t),
    advance = clock(t),
    id = node(s);
  const d = deployment(s, id, "checking");
  s.run("INSERT INTO gpu_allocations VALUES(?,?,?,0)", d, id, "GPU-test");
  s.run(
    "UPDATE servers SET lastHeartbeat=? WHERE id=?",
    Date.now() - 50000,
    id,
  );
  ops.scan();
  advance(299999);
  ops.scan();
  assert.equal(ops.list(null, null).alerts.length, 0);
  advance(1);
  ops.scan();
  assert.deepEqual(
    ops
      .list(null, null)
      .alerts.map((a) => a.code)
      .sort(),
    ["ops.deployment_unhealthy", "ops.node_offline"],
  );
  assert.equal(
    s.get<{ released: number }>("SELECT released FROM gpu_allocations")!
      .released,
    0,
  );
  s.run("UPDATE servers SET lastHeartbeat=? WHERE id=?", Date.now(), id);
  s.run(
    "UPDATE deployments SET phase='ready',healthAt=? WHERE id=?",
    Date.now(),
    d,
  );
  ops.scan();
  assert.equal(ops.list(null, null).alerts.length, 0);
  const maintenance = node(s, { maintenance: true });
  s.run("UPDATE servers SET lastHeartbeat=NULL WHERE id=?", maintenance);
  ops.scan();
  advance(300000);
  s.run("UPDATE servers SET lastHeartbeat=? WHERE id=?", Date.now(), id);
  s.run("UPDATE deployments SET healthAt=? WHERE id=?", Date.now(), d);
  ops.scan();
  assert.equal(ops.list(null, null).alerts.length, 0);
  s.run(
    "UPDATE servers SET inventoryError=? WHERE id=?",
    "SECRET_RAW_DOCKER_OUTPUT",
    id,
  );
  ops.scan();
  advance(300000);
  s.run("UPDATE servers SET lastHeartbeat=? WHERE id=?", Date.now(), id);
  s.run("UPDATE deployments SET healthAt=? WHERE id=?", Date.now(), d);
  ops.scan();
  assert(
    ops.list(null, null).alerts.some((a) => a.code === "ops.inventory_error"),
  );
  assert(
    !JSON.stringify(ops.list(null, null)).includes("SECRET_RAW_DOCKER_OUTPUT"),
  );
});

test("failed deployment is immediate; managed-model availability uses healthy routes", (t) => {
  const { store: s, ops } = fixture(t),
    advance = clock(t),
    id = node(s),
    d = deployment(s, id, "failed");
  const modelId = s.get<{ modelId: string }>(
    "SELECT modelId FROM deployments WHERE id=?",
    d,
  )!.modelId;
  const model = s.model(modelId)!;
  s.run(
    "UPDATE models SET data=? WHERE id=?",
    JSON.stringify({ ...model, enabled: true, routingMode: "managed" }),
    modelId,
  );
  ops.scan();
  assert.equal(ops.list(null, null).alerts[0].code, "ops.deployment_failed");
  advance(300000);
  s.run("UPDATE servers SET lastHeartbeat=? WHERE id=?", Date.now(), id);
  ops.scan();
  assert(
    ops.list(null, null).alerts.some((a) => a.code === "ops.model_unavailable"),
  );
  s.run(
    "UPDATE deployments SET phase='ready',healthAt=? WHERE id=?",
    Date.now(),
    d,
  );
  ops.scan();
  assert.equal(ops.list(null, null).alerts.length, 0);
});

test("check failures retain existing incidents, surface staleness and recover without false resolution", (t) => {
  const { store: s, ops } = fixture(t),
    advance = clock(t),
    u = s.createUser("Buyer", "buyer@tests.invalid", "unused");
  s.run("UPDATE users SET balance=1 WHERE id=?", u.id);
  ops.scan();
  const model = s.get<{ id: string; data: string }>(
    "SELECT * FROM models WHERE deleted=0 LIMIT 1",
  )!;
  s.run("UPDATE models SET data='{' WHERE id=?", model.id);
  ops.scan();
  assert.equal(ops.status().stale, true);
  assert.equal(ops.list(null, null).counts?.active, 2);
  s.run("UPDATE models SET data=? WHERE id=?", model.data, model.id);
  ops.scan();
  assert.equal(ops.status().stale, false);
  assert.equal(ops.list(null, null).alerts[0].code, "audit.balance_mismatch");
  advance(120001);
  assert.equal(ops.status().stale, true);
});

test("bounded rolling metrics separate slow inference, aborted connections and completed 5xx", (t) => {
  const { ops } = fixture(t),
    advance = clock(t);
  for (let i = 0; i < 20; i++) {
    ops.record("inference", i < 2 ? 502 : 200, 60000);
    ops.record("api", 200, 10);
  }
  ops.record("api", 500, 1, true);
  ops.scan();
  assert.equal(ops.metrics().api.requests, 20);
  assert.equal(ops.metrics().api.aborted, 1);
  assert.equal(ops.metrics().inference.errorRate, 0.1);
  assert.deepEqual(
    ops.list(null, null).alerts.map((a) => [a.code, a.entityId]),
    [["ops.http_errors", "inference"]],
  );
  for (let i = 0; i < 20; i++) ops.record("api", 500, 5000);
  ops.scan();
  assert(ops.list(null, null).alerts.some((a) => a.code === "ops.api_slow"));
  advance(300001);
  ops.scan();
  assert.equal(ops.metrics().api.requests, 0);
  assert.equal(ops.buckets.size, 0);
  assert.equal(ops.list(null, null).alerts.length, 0);
});

test("SSE final failures alert from durable requests even with successful HTTP envelopes", (t) => {
  const { store: s, ops } = fixture(t),
    u = s.createUser("Buyer", "buyer@tests.invalid", "unused");
  for (let i = 0; i < 20; i++)
    s.run(
      "INSERT INTO requests(id,userId,requestKey,fingerprint,day,status,reserved,response,modelId,modelName,inputPrice,outputPrice,createdAt) VALUES(?,?,?,?,?,'failed',0,?,?,?,0,0,?)",
      randomUUID(),
      u.id,
      "test" + i,
      "private",
      "2026-10-16",
      '{"prompt":"PRIVATE_PROMPT"}',
      "test",
      "test",
      new Date().toISOString(),
    );
  ops.scan();
  const report = ops.list(null, null);
  assert(report.alerts.some((a) => a.code === "ops.inference_errors"));
  assert(!JSON.stringify(report).includes("PRIVATE_PROMPT"));
  assert.equal(s.user(u.id)!.balance, 0);
  assert.equal(s.all("SELECT * FROM ledger").length, 0);
});

test("SMTP digests deduplicate sustained conditions and send recovery in all four languages", async (t) => {
  const { store: s, ops } = fixture(t),
    messages = fakeMail(ops),
    u = s.createUser("Buyer", "buyer@tests.invalid", "unused");
  for (const locale of locales) {
    ops.mail!.locale = locale;
    s.run("UPDATE users SET balance=1 WHERE id=?", u.id);
    ops.scan();
    ops.scan();
    await Promise.all([ops.flush(), ops.flush()]);
    assert.equal(messages.at(-1).subject, translate(locale, "ops.mailSubject"));
    assert(
      messages
        .at(-1)
        .text.includes("https://control.tests.invalid/#/admin/operations"),
    );
    const count = messages.length;
    ops.acknowledge(ops.list(null, null).alerts[0].id, u.id);
    ops.scan();
    await ops.flush();
    assert.equal(messages.length, count);
    s.run("UPDATE users SET balance=0 WHERE id=?", u.id);
    ops.scan();
    await ops.flush();
    assert(messages.at(-1).text.includes(translate(locale, "ops.resolved")));
  }
  assert.equal(messages.length, 8);
  assert.equal(
    s.all("SELECT * FROM ops_notifications WHERE state='sent'").length,
    8,
  );
  assert(!JSON.stringify(ops.list(null, null)).includes("ops@tests.invalid"));
});

test("SMTP retry survives failures, caps attempts, hides raw errors and keeps original event time", async (t) => {
  const { store: s, ops } = fixture(t),
    advance = clock(t),
    u = s.createUser("Buyer", "buyer@tests.invalid", "unused");
  fakeMail(ops);
  let calls = 0;
  ops.mail!.mail.send = async () => {
    calls++;
    throw new Error("SMTP_PASSWORD=DO_NOT_STORE");
  };
  s.run("UPDATE users SET balance=1 WHERE id=?", u.id);
  ops.scan();
  for (let i = 0; i < 5; i++) {
    await ops.flush();
    await ops.flush();
    advance(3600000);
  }
  assert.equal(calls, 5);
  const n = ops.list(null, null).notifications[0] as any;
  assert.equal(n.state, "failed");
  assert.equal(n.attempts, 5);
  assert(!JSON.stringify(ops.list(null, null)).includes("DO_NOT_STORE"));
  ops.retry(n.id);
  assert.equal(
    (ops.list(null, null).notifications[0] as any).createdAt,
    n.createdAt,
  );
  const messages: any[] = [];
  ops.mail!.mail.send = async (m) => {
    messages.push(m);
  };
  await ops.flush();
  assert.equal(messages.length, 1);
  s.run("UPDATE users SET balance=0 WHERE id=?", u.id);
  ops.scan();
  advance(86400001);
  await ops.flush();
  const expired = ops.list(null, null).notifications[0] as any;
  assert.equal(expired.errorCode, "expired");
  assert.throws(() => ops.retry(expired.id), /expired/);
});

test("recipient changes and crash-at-attempt-limit do not leak or loop queued notifications", async (t) => {
  const { store: s, ops } = fixture(t),
    messages = fakeMail(ops),
    u = s.createUser("Buyer", "buyer@tests.invalid", "unused");
  s.run("UPDATE users SET balance=1 WHERE id=?", u.id);
  ops.scan();
  ops.mail!.recipient = "different@tests.invalid";
  await ops.flush();
  const n = ops.list(null, null).notifications[0] as any;
  assert.equal(n.errorCode, "recipient_changed");
  assert.equal(messages.length, 0);
  assert.throws(() => ops.retry(n.id), /Recipient/);
  ops.mail!.recipient = "ops@tests.invalid";
  ops.retry(n.id);
  s.run("UPDATE ops_notifications SET attempts=5 WHERE id=?", n.id);
  await ops.flush();
  assert.equal(messages.length, 0);
  assert.equal((ops.list(null, null).notifications[0] as any).state, "failed");
});

test("cold restart retains grace timers, acknowledgements and pending notifications", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cm-ops-")),
    path = join(dir, "test.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const advance = clock(t);
  let s = new Store(path),
    ops = new Operations(s, new Infrastructure(s));
  fakeMail(ops);
  const id = node(s);
  s.run("UPDATE servers SET lastHeartbeat=NULL WHERE id=?", id);
  ops.scan();
  advance(240000);
  s.close();
  s = new Store(path);
  t.after(() => s.close());
  ops = new Operations(s, new Infrastructure(s));
  const messages = fakeMail(ops);
  advance(60000);
  ops.scan();
  assert.equal(ops.list(null, null).alerts.length, 1);
  assert.equal(ops.list(null, null).notifications.length, 1);
  await ops.flush();
  ops.scan();
  await ops.flush();
  assert.equal(messages.length, 1);
  assert.equal(s.all("PRAGMA foreign_key_check").length, 0);
});

test("alert pagination validates cursors and does not repeat incidents", (t) => {
  const { store: s, ops } = fixture(t);
  for (let i = 0; i < 55; i++) {
    const u = s.createUser("Buyer", `buyer${i}@tests.invalid`, "unused");
    s.run("UPDATE users SET balance=1 WHERE id=?", u.id);
  }
  ops.scan();
  const page = ops.list(null, null),
    more = ops.list(null, String(page.nextCursor));
  assert.equal(page.alerts.length, 50);
  assert.equal(more.alerts.length, 5);
  assert.equal(more.nextCursor, null);
  assert.equal(
    new Set([...page.alerts, ...more.alerts].map((a) => a.id)).size,
    55,
  );
  assert.throws(() => ops.list("anything", null));
  assert.throws(() => ops.list(null, "-1"));
  assert.throws(() => ops.list(null, "1e3"));
});

test("operations HTTP routes require admin and CSRF; health and request IDs expose no internals", async (t) => {
  const app = createApplication({ databasePath: ":memory:" }),
    s = app.store;
  const admin = s.createUser(
      "Admin",
      "admin@tests.invalid",
      "DO_NOT_EXPOSE",
      "admin",
    ),
    user = s.createUser("User", "user@tests.invalid", "unused");
  const creds = new Map();
  for (const u of [admin, user]) {
    const token = secret(),
      csrf = secret();
    s.run(
      "INSERT INTO sessions VALUES(?,?,?,?)",
      digest(token),
      u.id,
      csrf,
      Date.now() + 100000,
    );
    creds.set(u.id, { Cookie: "cm_session=" + token, "X-CSRF-Token": csrf });
  }
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise<void>((r) => app.server.close(() => r()));
    await app.drain();
    s.close();
  });
  const origin = "http://127.0.0.1:" + (app.server.address() as any).port;
  async function call(path: string, who?: string, method = "GET", csrf = true) {
    const headers = { ...(who ? creds.get(who) : {}) };
    if (!csrf) delete headers["X-CSRF-Token"];
    const res = await fetch(origin + path, { method, headers });
    return {
      status: res.status,
      id: res.headers.get("x-request-id"),
      data: await res.json(),
    };
  }
  assert.equal((await call("/api/admin/operations")).status, 401);
  assert.equal((await call("/api/admin/operations", user.id)).status, 403);
  s.run("UPDATE users SET balance=1 WHERE id=?", user.id);
  app.operations.scan();
  const report = await call("/api/admin/operations", admin.id);
  assert.equal(report.status, 200);
  assert(!JSON.stringify(report).includes("DO_NOT_EXPOSE"));
  const ack = `/api/admin/operations/alerts/${report.data.alerts[0].id}/ack`;
  assert.equal((await call(ack, admin.id, "POST", false)).status, 403);
  assert.equal((await call(ack, admin.id, "POST")).status, 200);
  assert.equal((await call(ack, admin.id, "POST")).status, 200);
  assert.equal(
    (await call("/api/admin/operations?before=-1", admin.id)).status,
    400,
  );
  const health = await call("/api/health");
  assert.deepEqual(health.data, { ok: true });
  assert.match(health.id!, /^[a-f0-9-]{36}$/);
  assert.notEqual(health.id, report.id);
  s.run("UPDATE ops_checks SET successAt=successAt-121000");
  assert.equal((await call("/api/health")).status, 503);
  app.operations.scan();
  assert.equal((await call("/api/health")).status, 200);
  app.operations.controlFailed = true;
  assert.equal((await call("/api/health")).status, 503);
  app.operations.controlFailed = false;
  assert(app.operations.metrics().api.requests >= 8);
});

test("alert SMTP configuration validates a single recipient and supported language", () => {
  const mail = {
    origin: "https://control.tests.invalid",
    send: async () => {},
  };
  assert.equal(opsMailFromEnv({}, mail), undefined);
  assert.throws(
    () => opsMailFromEnv({ OPS_ALERT_EMAIL: "ops@tests.invalid" }),
    /SMTP/,
  );
  assert.throws(() =>
    opsMailFromEnv(
      { OPS_ALERT_EMAIL: "ops@tests.invalid,other@tests.invalid" },
      mail,
    ),
  );
  assert.throws(() =>
    opsMailFromEnv(
      { OPS_ALERT_EMAIL: "ops@tests.invalid", OPS_ALERT_LOCALE: "fr-FR" },
      mail,
    ),
  );
  for (const locale of locales)
    assert.equal(
      opsMailFromEnv(
        { OPS_ALERT_EMAIL: "ops@tests.invalid", OPS_ALERT_LOCALE: locale },
        mail,
      )?.locale,
      locale,
    );
});
