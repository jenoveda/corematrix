import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApplication } from "../server/app.ts";
import { secret, digest } from "../server/auth.ts";
import { readSSE } from "../src/sse.ts";
import { reconcile } from "../server/finance.ts";

async function fixture(t: any, mode = "ok", timeout = 2000) {
  let calls = 0,
    seen: any,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    if (mode === "json") {
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    const frame = (delta: unknown, finish_reason: unknown = null) => ({
      id: "private-upstream-id",
      model: "private-model",
      choices: [{ index: 0, delta, finish_reason }],
    });
    const send = (data: unknown) => {
      if (!res.destroyed)
        res.write("data: " + JSON.stringify(data) + "\r\n\r\n");
    };
    send(frame({ role: "assistant", content: "" }));
    if (mode === "gated") await gate;
    if (mode === "timeout") await new Promise((r) => setTimeout(r, 250));
    if (res.destroyed) return;
    if (mode === "malformed") {
      res.end("data: not-json\n\n");
      return;
    }
    if (mode === "oversize") {
      send(frame({ content: "a".repeat(1024 * 1024) }));
      res.end();
      return;
    }
    if (mode === "tools") {
      send(frame({ tool_calls: [{}] }));
      res.end();
      return;
    }
    // UTF-8 and CRLF are intentionally split across individual transport chunks.
    const raw = Buffer.from(
      "data: " +
        JSON.stringify(frame({ content: "你好こんにちは안녕" })) +
        "\r\n\r\n",
    );
    for (let i = 0; i < raw.length; i += 3) res.write(raw.subarray(i, i + 3));
    send(frame({}, "stop"));
    if (mode !== "missing_usage")
      send({
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: mode === "bad_usage" ? 999 : 7,
          total_tokens: mode === "bad_total" ? 100 : 19,
        },
      });
    if (mode !== "missing_done") res.write("data: [DONE]\n\n");
    res.end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const origin = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const app = createApplication({
      databasePath: ":memory:",
      allowedOrigins: [origin],
      upstreamTimeoutMs: timeout,
    }),
    s = app.store,
    user = s.createUser("Stream", "stream@tests.invalid", "unused"),
    other = s.createUser("Other", "other-stream@tests.invalid", "unused");
  s.run("UPDATE users SET balance=10000 WHERE id=?", user.id);
  s.run(
    "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES('credit',?,'recharge','Test funds','',10000,'now','2026-10-15')",
    user.id,
  );
  const creds = new Map();
  for (const u of [user, other]) {
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
  const apiKey = "cm_" + secret();
  s.run(
    "INSERT INTO api_keys VALUES(?,?,?)",
    digest(apiKey),
    user.id,
    "cm_test",
  );
  const model = {
    ...s.model("qwen2.5-7b")!,
    id: "stream-model",
    name: "Stream model",
    enabled: true,
    upstreamModel: "private-model",
    upstreamUrl: origin + "/v1/chat/completions",
    contextTokens: 64,
    maxOutputTokens: 32,
    inputPrice: 2000000,
    outputPrice: 6000000,
  };
  s.run(
    "INSERT INTO models(id,data) VALUES(?,?)",
    model.id,
    JSON.stringify(model),
  );
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  async function post(
    key: string,
    who = user.id,
    bearer = false,
    patch: Record<string, unknown> = {},
  ) {
    return fetch(
      `http://127.0.0.1:${(app.server.address() as any).port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          ...(bearer ? { Authorization: "Bearer " + apiKey } : creds.get(who)),
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: "Test" }],
          stream: true,
          max_tokens: 16,
          ...patch,
        }),
      },
    );
  }
  async function status(key: string, who = user.id, bearer = false) {
    const r = await fetch(
      `http://127.0.0.1:${(app.server.address() as any).port}/api/requests?key=` +
        key,
      {
        headers: bearer
          ? { Authorization: "Bearer " + apiKey }
          : creds.get(who),
      },
    );
    return { status: r.status, data: (await r.json()) as any };
  }
  t.after(async () => {
    release();
    app.server.closeAllConnections();
    await new Promise<void>((r) => app.server.close(() => r()));
    await app.drain();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    s.close();
  });
  return {
    app,
    s,
    user,
    other,
    model,
    post,
    status,
    release,
    calls: () => calls,
    seen: () => seen,
  };
}
async function events(r: Response) {
  assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  const result = [];
  for await (const e of readSSE(r.body!))
    result.push(e.data === "[DONE]" ? "[DONE]" : JSON.parse(e.data));
  return result;
}

test("SSE parser handles byte-split UTF-8, CRLF, comments and multi-line events with a byte limit", async () => {
  const raw = new TextEncoder().encode(
    '\ufeff: ping\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: [DONE]\n\n',
  );
  const body = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const byte of raw) c.enqueue(Uint8Array.of(byte));
        c.close();
      },
    });
  const seen = [];
  for await (const e of readSSE(body())) seen.push(e);
  assert.deepEqual(seen, [
    { event: "message", data: '{"text":\n"你好"}' },
    { event: "message", data: "[DONE]" },
  ]);
  await assert.rejects(async () => {
    for await (const _ of readSSE(body(), 5)) {
    }
  }, /sse_size_limit/);
});

test("streaming sends text before completion, bills snapshot usage once and replays without another inference", async (t) => {
  const f = await fixture(t, "gated"),
    key = "stream-success-001",
    res = await f.post(key, f.user.id, true);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("x-request-id"));
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  const iterator = readSSE(res.body!);
  const first = await iterator.next();
  assert.equal(
    JSON.parse(first.value!.data).choices[0].delta.role,
    "assistant",
  );
  const pending = await f.status(key, f.user.id, true);
  assert.equal(pending.data.status, "pending");
  assert.equal(pending.data.reserved, 224);
  assert.equal((await f.post(key)).status, 409);
  assert.equal((await f.status(key, f.other.id)).status, 404);
  f.s.run(
    "UPDATE models SET data=? WHERE id=?",
    JSON.stringify({ ...f.model, inputPrice: 9000000, outputPrice: 9000000 }),
    f.model.id,
  );
  f.release();
  const chunks: any[] = [];
  for await (const e of iterator)
    chunks.push(e.data === "[DONE]" ? "[DONE]" : JSON.parse(e.data));
  assert.equal(
    chunks
      .filter((c) => c !== "[DONE]")
      .flatMap((c) => c.choices)
      .map((c) => c.delta.content || "")
      .join(""),
    "你好こんにちは안녕",
  );
  const charged = chunks.find((c) => c.billing);
  assert.equal(charged.billing.amount, 66);
  assert.equal(charged.usage.total_tokens, 19);
  assert.equal(chunks.at(-1), "[DONE]");
  assert.equal(f.s.user(f.user.id)!.balance, 9934);
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.seen().stream_options, { include_usage: true });
  const completed = await f.status(key);
  assert.equal(completed.data.result.billing.amount, 66);
  assert.equal(
    completed.data.result.choices[0].message.content,
    "你好こんにちは안녕",
  );
  assert.equal(JSON.stringify(completed).includes("private-model"), false);
  assert.equal(JSON.stringify(completed).includes("passwordHash"), false);
  const replay = await events(await f.post(key));
  assert.equal(replay.find((c) => c.billing).id, charged.id);
  assert.equal(f.calls(), 1);
  assert.equal(f.s.all("SELECT * FROM ledger WHERE type='token'").length, 1);
  assert.equal(reconcile(f.s).healthy, true);
  assert.equal(
    (await f.post(key, f.user.id, false, { stream: false })).status,
    409,
  );
});

test("disconnecting the consumer keeps the request alive until trusted usage is settled", async (t) => {
  const f = await fixture(t, "gated"),
    key = "stream-disconnected-001",
    res = await f.post(key),
    iterator = readSSE(res.body!);
  await iterator.next();
  await iterator.return();
  assert.equal((await f.status(key)).data.status, "pending");
  f.release();
  await f.app.drain();
  const row = await f.status(key);
  assert.equal(row.data.status, "succeeded");
  assert.equal(row.data.amount, 66);
  assert.equal(f.s.user(f.user.id)!.balance, 9934);
  assert.equal(f.s.held(f.user.id), 0);
  assert.equal(f.calls(), 1);
  assert.equal(
    (await events(await f.post(key))).find((c) => c.billing).billing.amount,
    66,
  );
  assert.equal(f.calls(), 1);
});

test("upstream failures and invalid final usage never bill partial text and failure replay never regenerates", async (t) => {
  for (const mode of [
    "missing_usage",
    "missing_done",
    "bad_usage",
    "bad_total",
    "malformed",
    "tools",
    "oversize",
    "timeout",
    "json",
  ])
    await t.test(mode, async (sub) => {
      const f = await fixture(sub, mode, mode === "timeout" ? 80 : 2000),
        key = "stream-failure-" + mode,
        res = await f.post(key);
      const result = res.headers
        .get("content-type")
        ?.includes("text/event-stream")
        ? (await events(res)).find((e) => e.error)
        : await res.json();
      assert.equal(result.error.code, "upstream_error");
      assert.equal(f.s.user(f.user.id)!.balance, 10000);
      assert.equal(f.s.held(f.user.id), 0);
      assert.equal((await f.status(key)).data.status, "failed");
      assert.equal(
        f.s.all("SELECT * FROM ledger WHERE type='token'").length,
        0,
      );
      const retry = await f.post(key);
      assert.equal(retry.status, 502);
      assert.equal(f.calls(), 1);
      assert.equal(reconcile(f.s).healthy, true);
    });
});

test("graceful shutdown drains disconnected inference before the store is closed", async (t) => {
  const f = await fixture(t, "gated"),
    res = await f.post("stream-shutdown-001"),
    iterator = readSSE(res.body!);
  await iterator.next();
  await iterator.return();
  await new Promise<void>((r) => f.app.server.close(() => r()));
  let drained = false;
  const wait = f.app.drain().then(() => {
    drained = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(drained, false);
  f.release();
  await wait;
  assert.equal(
    f.s.get<any>(
      "SELECT status FROM requests WHERE requestKey='stream-shutdown-001'",
    ).status,
    "succeeded",
  );
  assert.equal(f.s.user(f.user.id)!.balance, 9934);
});
