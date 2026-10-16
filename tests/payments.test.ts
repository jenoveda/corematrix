import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";
import { createApplication } from "../server/app.ts";
import { digest, secret } from "../server/auth.ts";
import { day } from "../server/validation.ts";
import { stripeFromEnv } from "../server/payments.ts";
import { reconcile, financeReport } from "../server/finance.ts";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
async function fixture(t: any, durable = false, enabled = true) {
  const sessions = new Map<string, any>(),
    intents = new Map<string, any>(),
    charges = new Map<string, any>(),
    disputes = new Map<string, any>(),
    refunds = new Map<string, any>(),
    idempotency = new Map<string, { session: any; body: string }>(),
    created: any[] = [];
  let createCalls = 0,
    retrieveCalls = 0,
    upstreamCalls = 0,
    release!: () => void;
  const upstreamGate = new Promise<void>((r) => (release = r)),
    upstream = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      upstreamCalls++;
      await upstreamGate;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "Trusted reply" } },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        }),
      );
    });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const client = new Stripe("sk_test_fixture"),
    config = {
      client,
      origin: "https://platform.tests.invalid",
      webhookSecret: "whsec_fixture_test_only",
      liveMode: false,
    },
    behavior = {
      unknownOnce: false,
      failRetrieve: false,
      gate: undefined as Promise<void> | undefined,
    };
  t.mock.method(
    client.checkout.sessions,
    "create",
    async (params: any, options: any) => {
      createCalls++;
      created.push({ params: clone(params), options: clone(options) });
      const old = idempotency.get(options.idempotencyKey);
      if (old) {
        assert.equal(old.body, JSON.stringify(params));
        return clone(old.session);
      }
      const id = "cs_test_" + createCalls,
        s = {
          id,
          object: "checkout.session",
          livemode: false,
          mode: "payment",
          client_reference_id: params.client_reference_id,
          metadata: params.metadata,
          currency: "cny",
          amount_total: params.line_items[0].price_data.unit_amount,
          amount_subtotal: params.line_items[0].price_data.unit_amount,
          expires_at: params.expires_at,
          status: "open",
          payment_status: "unpaid",
          payment_intent: null,
          url: "https://checkout.stripe.com/c/pay/" + id,
        };
      sessions.set(id, s);
      idempotency.set(options.idempotencyKey, {
        session: s,
        body: JSON.stringify(params),
      });
      if (behavior.unknownOnce) {
        behavior.unknownOnce = false;
        throw Error("secret-provider-details");
      }
      return clone(s);
    },
  );
  t.mock.method(client.checkout.sessions, "retrieve", async (id: string) => {
    retrieveCalls++;
    if (behavior.failRetrieve) throw Error("secret-provider-details");
    if (behavior.gate) await behavior.gate;
    assert.ok(sessions.has(id));
    return clone(sessions.get(id));
  });
  t.mock.method(client.checkout.sessions, "list", async (params: any) => ({
    data: [...sessions.values()].filter(
      (s) => s.payment_intent?.id === params.payment_intent,
    ),
    has_more: false,
  }));
  t.mock.method(client.refunds, "list", async (params: any) => {
    const ch = charges.get(params.charge),
      existing = [...refunds.values()].filter(
        (r) => r.charge === params.charge,
      ),
      total = existing
        .filter((r) => !["failed", "canceled"].includes(r.status))
        .reduce((sum, r) => sum + r.amount, 0);
    if (ch.amount_refunded > total) {
      const r = {
        id: "re_test_" + refunds.size,
        charge: ch.id,
        currency: "cny",
        amount: ch.amount_refunded - total,
        status: "succeeded",
      };
      refunds.set(r.id, r);
    }
    return {
      data: clone(
        [...refunds.values()].filter((r) => r.charge === params.charge),
      ),
      has_more: false,
    };
  });
  t.mock.method(client.charges, "retrieve", async (id: string) => {
    assert.ok(charges.has(id));
    return clone(charges.get(id));
  });
  t.mock.method(client.paymentIntents, "retrieve", async (id: string) => {
    assert.ok(intents.has(id));
    return clone(intents.get(id));
  });
  t.mock.method(client.disputes, "retrieve", async (id: string) => {
    assert.ok(disputes.has(id));
    return clone(disputes.get(id));
  });
  const dir = durable
      ? mkdtempSync(join(tmpdir(), "corematrix-payments-"))
      : null,
    path = dir ? join(dir, "db.sqlite") : ":memory:";
  let app = createApplication({
    databasePath: path,
    allowedOrigins: [upstreamOrigin],
    stripe: enabled ? config : undefined,
  });
  const user = app.store.createUser(
      "Buyer",
      "buyer@payments.invalid",
      "unused",
    ),
    other = app.store.createUser("Other", "other@payments.invalid", "unused"),
    admin = app.store.createUser(
      "Admin",
      "admin@payments.invalid",
      "unused",
      "admin",
    ),
    creds = new Map<string, Record<string, string>>();
  for (const u of [user, other, admin]) {
    const token = secret(),
      csrf = secret();
    app.store.run(
      "INSERT INTO sessions VALUES(?,?,?,?)",
      digest(token),
      u.id,
      csrf,
      Date.now() + 3600000,
    );
    creds.set(u.id, { Cookie: "cm_session=" + token, "X-CSRF-Token": csrf });
  }
  const model = {
    ...app.store.model("qwen2.5-7b")!,
    id: "payment-model",
    enabled: true,
    upstreamUrl: upstreamOrigin + "/v1/chat/completions",
    contextTokens: 64,
    maxOutputTokens: 32,
    inputPrice: 2000000,
    outputPrice: 6000000,
  };
  app.store.run(
    "INSERT INTO models(id,data) VALUES(?,?)",
    model.id,
    JSON.stringify(model),
  );
  async function listen() {
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
  }
  await listen();
  const call = async (
    path: string,
    data?: unknown,
    who: string | null = user.id,
    headers: Record<string, string> = {},
  ) => {
    const r = await fetch(
      `http://127.0.0.1:${(app.server.address() as any).port}` + path,
      {
        method: data === undefined ? "GET" : "POST",
        headers: {
          ...(who ? creds.get(who) : {}),
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      },
    );
    return { status: r.status, body: await r.json() };
  };
  const checkout = (
    key = "payment-key-0001",
    amount = 100000000,
    who = user.id,
    locale = "zh-CN",
  ) =>
    call("/api/payments", { amount, locale }, who, { "Idempotency-Key": key });
  const session = (payment: any) =>
    sessions.get(
      app.store.get<any>(
        "SELECT sessionId FROM payment_orders WHERE id=?",
        payment.id,
      )!.sessionId,
    );
  function pay(payment: any) {
    const s = session(payment),
      id = "pi_" + s.id,
      chid = "ch_" + s.id,
      ch = {
        id: chid,
        object: "charge",
        livemode: false,
        payment_intent: id,
        currency: "cny",
        amount: s.amount_total,
        amount_captured: s.amount_total,
        amount_refunded: 0,
        paid: true,
        captured: true,
        status: "succeeded",
        disputed: false,
      },
      pi = {
        id,
        object: "payment_intent",
        livemode: false,
        metadata: s.metadata,
        currency: "cny",
        amount: s.amount_total,
        amount_received: s.amount_total,
        status: "succeeded",
        latest_charge: ch,
      };
    charges.set(chid, ch);
    intents.set(id, pi);
    s.status = "complete";
    s.payment_status = "paid";
    s.payment_intent = pi;
    return { s, pi, ch };
  }
  const event = (
    type: string,
    object: any,
    id = "evt_" + secret(),
    created = Math.floor(Date.now() / 1000),
  ) => ({
    id,
    object: "event",
    livemode: false,
    created,
    type,
    data: { object: clone(object) },
  });
  async function webhook(
    e: any,
    patch: {
      signature?: string;
      timestamp?: number;
      body?: string;
      signal?: AbortSignal;
    } = {},
  ) {
    const payload = patch.body ?? JSON.stringify(e),
      signature =
        patch.signature ??
        client.webhooks.generateTestHeaderString({
          payload,
          secret: config.webhookSecret,
          timestamp: patch.timestamp ?? Math.floor(Date.now() / 1000),
        });
    const r = await fetch(
      `http://127.0.0.1:${(app.server.address() as any).port}/api/payments/webhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": signature,
        },
        body: payload,
        signal: patch.signal,
      },
    );
    return { status: r.status, body: await r.json() };
  }
  async function restart() {
    await new Promise<void>((r) => app.server.close(() => r()));
    await app.drain();
    app.store.close();
    app = createApplication({
      databasePath: path,
      allowedOrigins: [upstreamOrigin],
      stripe: enabled ? config : undefined,
    });
    await listen();
  }
  t.after(async () => {
    release();
    await new Promise<void>((r) => app.server.close(() => r()));
    await app.drain();
    app.store.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    get s() {
      return app.store;
    },
    user,
    other,
    admin,
    creds,
    client,
    config,
    behavior,
    sessions,
    intents,
    charges,
    disputes,
    refunds,
    created,
    call,
    checkout,
    session,
    pay,
    event,
    webhook,
    restart,
    release,
    get createCalls() {
      return createCalls;
    },
    get retrieveCalls() {
      return retrieveCalls;
    },
    get upstreamCalls() {
      return upstreamCalls;
    },
  };
}

test("Stripe configuration pins mode, fixed origin and authenticated webhook; disabled payments remain unavailable", async (t) => {
  assert.equal(stripeFromEnv({}), undefined);
  const env = {
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    PUBLIC_ORIGIN: "https://platform.tests.invalid",
  };
  assert.equal(stripeFromEnv(env)!.liveMode, false);
  assert.equal(
    stripeFromEnv(env)!.client.getApiField("version"),
    Stripe.API_VERSION,
  );
  for (const extra of [
    { STRIPE_MODE: "live" },
    { STRIPE_WEBHOOK_SECRET: "" },
    { PUBLIC_ORIGIN: "https://evil.invalid/path" },
    { PUBLIC_ORIGIN: "http://remote.invalid", NODE_ENV: "production" },
  ])
    assert.throws(() => stripeFromEnv({ ...env, ...extra }));
  const f = await fixture(t, false, false);
  assert.equal((await f.call("/api/state")).body.paymentsEnabled, false);
  assert.equal((await f.checkout()).status, 503);
  assert.equal(f.createCalls, 0);
});

test("Checkout enforces session, CSRF, CNY cents and bounds; creation never credits and retries retain the same provider parameters", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.call("/api/payments", { amount: 10000000 }, null, {
        "Idempotency-Key": "auth-test-0001",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call("/api/payments", { amount: 10000000 }, f.user.id, {
        "Idempotency-Key": "csrf-test-0001",
        "X-CSRF-Token": "bad",
      })
    ).status,
    403,
  );
  for (const amount of [9999999, 100000000001, 10000001, 12.5, "10000000"])
    assert.equal(
      (await f.checkout("amount-test-" + String(amount), amount as any)).status,
      400,
    );
  const [first, second] = await Promise.all([
    f.checkout("same-key-0001", 100010000, f.user.id, "ja-JP"),
    f.checkout("same-key-0001", 100010000, f.user.id, "en-US"),
  ]);
  assert.equal(first.status, 201);
  assert.deepEqual(first, second);
  assert.equal(f.createCalls, 1);
  assert.equal(first.body.payment.amount, 100010000);
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  assert.equal(f.s.all("SELECT * FROM ledger").length, 0);
  const params = f.created[0].params;
  assert.deepEqual(params.allowed_payment_method_types, ["card"]);
  assert.equal(params.adaptive_pricing.enabled, false);
  assert.equal(params.locale, "ja");
  assert.equal(params.line_items[0].price_data.unit_amount, 10001);
  assert.equal(new URL(params.success_url).origin, f.config.origin);
  assert.equal(params.payment_intent_data.metadata.cm_user, f.user.id);
  assert.equal((await f.checkout("same-key-0001", 10000000)).status, 409);
  assert.equal(
    (
      await f.call(
        "/api/payments/" + first.body.payment.id,
        undefined,
        f.other.id,
      )
    ).status,
    404,
  );
  assert.equal((await f.call("/api/admin/payments")).status, 403);
  assert.equal(
    (await f.call("/api/admin/payments", undefined, f.admin.id)).body.data[0]
      .checkoutUrl,
    null,
  );
});

test("unknown Checkout responses recover one session after restart without retrying outside the creation window", async (t) => {
  const f = await fixture(t, true);
  f.behavior.unknownOnce = true;
  const first = await f.checkout("unknown-key-0001");
  assert.equal(first.status, 503);
  assert.equal(first.body.error.code, "payment_unknown");
  assert.equal(
    JSON.stringify(first).includes("secret-provider-details"),
    false,
  );
  await f.restart();
  const replay = await f.checkout("unknown-key-0001");
  assert.equal(replay.status, 201);
  assert.equal(f.sessions.size, 1);
  assert.equal(f.createCalls, 2);
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  f.behavior.unknownOnce = true;
  await f.checkout("old-unknown-0001");
  f.s.run(
    "UPDATE payment_orders SET createdAt=? WHERE requestKey=?",
    Date.now() - 16 * 60000,
    "old-unknown-0001",
  );
  const old = await f.checkout("old-unknown-0001");
  assert.equal(old.status, 409);
  assert.equal(old.body.error.code, "payment_creation_expired");
  assert.equal(f.createCalls, 3);
});

test("raw signatures, timestamp, mode, owner, currency and amount are verified before any money changes", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    { s } = f.pay(p),
    e = f.event("checkout.session.completed", s);
  assert.equal((await f.webhook(e, { signature: "bad" })).status, 400);
  assert.equal(
    (await f.webhook(e, { timestamp: Math.floor(Date.now() / 1000) - 1000 }))
      .status,
    400,
  );
  const encoded = JSON.stringify(e),
    sig = f.client.webhooks.generateTestHeaderString({
      payload: encoded,
      secret: f.config.webhookSecret,
    });
  assert.equal(
    (await f.webhook(e, { signature: sig, body: encoded + " " })).status,
    400,
  );
  assert.equal((await f.webhook({ ...e, livemode: true })).status, 400);
  assert.equal((await f.webhook({ ...e, account: "acct_other" })).status, 400);
  const good = clone(s);
  for (const patch of [
    { currency: "usd" },
    { amount_total: 1 },
    { metadata: { cm_order: p.id, cm_user: f.other.id } },
    { livemode: true },
    { client_reference_id: "wrong" },
    { expires_at: 0 },
  ]) {
    Object.assign(s, clone(good), patch);
    assert.equal(
      (await f.webhook(f.event("checkout.session.completed", s))).status,
      409,
    );
    assert.equal(f.s.user(f.user.id)!.balance, 0);
    assert.equal(f.s.all("SELECT * FROM payment_events").length, 0);
  }
  Object.assign(s, good);
});

test("signed callbacks retrieve current payment, settle once under concurrency, and do not treat redirects or unpaid completion as funds", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    s = f.session(p);
  await f.call("/api/payments/" + p.id);
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  assert.equal(
    (await f.webhook(f.event("checkout.session.completed", s))).status,
    200,
  );
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  f.pay(p);
  let release!: () => void;
  f.behavior.gate = new Promise((r) => (release = r));
  const e = f.event("checkout.session.completed", s, "evt_same");
  const before = f.retrieveCalls,
    a = f.webhook(e),
    b = f.webhook(e);
  try {
    for (let i = 0; i < 100 && f.retrieveCalls === before; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.retrieveCalls, before + 1);
  } finally {
    release();
  }
  assert.deepEqual(
    (await Promise.all([a, b])).map((r) => r.status),
    [200, 200],
  );
  f.behavior.gate = undefined;
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  assert.equal(f.s.all("SELECT * FROM ledger WHERE type='recharge'").length, 1);
  assert.equal((await f.webhook(e)).status, 200);
  assert.equal((await f.webhook({ ...e, created: e.created - 1 })).status, 409);
  assert.equal(
    (await f.webhook(f.event("checkout.session.expired", s))).status,
    200,
  );
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  assert.equal(reconcile(f.s).healthy, true);
  const report = financeReport(
    f.s,
    new URLSearchParams({ from: day(), to: day() }),
  );
  assert.equal(report.revenue, 0);
  assert.equal(report.credits, 100000000);
});

test("refund-before-payment, repeated and stale notifications apply only cumulative deltas and keep recharge out of revenue", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    { s, ch } = f.pay(p);
  ch.amount_refunded = 2500;
  assert.equal((await f.webhook(f.event("charge.refunded", ch))).status, 200);
  assert.equal(f.s.user(f.user.id)!.balance, 75000000);
  assert.equal(
    f.s.all("SELECT * FROM ledger WHERE type='recharge_refund'").length,
    1,
  );
  ch.amount_refunded = 0;
  assert.equal(
    (await f.webhook(f.event("checkout.session.completed", s))).status,
    200,
  );
  assert.equal(f.s.user(f.user.id)!.balance, 75000000);
  ch.amount_refunded = 10000;
  const full = f.event("charge.refunded", ch);
  assert.equal((await f.webhook(full)).status, 200);
  assert.equal((await f.webhook(full)).status, 200);
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  assert.equal(f.s.user(f.user.id)!.paymentDebt, 0);
  assert.equal(
    (await f.call("/api/payments/" + p.id)).body.payment.status,
    "refunded",
  );
  assert.equal(
    financeReport(f.s, new URLSearchParams({ from: day(), to: day() })).credits,
    0,
  );
  assert.equal(
    financeReport(f.s, new URLSearchParams({ from: day(), to: day() })).revenue,
    0,
  );
  assert.equal(reconcile(f.s).healthy, true);
});

test("refunds preserve live inference holds, settle actual usage and repay the resulting debt from later top-ups", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    { ch } = f.pay(p);
  await f.webhook(f.event("checkout.session.completed", f.session(p)));
  const chat = f.call(
    "/v1/chat/completions",
    {
      model: "payment-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "Test" }],
    },
    f.user.id,
    { "Idempotency-Key": "live-inference-0001" },
  );
  for (let i = 0; i < 100 && !f.upstreamCalls; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.upstreamCalls, 1);
  assert.equal(f.s.held(f.user.id), 224);
  ch.amount_refunded = 10000;
  await f.webhook(f.event("charge.refunded", ch));
  assert.equal(f.s.user(f.user.id)!.balance, 224);
  assert.equal(f.s.user(f.user.id)!.paymentDebt, 224);
  assert.equal(f.s.held(f.user.id), 224);
  const denied = await f.call(
    "/v1/chat/completions",
    {
      model: "payment-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "Another" }],
    },
    f.user.id,
    { "Idempotency-Key": "blocked-inference-0001" },
  );
  assert.equal(denied.status, 402);
  assert.equal(f.upstreamCalls, 1);
  f.release();
  assert.equal((await chat).body.billing.amount, 66);
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  assert.equal(f.s.user(f.user.id)!.paymentDebt, 66);
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(
    reconcile(f.s).issues.some(
      (i) => i.code === "balance_mismatch" || i.code === "invalid_hold",
    ),
    false,
  );
  assert.equal(
    reconcile(f.s).issues.some((i) => i.code === "payment_debt"),
    true,
  );
  const second = (await f.checkout("repay-key-0001", 10000000)).body.payment;
  f.pay(second);
  await f.webhook(f.event("checkout.session.completed", f.session(second)));
  assert.equal(f.s.user(f.user.id)!.balance, 9999934);
  assert.equal(f.s.user(f.user.id)!.paymentDebt, 0);
  assert.equal(reconcile(f.s).healthy, true);
  assert.equal(
    financeReport(f.s, new URLSearchParams({ from: day(), to: day() })).credits,
    10000000,
  );
  assert.equal(
    financeReport(f.s, new URLSearchParams({ from: day(), to: day() })).revenue,
    66,
  );
});

test("provider outages remain retryable without recording a false acknowledgement or exposing provider diagnostics", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    { s } = f.pay(p),
    e = f.event("checkout.session.completed", s);
  f.behavior.failRetrieve = true;
  const failure = await f.webhook(e);
  assert.equal(failure.status, 503);
  assert.equal(
    JSON.stringify(failure).includes("secret-provider-details"),
    false,
  );
  assert.equal(f.s.all("SELECT * FROM payment_events").length, 0);
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  f.behavior.failRetrieve = false;
  assert.equal((await f.webhook(e)).status, 200);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
});

test("payment disputes freeze new spending, winning restores access, and a lost dispute reverses the credit once", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    { s, ch } = f.pay(p);
  await f.webhook(f.event("checkout.session.completed", s));
  ch.disputed = true;
  const d = {
    id: "dp_test",
    charge: ch.id,
    currency: "cny",
    amount: 10000,
    status: "needs_response",
  };
  f.disputes.set(d.id, d);
  await f.webhook(f.event("charge.dispute.created", d, "evt_dispute_1", 100));
  assert.equal((await f.call("/api/state")).body.paymentReview, true);
  assert.equal(f.s.available(f.user.id), 0);
  d.status = "won";
  await f.webhook(f.event("charge.dispute.closed", d, "evt_dispute_2", 200));
  assert.equal(f.s.available(f.user.id), 100000000);
  d.status = "needs_response";
  await f.webhook(f.event("charge.dispute.updated", d, "evt_dispute_3", 150));
  assert.equal(f.s.available(f.user.id), 100000000);
  d.status = "lost";
  await f.webhook(f.event("charge.dispute.closed", d, "evt_dispute_4", 300));
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  assert.equal(f.s.user(f.user.id)!.paymentDebt, 0);
  assert.equal(
    f.s.all("SELECT * FROM ledger WHERE type='recharge_refund'").length,
    1,
  );
  assert.equal(reconcile(f.s).healthy, true);
});

test("durable callback idempotency and pagination preserve private history across restart", async (t) => {
  const f = await fixture(t, true),
    p = (await f.checkout()).body.payment,
    { s } = f.pay(p),
    e = f.event("checkout.session.completed", s);
  await f.webhook(e);
  await f.restart();
  assert.equal((await f.webhook(e)).status, 200);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  assert.equal(f.s.all("SELECT * FROM ledger WHERE type='recharge'").length, 1);
  for (let i = 0; i < 52; i++)
    f.s.run(
      "INSERT INTO payment_orders(id,userId,requestKey,fingerprint,amount,locale,createdAt,expiresAt) VALUES(?,?,?,'fixture',10000000,'zh-CN',?,?)",
      "history-" + i,
      f.user.id,
      "history-key-" + i,
      Date.now(),
      Date.now() + 3600000,
    );
  const first = (await f.call("/api/payments")).body,
    second = (await f.call("/api/payments?before=" + first.nextCursor)).body;
  assert.equal(first.data.length, 50);
  assert.equal(second.data.length, 3);
  assert.equal(
    new Set([...first.data, ...second.data].map((p) => p.id)).size,
    53,
  );
  assert.equal(
    (await f.call("/api/payments", undefined, f.other.id)).body.data.length,
    0,
  );
  assert.equal(reconcile(f.s).healthy, true);
});

test("pending refunds reduce spendable funds and failed or canceled refunds restore once without replaying stale states", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    { s, ch } = f.pay(p),
    refund = {
      id: "re_pending",
      charge: ch.id,
      currency: "cny",
      amount: 10000,
      status: "pending",
    };
  f.refunds.set(refund.id, refund);
  ch.amount_refunded = 10000;
  assert.equal(
    (await f.webhook(f.event("refund.created", refund))).status,
    200,
  );
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  assert.equal(
    (await f.call("/api/payments/" + p.id)).body.payment.status,
    "refund_pending",
  );
  const stale = f.event("refund.updated", refund);
  refund.status = "failed";
  ch.amount_refunded = 0;
  const failed = f.event("refund.failed", refund);
  assert.equal((await f.webhook(failed)).status, 200);
  assert.equal((await f.webhook(failed)).status, 200);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  assert.equal(f.s.user(f.user.id)!.paymentDebt, 0);
  assert.equal((await f.webhook(stale)).status, 200);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  const restores = f.s.all<any>(
    "SELECT * FROM ledger WHERE type='recharge_refund' AND amount<0",
  );
  assert.equal(restores.length, 1);
  assert.equal(JSON.parse(restores[0].metadata).restored, true);
  assert.equal(
    financeReport(f.s, new URLSearchParams({ from: day(), to: day() })).credits,
    100000000,
  );
  assert.equal(reconcile(f.s).healthy, true);
  const partial = {
    id: "re_canceled",
    charge: ch.id,
    currency: "cny",
    amount: 2500,
    status: "pending",
  };
  f.refunds.set(partial.id, partial);
  ch.amount_refunded = 2500;
  await f.webhook(f.event("refund.created", partial));
  assert.equal(f.s.user(f.user.id)!.balance, 75000000);
  partial.status = "canceled";
  ch.amount_refunded = 0;
  await f.webhook(f.event("refund.updated", partial));
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  assert.equal(reconcile(f.s).healthy, true);
});

test("a failed refund clears outstanding debt without touching an existing inference reservation", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    { s, ch } = f.pay(p);
  await f.webhook(f.event("checkout.session.completed", s));
  const chat = f.call(
    "/v1/chat/completions",
    {
      model: "payment-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "Test" }],
    },
    f.user.id,
    { "Idempotency-Key": "restore-live-0001" },
  );
  for (let i = 0; i < 100 && !f.upstreamCalls; i++)
    await new Promise((r) => setTimeout(r, 5));
  const refund = {
    id: "re_debt_failed",
    charge: ch.id,
    currency: "cny",
    amount: 10000,
    status: "pending",
  };
  f.refunds.set(refund.id, refund);
  ch.amount_refunded = 10000;
  await f.webhook(f.event("refund.created", refund));
  assert.equal(f.s.user(f.user.id)!.paymentDebt, 224);
  refund.status = "failed";
  ch.amount_refunded = 0;
  await f.webhook(f.event("refund.failed", refund));
  assert.equal(f.s.user(f.user.id)!.paymentDebt, 0);
  assert.equal(f.s.held(f.user.id), 224);
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  f.release();
  await chat;
  assert.equal(f.s.user(f.user.id)!.balance, 99999934);
  assert.equal(reconcile(f.s).healthy, true);
});

test("funds reinstated after a lost dispute restore the wallet and older dispute events cannot reverse them again", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    { s, ch } = f.pay(p),
    d = {
      id: "dp_reinstated",
      charge: ch.id,
      currency: "cny",
      amount: 10000,
      status: "lost",
    };
  f.disputes.set(d.id, d);
  ch.disputed = true;
  await f.webhook(f.event("charge.dispute.closed", d, "evt_lost", 100));
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  d.status = "won";
  await f.webhook(
    f.event("charge.dispute.funds_reinstated", d, "evt_reinstated", 200),
  );
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  d.status = "lost";
  await f.webhook(f.event("charge.dispute.closed", d, "evt_old_dispute", 200));
  assert.equal(f.s.user(f.user.id)!.balance, 100000000);
  assert.equal(reconcile(f.s).healthy, true);
});

test("oversized callbacks and incomplete refund histories fail before acknowledging or changing money", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    { s, ch } = f.pay(p);
  assert.equal((await f.webhook({}, { body: "a".repeat(262145) })).status, 413);
  ch.amount_refunded = 10000;
  t.mock.method(f.client.refunds, "list", async () => ({
    data: [],
    has_more: false,
  }));
  const e = f.event("charge.refunded", ch);
  assert.equal((await f.webhook(e)).status, 409);
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  assert.equal(f.s.all("SELECT * FROM payment_events").length, 0);
});

test("graceful shutdown drains a disconnected payment callback before database closure", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    { s } = f.pay(p),
    controller = new AbortController();
  let release!: () => void;
  f.behavior.gate = new Promise<void>((r) => (release = r));
  const result = f
    .webhook(f.event("checkout.session.completed", s), {
      signal: controller.signal,
    })
    .catch((e) => e);
  try {
    for (let i = 0; i < 100 && !f.retrieveCalls; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.retrieveCalls, 1);
    controller.abort();
    assert.ok((await result) instanceof Error);
    await new Promise<void>((r) => f.app.server.close(() => r()));
    let settled = false;
    const drain = f.app.drain().then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(settled, false);
    release();
    await drain;
    assert.equal(f.s.user(f.user.id)!.balance, 100000000);
    assert.equal(reconcile(f.s).healthy, true);
  } finally {
    release();
  }
});

test("failed asynchronous confirmation stays failed under older unpaid events and never credits the wallet", async (t) => {
  const f = await fixture(t),
    p = (await f.checkout()).body.payment,
    s = f.session(p);
  s.status = "complete";
  await f.webhook(f.event("checkout.session.async_payment_failed", s));
  assert.equal(
    (await f.call("/api/payments/" + p.id)).body.payment.status,
    "failed",
  );
  await f.webhook(f.event("checkout.session.completed", s));
  assert.equal(
    (await f.call("/api/payments/" + p.id)).body.payment.status,
    "failed",
  );
  assert.equal(f.s.user(f.user.id)!.balance, 0);
  assert.equal(f.s.all("SELECT * FROM ledger").length, 0);
});
