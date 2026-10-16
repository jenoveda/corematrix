import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../server/app.ts";
import { Infrastructure } from "../server/infrastructure.ts";
import { secret, digest } from "../server/auth.ts";
import { reconcile } from "../server/finance.ts";
import { financeReport } from "../server/finance.ts";
import { providerReport, settleProvider } from "../server/providers.ts";
import { NODE_WORKSPACE_KEY } from "../server/node-credentials.ts";

async function fixture(t: any, nodeScopedKeys = false) {
  process.env.INFERENCE_JUPYTER_KEY = "test-rental-master-key-" + secret();
  const lab = createServer((_, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ started: "2026-01-01" }));
  });
  lab.listen(0, "127.0.0.1");
  await once(lab, "listening");
  const port = (lab.address() as any).port;
  const app = createApplication({
      databasePath: ":memory:",
      allowedOrigins: ["http://127.0.0.1:1"],
      publicOrigin: "http://control.tests.invalid",
    }),
    s = app.store,
    infra = new Infrastructure(s),
    billing = infra.billing;
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const user = s.createUser("Buyer", "buyer@tests.invalid", "unused"),
    other = s.createUser("Other", "other@tests.invalid", "unused"),
    admin = s.createUser("Admin", "admin@tests.invalid", "unused", "admin");
  s.run("UPDATE users SET balance=100000000 WHERE id=?", user.id);
  const credentials = new Map();
  for (const u of [user, other, admin]) {
    const token = secret(),
      csrf = secret();
    s.run(
      "INSERT INTO sessions VALUES(?,?,?,?)",
      digest(token),
      u.id,
      csrf,
      Date.now() + 100000,
    );
    credentials.set(u.id, {
      Cookie: "cm_session=" + token,
      "X-CSRF-Token": csrf,
    });
  }
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    who = user.id,
    key?: string,
    csrf = true,
  ) {
    const headers = {
      ...credentials.get(who),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    };
    if (!csrf) delete headers["X-CSRF-Token"];
    const res = await fetch(
      `http://127.0.0.1:${(app.server.address() as any).port}` + path,
      { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) },
    );
    return { status: res.status, data: (await res.json()) as any };
  }
  const config = {
    name: "Rental A",
    region: "Test",
    inferenceHost: "http://127.0.0.1",
    portStart: port,
    portEnd: port + 2,
    workMode: "gpu-rental",
    rentalSalesEnabled: true,
    hourlyPrice: 3600000,
  };
  const created = await call("/api/admin/servers", "POST", config, admin.id),
    node = created.data.server.id;
  assert.equal(created.status, 201);
  let sequence = 0,
    containers: any[] = [],
    expirySupported = true,
    renewalSupported = true;
  function beat(acks: any[] = [], error: string | null = null) {
    return infra.heartbeat(infra.node(node), {
      instanceId: "go-test",
      bootId: "boot",
      sequence: ++sequence,
      generation: sequence === 1 ? null : 1,
      expiryAcks: acks,
      capabilities: {
        agentVersion: "4-go",
        dockerReady: true,
        workspaceReady: true,
        expirySupported,
        renewalSupported,
        workspaceImageDigest: "sha256:" + "b".repeat(64),
        runtimeImageDigest: "",
        workspaceKeyEnv: "INFERENCE_JUPYTER_KEY",
        nodeScopedKeys,
      },
      inventoryError: error,
      gpus: [0, 1].map((i) => ({
        uuid: "GPU-" + i,
        index: i,
        name: "Test GPU",
        totalMemoryMiB: 24000,
        usedMemoryMiB: 0,
        externalBusy: false,
      })),
      containers,
    });
  }
  beat();
  const offers = () => billing.offers(infra, "control.tests.invalid");
  const body = (cards = 1, hours = 2) => ({
    offerId: offers()[0].id,
    cards,
    hours,
    expectedHourlyPrice: config.hourlyPrice,
  });
  function purchase(cards = 1, hours = 2, key = randomUUID()) {
    return billing.purchase(
      infra,
      user.id,
      key,
      body(cards, hours),
      "control.tests.invalid",
    );
  }
  function claim() {
    return infra.claim(infra.node(node), {
      instanceId: "go-test",
      generation: 1,
    }).job as any;
  }
  function report(j: any, event: string, eventId = randomUUID()) {
    return infra.report(
      infra.node(node),
      s.get<any>("SELECT * FROM deployment_jobs WHERE id=?", j.id)!,
      {
        instanceId: "go-test",
        generation: 1,
        attempt: j.attempt,
        leaseToken: j.leaseToken,
        event,
        eventId,
        message: "",
      },
    );
  }
  async function ready(order: any) {
    const j = claim();
    assert.equal(j.deploymentId, order.deploymentId);
    containers.push({
      deploymentId: order.deploymentId,
      containerId: "container-" + order.id,
      state: "running",
      endpointPort: port,
    });
    beat();
    report(j, "healthy");
    for (
      let i = 0;
      i < 100 && infra.dep(order.deploymentId).phase !== "ready";
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(infra.dep(order.deploymentId).phase, "ready");
    return billing.row(order.deploymentId)!;
  }
  function acknowledge() {
    return beat(billing.deadlines(node));
  }
  function cleanup(order: any) {
    infra.advanceStops();
    const j = claim();
    assert.equal(j.kind, "stop");
    if (containers.some((c) => c.deploymentId === order.deploymentId))
      assert.throws(() => report(j, "stopped"));
    assert.ok(
      s.get(
        "SELECT 1 FROM gpu_allocations WHERE deploymentId=? AND released=0",
        order.deploymentId,
      ),
    );
    containers = containers.filter(
      (c) => c.deploymentId !== order.deploymentId,
    );
    beat();
    const eventId = randomUUID();
    report(j, "stopped", eventId);
    report(j, "stopped", eventId);
    assert.equal(
      s.get(
        "SELECT 1 FROM gpu_allocations WHERE deploymentId=? AND released=0",
        order.deploymentId,
      ),
      undefined,
    );
  }
  t.after(async () => {
    infra.disposed = true;
    for (const srv of [app.server, lab]) {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
    s.close();
    delete process.env.INFERENCE_JUPYTER_KEY;
  });
  return {
    app,
    s,
    infra,
    billing,
    user,
    other,
    admin,
    node,
    config,
    offers,
    body,
    purchase,
    call,
    beat,
    ready,
    acknowledge,
    cleanup,
    claim,
    report,
    setRenewal: (v: boolean) => {
      renewalSupported = v;
    },
    setExpiry: (v: boolean) => {
      expirySupported = v;
    },
  };
}

test("supplier procurement locks GPU-hour price, survives renewal/refund, and settles only confirmed cleanup",async t=>{
  const f=await fixture(t,true),provider=f.s.createUser("Supplier","supplier-rental@tests.invalid","unused","provider");
  f.s.run("UPDATE providers SET status='approved',ratePerGpuHour=1800000 WHERE userId=?",provider.id);
  f.s.run("INSERT INTO provider_nodes(serverId,providerId,approved,reviewedGpuUuids) VALUES(?,?,1,?)",f.node,provider.id,JSON.stringify(["GPU-0","GPU-1"]));
  f.s.run("INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES(?,?,'recharge','Test funds','',100000000,?,?)",randomUUID(),f.user.id,new Date().toISOString(),"2026-10-16");
  const order=f.purchase();
  assert.equal(providerReport(f.s,provider.id).earnings.length,0);
  assert.equal(JSON.parse(f.infra.dep(order.deploymentId).spec).apiKeyEnv,NODE_WORKSPACE_KEY);
  await f.ready(order);f.acknowledge();
  f.s.run("UPDATE provider_usage SET startedAt=? WHERE deploymentId=?",Date.now()-2100,order.deploymentId);
  assert.equal(providerReport(f.s,provider.id).summary.available,0);
  assert(providerReport(f.s,provider.id).summary.pending>=1000);
  f.s.run("UPDATE providers SET ratePerGpuHour=9000000 WHERE userId=?",provider.id);
  f.billing.act(f.infra,f.user.id,order.id,"renew",randomUUID(),{hours:1});f.acknowledge();
  f.s.run("UPDATE rental_orders SET startedAt=? WHERE id=?",Date.now()-2100,order.id);
  f.billing.act(f.infra,f.user.id,order.id,"cancel",randomUUID(),{});
  assert.throws(()=>settleProvider(f.s,provider.id,{amount:1,reference:"not-yet-payable",reason:"No payment"},f.admin.id));
  f.cleanup(order);
  const report=providerReport(f.s,provider.id),entry=report.earnings[0];
  assert.equal(report.earnings.length,1);assert.equal(entry.ratePerGpuHour,1800000);
  const expected=Math.floor((entry.endedAt!-entry.startedAt)/1000)*500;
  assert.equal(report.summary.earned,expected);assert.equal(report.summary.available,expected);assert.equal(report.summary.pending,0);
  const body={amount:expected,reference:"paid-supplier-receipt-1",reason:"Completed offline payment"};
  settleProvider(f.s,provider.id,body,f.admin.id);settleProvider(f.s,provider.id,body,f.admin.id);
  assert.equal(providerReport(f.s,provider.id).summary.paid,expected);assert.equal(providerReport(f.s,provider.id).summary.available,0);
  assert.equal(f.s.all("SELECT * FROM provider_settlements").length,1);
  const financial=financeReport(f.s,new URLSearchParams({from:new Date(Date.now()-86400000).toISOString().slice(0,10),to:new Date(Date.now()+86400000).toISOString().slice(0,10)})),closed=f.billing.row(order.deploymentId)!;
  assert.equal(financial.cost,expected);assert.equal(financial.profit,closed.charged-closed.refunded-expected);
  assert.equal(financial.byCategory.find(row=>row.category==="provider")?.amount,expected);
  assert.equal(reconcile(f.s).healthy,true);
  f.s.run("UPDATE provider_usage SET amount=amount+1 WHERE deploymentId=?",order.deploymentId);
  assert(reconcile(f.s).issues.some(row=>row.code==="provider_procurement_amount"));
  assert(reconcile(f.s).issues.some(row=>row.code==="provider_settlement_amount"));
});

test("paid rental HTTP: private offers, exact quote, atomic holds and idempotent purchase", async (t) => {
  const f = await fixture(t),
    { s, user, billing, call } = f;
  assert.equal((await call("/api/compute/offers")).data.data.length, 1);
  const catalog = JSON.stringify((await call("/api/compute/offers")).data);
  for (const hidden of ["127.0.0.1", "GPU-0", "tokenHash", "workspaceKeyEnv"])
    assert.equal(catalog.includes(hidden), false);
  f.setExpiry(false);
  f.beat();
  assert.equal(f.offers().length, 0);
  f.setExpiry(true);
  f.beat();
  assert.equal(
    (
      await call(
        "/api/compute/orders",
        "POST",
        f.body(),
        user.id,
        "csrf-test-key",
        false,
      )
    ).status,
    403,
  );
  for (const bad of [
    { cards: 0 },
    { cards: 1.5 },
    { hours: 0 },
    { hours: 721 },
  ])
    assert.equal(
      (
        await call(
          "/api/compute/orders",
          "POST",
          { ...f.body(), ...bad },
          user.id,
          randomUUID(),
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await call(
        "/api/compute/orders",
        "POST",
        { ...f.body(), expectedHourlyPrice: 1 },
        user.id,
        randomUUID(),
      )
    ).data.error.code,
    "rental_price_changed",
  );
  const body = { ...f.body(2, 2), ownerEmail: f.other.email, amount: 1 },
    key = randomUUID();
  const results = await Promise.all([
    call("/api/compute/orders", "POST", body, user.id, key),
    call("/api/compute/orders", "POST", body, user.id, key),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [202, 202],
  );
  const order = results[0].data.order;
  assert.equal(results[1].data.order.id, order.id);
  assert.equal(order.amount, 14400000);
  assert.equal(s.held(user.id), 14400000);
  assert.equal(s.user(user.id)!.balance, 100000000);
  assert.equal(s.all("SELECT * FROM ledger").length, 0);
  assert.equal(s.all("SELECT * FROM rental_orders").length, 1);
  assert.equal(
    (
      await call(
        "/api/compute/orders",
        "POST",
        { ...body, hours: 3 },
        user.id,
        key,
      )
    ).status,
    409,
  );
  assert.equal(
    (await call("/api/compute/orders", "POST", body, user.id, randomUUID()))
      .status,
    409,
  );
  assert.equal(
    (await call("/api/compute/orders", "GET", undefined, f.other.id)).data.data
      .length,
    0,
  );
  assert.equal(
    (await call("/api/state", "GET", undefined, user.id)).data.heldBalance,
    14400000,
  );
  assert.equal(billing.row(order.deploymentId)!.userId, user.id);
  // Replays succeed even after the pool has disappeared or been repriced.
  assert.equal(
    (
      await call(
        "/api/admin/servers/" + f.node,
        "PUT",
        { ...f.config, hourlyPrice: 7200000 },
        f.admin.id,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/api/compute/orders", "POST", body, user.id, key)).data.order
      .id,
    order.id,
  );
});

test("only fresh health and a persisted expiry acknowledgement charge the frozen quote once", async (t) => {
  const f = await fixture(t),
    o = f.purchase(),
    { s, billing, user } = f;
  await f.ready(o);
  assert.equal(billing.row(o.deploymentId)!.charged, 0);
  assert.equal(billing.canAccess(o.deploymentId), false);
  assert.equal(
    (await f.call(`/api/compute/rentals/${o.deploymentId}/access`, "POST"))
      .status,
    503,
  );
  assert.equal(
    (
      await f.call(
        "/api/admin/servers/" + f.node,
        "PUT",
        { ...f.config, hourlyPrice: 9999999 },
        f.admin.id,
      )
    ).status,
    200,
  );
  f.beat([
    {
      deploymentId: o.deploymentId,
      expiresAt: new Date(Date.now() + 100000).toISOString(),
    },
  ]);
  assert.equal(s.user(user.id)!.balance, 100000000);
  f.beat(billing.deadlines(f.node), "inventory failed");
  assert.equal(s.user(user.id)!.balance, 100000000);
  f.acknowledge();
  f.acknowledge();
  assert.equal(billing.row(o.deploymentId)!.status, "active");
  assert.equal(s.user(user.id)!.balance, 92800000);
  assert.equal(s.held(user.id), 0);
  assert.equal(s.all("SELECT * FROM ledger WHERE type='compute'").length, 1);
  assert.equal(
    (await f.call(`/api/compute/rentals/${o.deploymentId}/access`, "POST"))
      .status,
    200,
  );
  assert.equal(
    (
      await f.call(
        `/api/compute/rentals/${o.deploymentId}/access`,
        "POST",
        undefined,
        f.other.id,
      )
    ).status,
    403,
  );
  const past = Date.now() - 1000;
  s.run(
    "UPDATE rental_orders SET startedAt=?,expiresAt=? WHERE id=?",
    past - 7200000,
    past,
    o.id,
  );
  assert.equal(
    (await f.call(`/api/compute/rentals/${o.deploymentId}/access`, "POST"))
      .status,
    503,
  );
  s.run(
    "UPDATE servers SET lastHeartbeat=? WHERE id=?",
    Date.now() - 100000,
    f.node,
  );
  await f.infra.tick();
  assert.equal(f.infra.dep(o.deploymentId).desiredState, "stopped");
  assert.equal(f.infra.server(f.infra.node(f.node)).allocatedGpuCount, 1);
  f.beat();
  const failedStop = f.claim();
  f.report(failedStop, "failed");
  assert.equal(f.infra.dep(o.deploymentId).phase, "failed");
  s.run(
    "UPDATE deployment_jobs SET createdAt=? WHERE id=?",
    Date.now() - 61000,
    failedStop.id,
  );
  await f.infra.tick();
  f.cleanup(o);
  assert.equal(billing.row(o.deploymentId)!.status, "completed");
  assert.equal(billing.row(o.deploymentId)!.refunded, 0);
  assert.equal(s.user(user.id)!.balance, 92800000);
});

test("early stop refunds unused seconds only after confirmed removal and never twice", async (t) => {
  const f = await fixture(t),
    o = f.purchase(2, 2),
    { s, billing, user } = f;
  await f.ready(o);
  f.acknowledge();
  s.run(
    "UPDATE rental_orders SET startedAt=?,expiresAt=? WHERE id=?",
    Date.now() - 1501,
    Date.now() + 7198499,
    o.id,
  );
  f.infra.stop(o.deploymentId);
  const stopped = billing.row(o.deploymentId)!;
  const seconds = Math.ceil(
      (stopped.stopRequestedAt! - stopped.startedAt!) / 1000,
    ),
    expected =
      stopped.charged -
      Math.ceil((stopped.hourlyPrice * stopped.cards * seconds) / 3600);
  assert.equal(s.user(user.id)!.balance, 85600000);
  assert.equal(stopped.refunded, 0);
  // A credit cannot consume the safe integer space needed for an outstanding refund.
  s.run(
    "UPDATE users SET balance=? WHERE id=?",
    Number.MAX_SAFE_INTEGER - o.amount,
    user.id,
  );
  assert.equal(
    (
      await f.call(
        "/api/admin/credits",
        "POST",
        {
          email: user.email,
          amount: 1,
          reason: "boundary test",
          reference: randomUUID(),
        },
        f.admin.id,
      )
    ).status,
    400,
  );
  s.run("UPDATE users SET balance=85600000 WHERE id=?", user.id);
  s.run("UPDATE ledger SET day='2026-10-14' WHERE type='compute'");
  f.cleanup(o);
  assert.ok(
    s
      .snapshot(s.user(f.admin.id))
      .summary!.daily.some((d) => d.revenue === -expected),
  );
  assert.equal(billing.row(o.deploymentId)!.refunded, expected);
  assert.equal(s.user(user.id)!.balance, 85600000 + expected);
  assert.equal(
    s.all("SELECT * FROM ledger WHERE type='compute_refund'").length,
    1,
  );
  f.infra.stop(o.deploymentId);
  assert.equal(s.user(user.id)!.balance, 85600000 + expected);
  const state = s.snapshot(s.user(user.id));
  assert.equal(
    s.snapshot(s.user(f.admin.id)).summary!.revenue,
    o.amount - expected,
  );
  assert.ok(
    state.bills.some(
      (b) => b.type === "compute_refund" && b.amount === -expected,
    ),
  );
});

test("failed provisioning and startup timeout release holds, but retain physical allocations until cleanup", async (t) => {
  const f = await fixture(t),
    o = f.purchase(),
    j = f.claim();
  f.report(j, "failed");
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  f.cleanup(o);
  const next = f.purchase();
  f.s.run(
    "UPDATE rental_orders SET createdAt=? WHERE id=?",
    Date.now() - 21 * 60000,
    next.id,
  );
  await f.infra.tick();
  assert.equal(f.billing.row(next.deploymentId)!.status, "failed");
  assert.equal(f.s.held(f.user.id), 0);
  f.cleanup(next);
  assert.equal(f.s.all("SELECT * FROM ledger").length, 0);
});

test("Token and GPU purchases share the same available balance; competing GPU orders cannot oversell", async (t) => {
  const f = await fixture(t),
    { s, user } = f;
  s.run("UPDATE users SET balance=10000000 WHERE id=?", user.id);
  s.run(
    "INSERT INTO requests(id,userId,requestKey,fingerprint,day,status,reserved,modelId,modelName,inputPrice,outputPrice,createdAt) VALUES('pending',?,'token-hold','hash','2026-10-15','pending',4000000,'qwen2.5-7b','Model',1,1,'now')",
    user.id,
  );
  assert.throws(() => f.purchase(), /Insufficient balance/);
  assert.equal(s.all("SELECT * FROM deployments").length, 0);
  s.run("UPDATE requests SET status='failed',reserved=0 WHERE id='pending'");
  const body = f.body(2, 1);
  const rs = await Promise.all([
    f.call("/api/compute/orders", "POST", body, user.id, randomUUID()),
    f.call("/api/compute/orders", "POST", body, user.id, randomUUID()),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [202, 409]);
  assert.equal(s.held(user.id), 7200000);
  assert.equal(s.all("SELECT * FROM port_allocations").length, 1);
  const model = {
    ...s.model("qwen2.5-7b")!,
    enabled: true,
    upstreamUrl: "http://127.0.0.1:1/v1/chat/completions",
    inputPrice: 10000000,
    contextTokens: 1000000,
  };
  s.run("UPDATE models SET data=? WHERE id=?", JSON.stringify(model), model.id);
  const chat = await f.call(
    "/v1/chat/completions",
    "POST",
    {
      model: model.id,
      max_tokens: 1,
      messages: [{ role: "user", content: "hello" }],
    },
    user.id,
    randomUUID(),
  );
  assert.equal(chat.status, 402, JSON.stringify(chat.data));
  assert.equal(chat.data.error.code, "insufficient_balance");
  assert.equal(
    s.all("SELECT * FROM requests WHERE status='pending'").length,
    0,
  );
});

test("control-plane restart preserves GPU holds and immediately schedules expired paid orders", async (t) => {
  const f = await fixture(t),
    o = f.purchase();
  await f.ready(o);
  f.acknowledge();
  const pending = f.purchase();
  const past = Date.now() - 1000;
  f.s.run(
    "UPDATE rental_orders SET startedAt=?,expiresAt=? WHERE id=?",
    past - 7200000,
    past,
    o.id,
  );
  f.s.run(
    "UPDATE servers SET lastHeartbeat=? WHERE id=?",
    past - 100000,
    f.node,
  );
  const dir = mkdtempSync(join(tmpdir(), "corematrix-paid-restart-")),
    path = join(dir, "db.sqlite");
  f.s.run("VACUUM INTO ?", path);
  const app = createApplication({
    databasePath: path,
    publicOrigin: "http://control.tests.invalid",
  });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise<void>((r) => app.server.close(() => r()));
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const infra = new Infrastructure(app.store);
  assert.equal(infra.dep(o.deploymentId).desiredState, "stopped");
  assert.equal(infra.billing.row(o.deploymentId)!.charged, o.amount);
  assert.equal(
    infra.billing.row(pending.deploymentId)!.reserved,
    pending.amount,
  );
  assert.equal(app.store.held(f.user.id), pending.amount);
  assert.equal(infra.server(infra.node(f.node)).allocatedGpuCount, 2);
  assert.equal(
    app.store.all("SELECT * FROM ledger WHERE type='compute'").length,
    1,
  );
});

test("HTTP renewal charges the original price once, extends the existing order, and waits for its exact revision", async (t) => {
  const f = await fixture(t),
    o = f.purchase();
  await f.ready(o);
  f.acknowledge();
  const original = f.billing.row(o.deploymentId)!,
    path = `/api/compute/orders/${o.id}/renew`,
    key = randomUUID(),
    body = { hours: 3 };
  assert.equal((await f.call(path, "POST", body, f.other.id, key)).status, 403);
  assert.equal(
    (await f.call(path, "POST", body, f.user.id, key, false)).status,
    403,
  );
  for (const hours of [0, 1.5, 721])
    assert.equal(
      (await f.call(path, "POST", { hours }, f.user.id, randomUUID())).status,
      400,
    );
  f.setRenewal(false);
  f.beat();
  assert.equal(
    (await f.call(path, "POST", body, f.user.id, key)).data.error.code,
    "renewal_node_unavailable",
  );
  f.setRenewal(true);
  f.beat();
  f.s.run("UPDATE users SET balance=1 WHERE id=?", f.user.id);
  assert.equal((await f.call(path, "POST", body, f.user.id, key)).status, 402);
  f.s.run("UPDATE users SET balance=92800000 WHERE id=?", f.user.id);
  await f.call(
    "/api/admin/servers/" + f.node,
    "PUT",
    { ...f.config, hourlyPrice: 9999999 },
    f.admin.id,
  );
  const rs = await Promise.all([
    f.call(path, "POST", body, f.user.id, key),
    f.call(path, "POST", body, f.user.id, key),
  ]);
  assert.deepEqual(
    rs.map((r) => r.status),
    [202, 202],
  );
  assert.equal(rs[0].data.action.id, rs[1].data.action.id);
  const renewed = f.billing.row(o.deploymentId)!;
  assert.equal(renewed.hours, 5);
  assert.equal(renewed.expiresAt, original.expiresAt! + 3 * 3600000);
  assert.equal(renewed.hourlyPrice, original.hourlyPrice);
  assert.equal(renewed.confirmedExpiresAt, original.expiresAt);
  assert.equal(renewed.expiryRevision, 1);
  assert.equal(f.s.user(f.user.id)!.balance, 82000000);
  assert.equal(f.s.all("SELECT * FROM ledger WHERE type='compute'").length, 2);
  assert.equal(f.s.all("SELECT * FROM gpu_allocations").length, 1);
  assert.equal(f.billing.canAccess(o.deploymentId), true);
  assert.equal(
    (await f.call(path, "POST", { hours: 4 }, f.user.id, key)).status,
    409,
  );
  assert.equal(
    (await f.call(path, "POST", body, f.user.id, randomUUID())).data.error.code,
    "renewal_pending",
  );
  f.beat([
    {
      deploymentId: o.deploymentId,
      expiresAt: new Date(renewed.expiresAt!).toISOString(),
      revision: 0,
    },
  ]);
  assert.equal(
    f.billing.row(o.deploymentId)!.confirmedExpiresAt,
    original.expiresAt,
  );
  f.acknowledge();
  assert.equal(
    f.billing.row(o.deploymentId)!.confirmedExpiresAt,
    renewed.expiresAt,
  );
  assert.equal(
    (await f.call(path, "POST", body, f.user.id, key)).data.action.status,
    "succeeded",
  );
  assert.equal(f.billing.orders(f.user.id)[0].renewalPending, false);
  const third = await f.call(
    path,
    "POST",
    { hours: 1 },
    f.user.id,
    randomUUID(),
  );
  assert.equal(third.status, 202);
  assert.equal(third.data.order.hours, 6);
  f.acknowledge();
  assert.equal(f.s.all("SELECT * FROM ledger WHERE type='compute'").length, 3);
});

test("user early termination after renewal refunds all unused time only after physical cleanup", async (t) => {
  const f = await fixture(t),
    o = f.purchase(2, 2);
  await f.ready(o);
  f.acknowledge();
  assert.equal(
    (
      await f.call(
        `/api/compute/orders/${o.id}/renew`,
        "POST",
        { hours: 2 },
        f.user.id,
        randomUUID(),
      )
    ).status,
    202,
  );
  f.acknowledge();
  const start = Date.now() - 3600001,
    end = start + 4 * 3600000;
  f.s.run(
    "UPDATE rental_orders SET startedAt=?,expiresAt=?,confirmedExpiresAt=? WHERE id=?",
    start,
    end,
    end,
    o.id,
  );
  const path = `/api/compute/orders/${o.id}/cancel`,
    key = randomUUID();
  assert.equal((await f.call(path, "POST", {}, f.other.id, key)).status, 403);
  assert.equal(
    (await f.call(path, "POST", {}, f.user.id, key, false)).status,
    403,
  );
  const rs = await Promise.all([
    f.call(path, "POST", {}, f.user.id, key),
    f.call(path, "POST", {}, f.user.id, key),
  ]);
  assert.deepEqual(
    rs.map((r) => r.status),
    [202, 202],
  );
  assert.equal(rs[0].data.action.id, rs[1].data.action.id);
  const row = f.billing.row(o.deploymentId)!,
    seconds = Math.ceil((row.stopRequestedAt! - start) / 1000),
    refund =
      row.charged - Math.ceil((row.hourlyPrice * row.cards * seconds) / 3600);
  assert.equal(row.charged, 28800000);
  assert.equal(row.refunded, 0);
  assert.equal(f.s.user(f.user.id)!.balance, 71200000);
  assert.equal(f.billing.canAccess(o.deploymentId), false);
  f.cleanup(o);
  assert.equal(f.s.user(f.user.id)!.balance, 71200000 + refund);
  assert.equal(f.billing.row(o.deploymentId)!.refunded, refund);
  assert.equal(
    (await f.call(path, "POST", {}, f.user.id, key)).data.order.status,
    "completed",
  );
  assert.equal(
    (await f.call(path, "POST", {}, f.user.id, randomUUID())).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        `/api/compute/orders/${o.id}/renew`,
        "POST",
        { hours: 1 },
        f.user.id,
        randomUUID(),
      )
    ).status,
    409,
  );
  assert.equal(
    f.s.all("SELECT * FROM ledger WHERE type='compute_refund'").length,
    1,
  );
});

test("unconfirmed renewal expires at its original cutoff and late acknowledgements cannot revive it", async (t) => {
  const f = await fixture(t),
    o = f.purchase();
  await f.ready(o);
  f.acknowledge();
  const path = `/api/compute/orders/${o.id}/renew`,
    key = randomUUID();
  await f.call(path, "POST", { hours: 3 }, f.user.id, key);
  const cutoff = Date.now() - 1000;
  f.s.run(
    "UPDATE rental_orders SET startedAt=?,confirmedExpiresAt=?,expiresAt=? WHERE id=?",
    cutoff - 7200000,
    cutoff,
    cutoff + 3 * 3600000,
    o.id,
  );
  assert.equal(f.billing.canAccess(o.deploymentId), false);
  f.infra.tick();
  assert.equal(f.billing.row(o.deploymentId)!.stopRequestedAt, cutoff);
  assert.equal(
    (await f.call(path, "POST", { hours: 3 }, f.user.id, key)).data.action
      .status,
    "failed",
  );
  f.acknowledge();
  assert.equal(f.infra.dep(o.deploymentId).desiredState, "stopped");
  f.cleanup(o);
  assert.equal(f.billing.row(o.deploymentId)!.refunded, 10800000);
  assert.equal(f.s.user(f.user.id)!.balance, 92800000);
  assert.equal(f.s.all("SELECT * FROM rental_actions").length, 1);
});

test("users can cancel provisioning without a charge, but cannot renew near expiry or exceed the duration limit", async (t) => {
  const f = await fixture(t),
    o = f.purchase(),
    path = `/api/compute/orders/${o.id}`;
  assert.equal(
    (
      await f.call(
        path + "/renew",
        "POST",
        { hours: 1 },
        f.user.id,
        randomUUID(),
      )
    ).status,
    409,
  );
  const cancel = await f.call(
    path + "/cancel",
    "POST",
    {},
    f.user.id,
    randomUUID(),
  );
  assert.equal(cancel.status, 202);
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  f.cleanup(o);
  const next = f.purchase();
  await f.ready(next);
  f.acknowledge();
  const current = f.billing.row(next.deploymentId)!;
  f.s.run(
    "UPDATE rental_orders SET expiresAt=?,confirmedExpiresAt=? WHERE id=?",
    Date.now() + 720 * 3600000,
    Date.now() + 720 * 3600000,
    next.id,
  );
  assert.equal(
    (
      await f.call(
        `/api/compute/orders/${next.id}/renew`,
        "POST",
        { hours: 1 },
        f.user.id,
        randomUUID(),
      )
    ).data.error.code,
    "renewal_limit",
  );
  f.s.run(
    "UPDATE rental_orders SET hours=2,expiresAt=?,confirmedExpiresAt=? WHERE id=?",
    Date.now() + 20000,
    Date.now() + 20000,
    next.id,
  );
  assert.equal(
    (
      await f.call(
        `/api/compute/orders/${next.id}/renew`,
        "POST",
        { hours: 1 },
        f.user.id,
        randomUUID(),
      )
    ).data.error.code,
    "renewal_too_late",
  );
  assert.equal(f.s.user(f.user.id)!.balance, 100000000 - current.amount);
});

test("pending renewal and idempotency survive restart, while v4 paid orders migrate without recharging", async (t) => {
  const f = await fixture(t),
    o = f.purchase();
  await f.ready(o);
  f.acknowledge();
  const key = randomUUID(),
    path = `/api/compute/orders/${o.id}/renew`;
  await f.call(path, "POST", { hours: 3 }, f.user.id, key);
  const dir = mkdtempSync(join(tmpdir(), "corematrix-renew-restart-")),
    dbPath = join(dir, "db.sqlite");
  f.s.run("VACUUM INTO ?", dbPath);
  const app = createApplication({
      databasePath: dbPath,
      publicOrigin: "http://control.tests.invalid",
    }),
    infra = new Infrastructure(app.store);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    infra.disposed = true;
    app.server.closeAllConnections();
    await new Promise<void>((r) => app.server.close(() => r()));
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const replay = infra.billing.act(infra, f.user.id, o.id, "renew", key, {
    hours: 3,
  });
  assert.equal(replay.order.renewalPending, true);
  assert.equal(app.store.user(f.user.id)!.balance, 82000000);
  assert.equal(
    app.store.all("SELECT * FROM ledger WHERE type='compute'").length,
    2,
  );
  infra.heartbeat(infra.node(f.node), {
    instanceId: "go-test",
    bootId: "boot",
    sequence: infra.node(f.node).sequence + 1,
    generation: 1,
    expiryAcks: infra.billing.deadlines(f.node),
    capabilities: JSON.parse(infra.node(f.node).capabilities),
    inventoryError: null,
    gpus: f.infra.server(f.infra.node(f.node)).gpus,
    containers: JSON.parse(infra.node(f.node).containers),
  });
  assert.equal(
    infra.billing.row(o.deploymentId)!.confirmedExpiresAt,
    infra.billing.row(o.deploymentId)!.expiresAt,
  );
  // Reconstruct a v4 order independently of renewal records to exercise the incremental upgrade.
  f.s.db.exec("DROP TABLE rental_actions");
  f.s.db.exec(
    "ALTER TABLE rental_orders DROP COLUMN confirmedExpiresAt;ALTER TABLE rental_orders DROP COLUMN expiryRevision;DELETE FROM schema_migrations WHERE version=5;",
  );
  const oldPath = join(dir, "v4.sqlite");
  f.s.run("VACUUM INTO ?", oldPath);
  const upgraded = createApplication({ databasePath: oldPath });
  const upgradedInfra = new Infrastructure(upgraded.store);
  assert.equal(
    upgradedInfra.billing.row(o.deploymentId)!.confirmedExpiresAt,
    upgradedInfra.billing.row(o.deploymentId)!.expiresAt,
  );
  assert.equal(upgraded.store.user(f.user.id)!.balance, 82000000);
  assert.equal(
    upgraded.store.all("SELECT * FROM ledger WHERE type='compute'").length,
    2,
  );
  upgraded.store.close();
});

test("competing renew and cancel requests cannot resurrect a stopped order or lose its refund", async (t) => {
  const f = await fixture(t),
    o = f.purchase();
  await f.ready(o);
  f.acknowledge();
  const path = `/api/compute/orders/${o.id}`;
  const rs = await Promise.all([
    f.call(path + "/renew", "POST", { hours: 1 }, f.user.id, randomUUID()),
    f.call(path + "/cancel", "POST", {}, f.user.id, randomUUID()),
  ]);
  assert.equal(rs[1].status, 202);
  assert.ok([202, 409].includes(rs[0].status));
  assert.equal(f.infra.dep(o.deploymentId).desiredState, "stopped");
  assert.equal(f.billing.canAccess(o.deploymentId), false);
  f.acknowledge();
  assert.equal(f.infra.dep(o.deploymentId).desiredState, "stopped");
  f.cleanup(o);
  const row = f.billing.row(o.deploymentId)!;
  assert.equal(
    f.s.user(f.user.id)!.balance,
    100000000 - row.charged + row.refunded,
  );
  assert.equal(
    f.s.all("SELECT * FROM ledger WHERE type='compute_refund'").length,
    1,
  );
  assert.equal(
    f.s.all("SELECT * FROM rental_actions WHERE status='pending'").length,
    0,
  );
});

test("renewals can continue past 720 cumulative hours while keeping the future term within 720 hours", async (t) => {
  const f = await fixture(t);
  f.s.run("UPDATE users SET balance=3000000000 WHERE id=?", f.user.id);
  const o = f.purchase(1, 720);
  await f.ready(o);
  f.acknowledge();
  const start = Date.now() - 2 * 3600000,
    end = start + 720 * 3600000;
  f.s.run(
    "UPDATE rental_orders SET startedAt=?,expiresAt=?,confirmedExpiresAt=? WHERE id=?",
    start,
    end,
    end,
    o.id,
  );
  const r = await f.call(
    `/api/compute/orders/${o.id}/renew`,
    "POST",
    { hours: 1 },
    f.user.id,
    randomUUID(),
  );
  assert.equal(r.status, 202);
  assert.equal(r.data.order.hours, 721);
  assert.equal(Date.parse(r.data.order.expiresAt), end + 3600000);
  f.acknowledge();
  assert.equal(
    f.billing.row(o.deploymentId)!.confirmedExpiresAt,
    end + 3600000,
  );
  assert.equal(f.s.user(f.user.id)!.balance, 3000000000 - 721 * 3600000);
});

test("payment reversals protect GPU provisioning holds and block new purchases or renewals while allowing return", async (t) => {
  const f = await fixture(t),
    order = f.purchase(1, 2),
    hold = f.s.held(f.user.id);
  f.s.transaction(() =>
    f.s.run(
      "UPDATE users SET paymentDebt=paymentDebt+100000000 WHERE id=?",
      f.user.id,
    ),
  );
  assert.equal(f.s.user(f.user.id)!.balance, hold);
  assert.equal(f.s.user(f.user.id)!.paymentDebt, hold);
  await f.ready(order);
  f.acknowledge();
  assert.equal(f.billing.row(order.deploymentId)!.status, "active");
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  assert.equal(f.s.user(f.user.id)!.paymentDebt, order.amount);
  assert.equal(
    (
      await f.call(
        "/api/compute/orders",
        "POST",
        f.body(1, 1),
        f.user.id,
        "blocked-buy-0001",
      )
    ).status,
    402,
  );
  assert.equal(
    (
      await f.call(
        "/api/compute/orders/" + order.id + "/renew",
        "POST",
        { hours: 1 },
        f.user.id,
        "blocked-renew-0001",
      )
    ).status,
    402,
  );
  assert.equal(
    (
      await f.call(
        "/api/compute/orders/" + order.id + "/cancel",
        "POST",
        {},
        f.user.id,
        "allowed-return-0001",
      )
    ).status,
    202,
  );
  f.cleanup(order);
  assert.equal(f.billing.row(order.deploymentId)!.status, "completed");
  assert.equal(f.s.held(f.user.id), 0);
});

function reservationClock(t: any, f: any) {
  let now = Date.now();
  f.s.run("UPDATE sessions SET expires=?", now + 90 * 86400000);
  t.mock.method(Date, "now", () => now);
  return {
    get now() {
      return now;
    },
    go(value: number, fresh = true) {
      now = value;
      if (fresh) f.beat();
    },
  };
}
async function reservationFixture(t: any) {
  const f = await fixture(t);
  f.s.run(
    "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES('reservation-funds',?,'recharge','Test funds','',100000000,'now','2026-10-16')",
    f.user.id,
  );
  return f;
}
function reserveBody(f: any, start: number, cards = 1, hours = 1) {
  return { ...f.body(cards, hours), startsAt: new Date(start).toISOString() };
}
const book = async (f: any, body: any, key = randomUUID()) =>
  f.call("/api/compute/reservations", "POST", body, f.user.id, key);

async function duplicateNode(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.call(
    "/api/admin/servers",
    "POST",
    {
      ...f.config,
      name: "Duplicate physical node",
    },
    f.admin.id,
  );
  assert.equal(created.status, 201);
  const id = created.data.server.id;
  f.infra.heartbeat(f.infra.node(id), {
    instanceId: "duplicate",
    bootId: "boot",
    sequence: 1,
    generation: null,
    capabilities: JSON.parse(f.infra.node(f.node).capabilities),
    inventoryError: null,
    containers: [],
    gpus: f.infra.server(f.infra.node(f.node)).gpus,
  });
  return id as string;
}

test("duplicate physical GPU inventories block both nodes without charging, and idle decommissioning resolves the conflict", async (t) => {
  const f = await reservationFixture(t),
    body = f.body(2),
    alias = await duplicateNode(f);
  for (const id of [f.node, alias]) {
    const node = f.infra.server(f.infra.node(id));
    assert.equal(node.freeGpuCount, 0);
    assert.equal(node.inventoryError, "duplicate_gpu_identity");
  }
  assert.deepEqual(f.offers(), []);
  const before = {
    balance: f.s.user(f.user.id)!.balance,
    ledger: f.s.all("SELECT * FROM ledger"),
  };
  assert.throws(() =>
    f.billing.purchase(
      f.infra,
      f.user.id,
      randomUUID(),
      body,
      "control.tests.invalid",
    ),
  );
  assert.throws(() =>
    f.infra.create(
      {
        serverId: alias,
        workloadType: "gpu-rental",
        ownerEmail: f.user.email,
        gpuUuids: ["GPU-0"],
      },
      f.admin.id,
      randomUUID(),
    ),
  );
  assert.equal(f.s.all("SELECT * FROM gpu_allocations").length, 0);
  assert.deepEqual(
    {
      balance: f.s.user(f.user.id)!.balance,
      ledger: f.s.all("SELECT * FROM ledger"),
    },
    before,
  );
  assert.equal(
    (
      await f.call(
        "/api/admin/servers/" + alias,
        "DELETE",
        undefined,
        f.admin.id,
      )
    ).status,
    200,
  );
  assert.equal(f.infra.server(f.infra.node(f.node)).freeGpuCount, 2);
  assert.equal(f.offers()[0].availableCards, 2);
});

test("duplicate identity fences queued starts but leaves confirmed stop and refund recovery available", async (t) => {
  const f = await reservationFixture(t),
    order = f.purchase(1),
    alias = await duplicateNode(f);
  const snapshot = f.s.all("SELECT * FROM deployment_jobs");
  assert.equal(f.claim(), null);
  assert.deepEqual(f.s.all("SELECT * FROM deployment_jobs"), snapshot);
  f.infra.stop(order.deploymentId);
  f.cleanup(order);
  assert.equal(f.billing.row(order.deploymentId)!.reserved, 0);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  // A missing inventory never frees a physical claim on a different registration.
  f.s.run("UPDATE servers SET deleted=1 WHERE id=?", alias);
  const next = f.purchase(1);
  const other = await duplicateNode(f);
  f.s.run("UPDATE gpus SET missing=1 WHERE serverId=?", f.node);
  assert.equal(f.infra.server(f.infra.node(other)).freeGpuCount, 0);
  assert.ok(
    f.s.get(
      "SELECT 1 FROM gpu_allocations WHERE deploymentId=? AND released=0",
      next.deploymentId,
    ),
  );
});

test("physical GPU calendars survive node re-registration and audit cross-node overlaps without repairs", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    start = clock.now + 3600000;
  const reserved = (await book(f, reserveBody(f, start, 2, 2))).data
    .reservation;
  const alias = await duplicateNode(f);
  f.s.run("UPDATE gpus SET missing=1 WHERE serverId=?", f.node);
  const node = f.infra.server(f.infra.node(alias));
  assert.equal(node.inventoryError, null);
  assert.equal(
    f.billing.reservations.availableGpus(node, { start, end: start + 3600000 })
      .length,
    0,
  );
  assert.equal(
    f.billing.reservations.availablePort(node, { start, end: start + 3600000 }),
    node.portStart,
  );
  assert.throws(
    () => f.billing.reservations.guard(alias, ["GPU-0"], null, start + 3600000),
    /Resources promised/,
  );
  assert.equal(f.offers().length, 0);
  // Simulate conflicting legacy records; reconciliation must report rather than rewrite them.
  f.s.run(
    "INSERT INTO rental_reservations(id,userId,serverId,serverName,offerId,resource,memoryMiB,cards,hours,hourlyPrice,amount,reserved,status,gpuUuids,port,startsAt,endsAt,createdAt,requestKey,fingerprint) SELECT 'legacy-duplicate',userId,?,serverName,offerId,resource,memoryMiB,cards,hours,hourlyPrice,amount,reserved,status,gpuUuids,port,startsAt,endsAt,createdAt,'legacy-duplicate',fingerprint FROM rental_reservations WHERE id=?",
    alias,
    reserved.id,
  );
  const before = f.s.all("SELECT * FROM rental_reservations");
  assert.ok(
    reconcile(f.s).issues.some((i) => i.code === "reservation_overlap"),
  );
  assert.deepEqual(f.s.all("SELECT * FROM rental_reservations"), before);
});

test("a duplicate registration blocks renewal without debit, while paid return refunds once after cleanup", async (t) => {
  const f = await reservationFixture(t),
    order = f.purchase();
  await f.ready(order);
  f.acknowledge();
  await duplicateNode(f);
  const before = {
    balance: f.s.user(f.user.id)!.balance,
    ledger: f.s.all("SELECT * FROM ledger"),
    order: f.billing.row(order.deploymentId),
  };
  const renewal = await f.call(
    `/api/compute/orders/${order.id}/renew`,
    "POST",
    { hours: 1 },
    f.user.id,
    randomUUID(),
  );
  assert.equal(renewal.status, 409);
  assert.equal(renewal.data.error.code, "renewal_node_unavailable");
  assert.deepEqual(
    {
      balance: f.s.user(f.user.id)!.balance,
      ledger: f.s.all("SELECT * FROM ledger"),
      order: f.billing.row(order.deploymentId),
    },
    before,
  );
  assert.equal(
    (
      await f.call(
        `/api/compute/orders/${order.id}/cancel`,
        "POST",
        {},
        f.user.id,
        randomUUID(),
      )
    ).status,
    202,
  );
  assert.equal(f.billing.row(order.deploymentId)!.refunded, 0);
  f.cleanup(order);
  const returned = f.billing.row(order.deploymentId)!;
  assert.ok(returned.refunded > 0);
  assert.equal(
    f.s.user(f.user.id)!.balance,
    before.balance + returned.refunded,
  );
  assert.equal(reconcile(f.s).healthy, true);
});

test("duplicate registration after booking prevents dispatch and releases only the expired financial hold", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    start = clock.now + 3600000;
  const reservation = (await book(f, reserveBody(f, start))).data.reservation;
  await duplicateNode(f);
  clock.go(start);
  f.billing.reservations.tick(f.infra);
  assert.equal(f.billing.reservations.row(reservation.id)!.status, "booked");
  assert.equal(f.s.all("SELECT * FROM deployments").length, 0);
  clock.go(start + 20 * 60000);
  f.billing.reservations.tick(f.infra);
  assert.equal(f.billing.reservations.row(reservation.id)!.status, "failed");
  assert.equal(f.billing.reservations.row(reservation.id)!.reserved, 0);
  assert.equal(f.s.all("SELECT * FROM gpu_allocations").length, 0);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  assert.equal(reconcile(f.s).healthy, true);
});

test("reservation HTTP validates ownership, CSRF and UTC windows and freezes one immutable quote without allocating hardware early", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    body = reserveBody(f, clock.now + 3600000, 2, 2),
    key = randomUUID();
  assert.equal(
    (
      await f.call(
        "/api/compute/reservations",
        "POST",
        body,
        f.user.id,
        key,
        false,
      )
    ).status,
    403,
  );
  for (const patch of [
    { startsAt: new Date(clock.now + 60000).toISOString() },
    { startsAt: new Date(clock.now + 31 * 86400000).toISOString() },
    { startsAt: "2026-02-31T00:00:00.000Z" },
    { cards: 0 },
    { hours: 721 },
  ])
    assert.equal((await book(f, { ...body, ...patch })).status, 400);
  const result = await book(
    f,
    { ...body, userId: f.other.id, reserved: 0 },
    key,
  );
  assert.equal(result.status, 202);
  const r = result.data.reservation;
  assert.equal(r.amount, 14400000);
  assert.equal(f.s.held(f.user.id), r.amount);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  assert.equal(f.s.all("SELECT * FROM deployments").length, 0);
  assert.equal(f.s.all("SELECT * FROM gpu_allocations").length, 0);
  assert.equal(f.s.all("SELECT * FROM ledger WHERE type='compute'").length, 0);
  assert.equal(r.serverId, undefined);
  assert.equal(r.gpuUuids, undefined);
  assert.equal(r.port, undefined);
  assert.deepEqual((await book(f, body, key)).data.reservation, r);
  assert.equal((await book(f, { ...body, hours: 3 }, key)).status, 409);
  assert.equal(
    (await f.call("/api/compute/reservations", "GET", undefined, f.other.id))
      .data.data.length,
    0,
  );
  assert.equal((await f.call("/api/admin/compute/reservations")).status, 403);
  const admin = (
    await f.call(
      "/api/admin/compute/reservations",
      "GET",
      undefined,
      f.admin.id,
    )
  ).data.data[0];
  assert.equal(admin.gpuUuids.length, 2);
  assert.equal(admin.email, f.user.email);
  assert.equal(
    (
      await f.call(
        "/api/compute/reservations/" + r.id + "/cancel",
        "POST",
        {},
        f.other.id,
      )
    ).status,
    404,
  );
  assert.equal((await f.call("/api/state")).data.reservations[0].id, r.id);
  assert.equal((await f.call("/api/state")).data.heldBalance, r.amount);
});

test("overlapping GPU and port commitments serialize atomically, while non-overlapping windows reuse the same resources after the cleanup gap", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    start = clock.now + 3600000,
    body = reserveBody(f, start, 2, 1);
  const results = await Promise.all([book(f, body), book(f, body)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
  assert.equal(f.s.all("SELECT * FROM rental_reservations").length, 1);
  const first = f.s.get<any>("SELECT * FROM rental_reservations")!;
  assert.equal(
    (
      await book(f, {
        ...body,
        startsAt: new Date(start + 3600000 + 5 * 60000 - 1).toISOString(),
      })
    ).status,
    409,
  );
  const second = (
      await book(f, {
        ...body,
        startsAt: new Date(start + 3600000 + 5 * 60000).toISOString(),
      })
    ).data.reservation,
    raw = f.s.get<any>(
      "SELECT * FROM rental_reservations WHERE id=?",
      second.id,
    )!;
  assert.equal(raw.gpuUuids, first.gpuUuids);
  assert.equal(raw.port, first.port);
  assert.equal(f.s.all("SELECT * FROM deployments").length, 0);
  // A separate node with GPUs but only one port cannot sell overlapping workspaces.
  f.s.run(
    "UPDATE servers SET data=json_set(data,'$.portEnd',json_extract(data,'$.portStart')) WHERE id=?",
    f.node,
  );
  const later = {
    ...body,
    cards: 1,
    startsAt: new Date(start + 3 * 3600000).toISOString(),
  };
  assert.equal((await book(f, later)).status, 202);
  assert.equal((await book(f, later)).status, 409);
});

test("future commitments allow short immediate use but reject overlapping purchases, administrator allocations and topology changes", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    body = reserveBody(f, clock.now + 4 * 3600000, 2, 1);
  await book(f, body);
  assert.equal(
    (
      await f.call(
        "/api/admin/servers/" + f.node,
        "PUT",
        { ...f.config, portEnd: f.config.portEnd - 1 },
        f.admin.id,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        "/api/admin/servers/" + f.node,
        "DELETE",
        undefined,
        f.admin.id,
      )
    ).status,
    409,
  );
  const short = f.purchase(1, 1);
  assert.ok(short.id);
  assert.equal(f.s.all("SELECT * FROM rental_orders").length, 1);
  assert.throws(() => f.purchase(1, 4), /Offer unavailable|GPU unavailable/);
  assert.throws(
    () =>
      f.infra.create(
        {
          serverId: f.node,
          workloadType: "gpu-rental",
          ownerEmail: f.user.email,
          gpuUuids: ["GPU-1"],
          endAt: clock.now + 60000,
          reservationId: "untrusted",
        },
        f.admin.id,
        randomUUID(),
      ),
    /Resources promised/,
  );
});

test("an expiring paid workspace can be booked in advance, while a renewal may not cross the next reservation", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    order = f.purchase(1, 1);
  await f.ready(order);
  f.acknowledge();
  const start =
    Date.parse(
      f.billing.project(f.billing.row(order.deploymentId)!).expiresAt!,
    ) +
    3600000 +
    5 * 60000;
  const body = { ...f.body(2, 1), startsAt: new Date(start).toISOString() },
    result = await book(f, body);
  assert.equal(result.status, 202);
  const conflict = await f.call(
    "/api/compute/orders/" + order.id + "/renew",
    "POST",
    { hours: 2 },
    f.user.id,
    randomUUID(),
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, "reservation_conflict");
  assert.equal(f.billing.row(order.deploymentId)!.hours, 1);
  const allowed = await f.call(
    "/api/compute/orders/" + order.id + "/renew",
    "POST",
    { hours: 1 },
    f.user.id,
    randomUUID(),
  );
  assert.equal(allowed.status, 202);
  f.acknowledge();
  assert.equal(f.billing.row(order.deploymentId)!.hours, 2);
});

test("scheduled dispatch transfers the hold once, honors the fixed end and original price, and charges only the delivered remainder", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    start = clock.now + 3600000,
    body = reserveBody(f, start),
    reservation = (await book(f, body)).data.reservation;
  f.s.run(
    "UPDATE servers SET data=json_set(data,'$.hourlyPrice',9000000,'$.rentalSalesEnabled',json('false')) WHERE id=?",
    f.node,
  );
  clock.go(start - 1);
  f.infra.tick();
  assert.equal(f.s.all("SELECT * FROM deployments").length, 0);
  clock.go(start + 5 * 60000);
  f.infra.tick();
  f.infra.tick();
  const row = f.s.get<any>(
    "SELECT * FROM rental_orders WHERE reservationId=?",
    reservation.id,
  )!;
  assert.ok(row);
  assert.equal(f.s.all("SELECT * FROM rental_orders").length, 1);
  assert.equal(f.s.held(f.user.id), 3600000);
  assert.equal(
    f.s.get<any>(
      "SELECT reserved FROM rental_reservations WHERE id=?",
      reservation.id,
    )!.reserved,
    0,
  );
  const order = { id: row.id, deploymentId: row.deploymentId };
  await f.ready(order);
  assert.equal(f.s.held(f.user.id), 3600000);
  f.acknowledge();
  f.acknowledge();
  const active = f.billing.row(row.deploymentId)!;
  assert.equal(active.hourlyPrice, 3600000);
  assert.equal(active.amount, 3300000);
  assert.equal(active.charged, 3300000);
  assert.equal(active.expiresAt, start + 3600000);
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(f.s.user(f.user.id)!.balance, 96700000);
  assert.equal(
    f.s.get<any>(
      "SELECT status FROM rental_reservations WHERE id=?",
      reservation.id,
    )!.status,
    "active",
  );
  assert.equal(f.s.all("SELECT * FROM ledger WHERE type='compute'").length, 1);
  clock.go(start + 3600000);
  f.infra.tick();
  f.cleanup(order);
  assert.equal(f.billing.row(row.deploymentId)!.refunded, 0);
  assert.equal(
    f.s.get<any>(
      "SELECT status FROM rental_reservations WHERE id=?",
      reservation.id,
    )!.status,
    "completed",
  );
  assert.equal(
    f.s.all("SELECT * FROM ledger WHERE type='compute_refund'").length,
    0,
  );
});

test("canceling a future reservation is free and repeatable; canceling after dispatch retains physical ownership until cleanup", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    start = clock.now + 3600000,
    body = reserveBody(f, start),
    first = (await book(f, body)).data.reservation;
  const cancel = () =>
    f.call("/api/compute/reservations/" + first.id + "/cancel", "POST", {});
  assert.equal((await cancel()).data.reservation.status, "canceled");
  assert.equal((await cancel()).data.reservation.status, "canceled");
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  const next = (await book(f, body)).data.reservation;
  clock.go(start);
  f.infra.tick();
  const row = f.s.get<any>(
    "SELECT * FROM rental_orders WHERE reservationId=?",
    next.id,
  )!;
  assert.equal(
    (
      await f.call(
        "/api/compute/reservations/" + next.id + "/cancel",
        "POST",
        {},
      )
    ).data.reservation.status,
    "stopping",
  );
  assert.equal(f.s.held(f.user.id), 0);
  assert.ok(
    f.s.get(
      "SELECT 1 FROM gpu_allocations WHERE deploymentId=? AND released=0",
      row.deploymentId,
    ),
  );
  f.cleanup(row);
  assert.equal(
    f.s.get<any>("SELECT status FROM rental_reservations WHERE id=?", next.id)!
      .status,
    "canceled",
  );
  assert.equal(f.s.all("SELECT * FROM ledger WHERE type='compute'").length, 0);
});

test("late startup or missing expiry protection fails the booking without charging, and late acknowledgements cannot revive it", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    start = clock.now + 3600000,
    reservation = (await book(f, reserveBody(f, start))).data.reservation;
  clock.go(start + 60000);
  f.infra.tick();
  const row = f.s.get<any>(
    "SELECT * FROM rental_orders WHERE reservationId=?",
    reservation.id,
  )!;
  await f.ready(row);
  clock.go(start + 20 * 60000);
  f.infra.tick();
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(f.billing.row(row.deploymentId)!.status, "failed");
  f.acknowledge();
  assert.equal(f.s.all("SELECT * FROM ledger WHERE type='compute'").length, 0);
  f.cleanup(row);
  assert.equal(
    f.s.get<any>(
      "SELECT status FROM rental_reservations WHERE id=?",
      reservation.id,
    )!.status,
    "failed",
  );
});

test("offline dispatch, changed GPU inventory and payment disputes do not silently deliver substitute resources or charge failed bookings", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    start = clock.now + 3600000,
    reservation = (await book(f, reserveBody(f, start))).data.reservation;
  clock.go(start + 5 * 60000, false);
  f.infra.tick();
  assert.equal(f.s.all("SELECT * FROM rental_orders").length, 0);
  assert.equal(f.s.held(f.user.id), 3600000);
  assert.equal(
    f.s.get<any>(
      "SELECT errorCode FROM rental_reservations WHERE id=?",
      reservation.id,
    )!.errorCode,
    "server_offline",
  );
  f.beat();
  f.s.run(
    "UPDATE gpus SET data=json_set(data,'$.name','Different GPU') WHERE serverId=? AND uuid='GPU-0'",
    f.node,
  );
  f.infra.tick();
  assert.equal(
    f.s.get<any>(
      "SELECT errorCode FROM rental_reservations WHERE id=?",
      reservation.id,
    )!.errorCode,
    "reservation_resource_changed",
  );
  assert.equal(f.s.all("SELECT * FROM rental_orders").length, 0);
  clock.go(start + 20 * 60000, false);
  f.infra.tick();
  assert.equal(
    f.s.get<any>(
      "SELECT status FROM rental_reservations WHERE id=?",
      reservation.id,
    )!.status,
    "failed",
  );
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  f.beat();
  const nextStart = clock.now + 3600000,
    next = (await book(f, reserveBody(f, nextStart))).data.reservation;
  f.s.run(
    "INSERT INTO payment_orders(id,userId,requestKey,fingerprint,amount,locale,createdAt,expiresAt,review) VALUES('review',?,'test-review','test',10000000,'zh-CN',?,?,1)",
    f.user.id,
    clock.now,
    clock.now + 3600000,
  );
  clock.go(nextStart);
  f.infra.tick();
  assert.equal(
    f.s.get<any>("SELECT status FROM rental_reservations WHERE id=?", next.id)!
      .status,
    "failed",
  );
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(f.s.all("SELECT * FROM rental_orders").length, 0);
});

test("administrator booking cancellation records a reason and releases the original quote without creating a consumption bill", async (t) => {
  const f = await reservationFixture(t),
    reservation = (await book(f, reserveBody(f, Date.now() + 3600000))).data
      .reservation;
  const path = "/api/admin/compute/reservations/" + reservation.id + "/cancel";
  assert.equal((await f.call(path, "POST", {}, f.admin.id)).status, 400);
  const result = await f.call(
    path,
    "POST",
    { reason: "Node service window" },
    f.admin.id,
  );
  assert.equal(result.status, 202);
  assert.equal(
    (await f.call("/api/compute/reservations")).data.data[0].cancelReason,
    "Node service window",
  );
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(f.s.all("SELECT * FROM ledger WHERE type='compute'").length, 0);
});

test("returning a delivered reservation refunds only unused delivered time and makes the released slot bookable again", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    start = clock.now + 3600000,
    r = (await book(f, reserveBody(f, start))).data.reservation;
  clock.go(start + 5 * 60000);
  f.infra.tick();
  const order = f.s.get<any>(
    "SELECT * FROM rental_orders WHERE reservationId=?",
    r.id,
  )!;
  await f.ready(order);
  f.acknowledge();
  assert.equal(f.billing.row(order.deploymentId)!.charged, 3300000);
  clock.go(start + 25 * 60000);
  const result = await f.call(
    "/api/compute/reservations/" + r.id + "/cancel",
    "POST",
    {},
  );
  assert.equal(result.data.reservation.status, "stopping");
  assert.equal(f.s.user(f.user.id)!.balance, 96700000);
  f.cleanup(order);
  assert.equal(f.billing.row(order.deploymentId)!.refunded, 2100000);
  assert.equal(f.s.user(f.user.id)!.balance, 98800000);
  assert.equal(
    f.s.get<any>("SELECT status FROM rental_reservations WHERE id=?", r.id)!
      .status,
    "completed",
  );
  assert.equal(
    (await book(f, reserveBody(f, clock.now + 10 * 60000, 2, 1))).status,
    202,
  );
  assert.equal(reconcile(f.s).healthy, true);
});

test("a cold control-plane restart retains future funds and plans, then dispatches exactly one linked order when the node returns", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    start = clock.now + 3600000,
    body = reserveBody(f, start),
    key = randomUUID(),
    r = (await book(f, body, key)).data.reservation;
  const dir = mkdtempSync(join(tmpdir(), "corematrix-reservation-restart-")),
    path = join(dir, "db.sqlite");
  f.s.run("VACUUM INTO ?", path);
  const original = f.s.all(
    "SELECT id,passwordHash,balance FROM users ORDER BY id",
  );
  f.infra.disposed = true;
  await new Promise<void>((resolve) => f.app.server.close(() => resolve()));
  clock.go(start, false);
  const app = createApplication({
    databasePath: path,
    publicOrigin: "http://control.tests.invalid",
  });
  try {
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    assert.deepEqual(
      app.store.all("SELECT id,passwordHash,balance FROM users ORDER BY id"),
      original,
    );
    assert.equal(app.store.held(f.user.id), r.amount);
    const infra = new Infrastructure(app.store),
      node = infra.node(f.node);
    infra.heartbeat(node, {
      instanceId: node.instanceId,
      bootId: node.bootId,
      generation: node.generation,
      sequence: node.sequence + 1,
      capabilities: JSON.parse(node.capabilities),
      inventoryError: null,
      gpus: app.store
        .all<any>("SELECT data FROM gpus WHERE serverId=?", f.node)
        .map((g) => JSON.parse(g.data)),
      containers: [],
    });
    infra.tick();
    infra.tick();
    assert.equal(app.store.all("SELECT * FROM rental_orders").length, 1);
    assert.equal(app.store.held(f.user.id), r.amount);
    assert.equal(
      infra.billing.reservations.book(
        infra,
        f.user.id,
        key,
        body,
        "control.tests.invalid",
      ).status,
      "starting",
    );
    assert.equal(app.store.all("SELECT * FROM rental_reservations").length, 1);
    assert.equal(reconcile(app.store).healthy, true);
    assert.equal(app.store.all("PRAGMA foreign_key_check").length, 0);
    app.store.run("UPDATE rental_orders SET reservationId=NULL");
    assert.ok(
      reconcile(app.store).issues.some(
        (i) => i.code === "reservation_order_mismatch",
      ),
    );
    assert.equal(
      app.store.get<{ reservationId: string | null }>(
        "SELECT reservationId FROM rental_orders",
      )!.reservationId,
      null,
    );
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await app.drain();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reservation reconciliation detects corrupt holds, links and overlapping plans without changing balances or allocations", async (t) => {
  const f = await reservationFixture(t),
    start = Date.now() + 3600000,
    body = reserveBody(f, start),
    first = (await book(f, body)).data.reservation,
    second = (
      await book(f, {
        ...body,
        startsAt: new Date(start + 2 * 3600000).toISOString(),
      })
    ).data.reservation;
  assert.equal(reconcile(f.s).healthy, true);
  f.s.run(
    "UPDATE rental_reservations SET startsAt=?,endsAt=?,reserved=reserved-1 WHERE id=?",
    start,
    start + 3600000,
    second.id,
  );
  const snapshot = {
    users: f.s.all("SELECT id,balance FROM users"),
    plans: f.s.all("SELECT * FROM rental_reservations"),
    gpu: f.s.all("SELECT * FROM gpu_allocations"),
  };
  const issues = reconcile(f.s).issues;
  assert.ok(issues.some((i) => i.code === "reservation_overlap"));
  assert.ok(issues.some((i) => i.code === "reservation_hold_mismatch"));
  assert.deepEqual(
    {
      users: f.s.all("SELECT id,balance FROM users"),
      plans: f.s.all("SELECT * FROM rental_reservations"),
      gpu: f.s.all("SELECT * FROM gpu_allocations"),
    },
    snapshot,
  );
  f.s.run(
    "UPDATE rental_reservations SET status='active' WHERE id=?",
    first.id,
  );
  assert.ok(
    reconcile(f.s).issues.some((i) => i.code === "reservation_order_mismatch"),
  );
});

test("a future quote can reserve all currently occupied GPUs only after their paid term and cleanup gap", async (t) => {
  const f = await reservationFixture(t),
    order = f.purchase(2, 1);
  await f.ready(order);
  f.acknowledge();
  const start = f.billing.row(order.deploymentId)!.expiresAt! + 5 * 60000;
  assert.equal((await f.call("/api/compute/offers")).data.data.length, 0);
  const offers = (
    await f.call(
      "/api/compute/offers?" +
        new URLSearchParams({
          hours: "1",
          startsAt: new Date(start).toISOString(),
        }),
    )
  ).data.data;
  assert.equal(offers[0].availableCards, 2);
  const result = await book(f, {
    offerId: offers[0].id,
    cards: 2,
    hours: 1,
    expectedHourlyPrice: offers[0].hourlyPrice,
    startsAt: new Date(start).toISOString(),
  });
  assert.equal(result.status, 202);
  assert.equal(f.s.all("SELECT * FROM deployments").length, 1);
  assert.equal(f.s.all("SELECT * FROM rental_reservations").length, 1);
  assert.equal(reconcile(f.s).healthy, true);
});

test("an administrator canceling their own booking still exposes the recorded administrative reason", async (t) => {
  const f = await reservationFixture(t);
  await f.call(
    "/api/admin/credits",
    "POST",
    {
      email: "admin@tests.invalid",
      amount: 10000000,
      reason: "Fixture funds",
      reference: "admin-reservation-funds",
    },
    f.admin.id,
  );
  const result = await f.call(
      "/api/compute/reservations",
      "POST",
      reserveBody(f, Date.now() + 3600000),
      f.admin.id,
      randomUUID(),
    ),
    id = result.data.reservation.id;
  await f.call(
    "/api/admin/compute/reservations/" + id + "/cancel",
    "POST",
    { reason: "Maintenance window" },
    f.admin.id,
  );
  assert.equal(
    (await f.call("/api/compute/reservations", "GET", undefined, f.admin.id))
      .data.data[0].cancelReason,
    "Maintenance window",
  );
  assert.equal(reconcile(f.s).healthy, true);
});

test("a verified payment reversal before a booked start preserves the hold, then cancels delivery and repays the debt when the hold is released", async (t) => {
  const f = await reservationFixture(t),
    clock = reservationClock(t, f),
    start = clock.now + 3600000,
    r = (await book(f, reserveBody(f, start))).data.reservation;
  // Simulate the verified wallet reversal; signature handling is covered in payments.test.ts.
  f.s.transaction(() => {
    f.s.run(
      "INSERT INTO payment_orders(id,userId,requestKey,fingerprint,amount,locale,credited,reversed,state,createdAt,expiresAt) VALUES('source-payment',?,'test-source-key','test',100000000,'zh-CN',100000000,100000000,'paid',?,?)",
      f.user.id,
      clock.now,
      clock.now + 3600000,
    );
    f.s.run(
      "UPDATE ledger SET metadata=? WHERE id='reservation-funds'",
      JSON.stringify({ provider: "stripe", paymentId: "source-payment" }),
    );
    f.s.run(
      "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day,metadata) VALUES('reverse-funds',?,'recharge_refund','Stripe','',100000000,'now','2026-10-16',?)",
      f.user.id,
      JSON.stringify({ provider: "stripe", paymentId: "source-payment" }),
    );
    f.s.run(
      "UPDATE users SET paymentDebt=paymentDebt+100000000 WHERE id=?",
      f.user.id,
    );
  });
  assert.equal(f.s.held(f.user.id), r.amount);
  assert.equal(f.s.user(f.user.id)!.balance, r.amount);
  assert.equal(f.s.user(f.user.id)!.paymentDebt, r.amount);
  clock.go(start);
  f.infra.tick();
  assert.equal(f.s.all("SELECT * FROM rental_orders").length, 0);
  assert.equal(f.s.user(f.user.id)!.paymentDebt, 0);
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(reconcile(f.s).healthy, true);
});
