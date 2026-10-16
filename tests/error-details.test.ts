import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createApplication } from "../server/app.ts";
import {
  text,
  int,
  email,
  password,
  requestKey,
  object,
  HttpError,
  validateModel,
} from "../server/validation.ts";
import { digest, secret } from "../server/auth.ts";
import { request, ApiError, streamChat } from "../src/api.ts";
import { errorMessage, inputMessage } from "../src/i18n/errors.ts";
import { locales, translate } from "../src/i18n/messages.ts";

const model = {
  id: "error-test",
  name: "Test",
  tag: "Test",
  description: "",
  contextTokens: 32,
  maxOutputTokens: 16,
  inputPrice: 0,
  outputPrice: 0,
  gpus: 1,
  vram: 24,
  enabled: false,
  upstreamUrl: "",
  upstreamModel: "remote",
  apiKeyEnv: "",
  routingMode: "external",
};
function failure(fn: () => unknown, code: string, details: unknown) {
  assert.throws(fn, (e) => {
    assert(e instanceof HttpError);
    assert.equal(e.code, code);
    assert.deepEqual(e.details, details);
    assert(!JSON.stringify(e).includes("PRIVATE_SUBMITTED_VALUE"));
    return true;
  });
}

test("shared validators expose canonical constraints without submitted values", () => {
  failure(() => text("PRIVATE_SUBMITTED_VALUE", "name", 4), "invalid_text", {
    field: "name",
    min: 1,
    max: 4,
  });
  failure(() => text(null, "name", 40), "invalid_text", {
    field: "name",
    min: 1,
    max: 40,
  });
  failure(() => int(1.5, "cards", 1, 64), "invalid_integer", {
    field: "cards",
    min: 1,
    max: 64,
  });
  failure(() => email("PRIVATE_SUBMITTED_VALUE"), "invalid_email", {
    field: "email",
  });
  failure(() => password("x"), "invalid_password", {
    field: "password",
    min: 12,
    max: 128,
  });
  failure(
    () => requestKey("PRIVATE_SUBMITTED_VALUE\nmalformed", "reference"),
    "invalid_request_key",
    { field: "reference", min: 8, max: 100 },
  );
  failure(() => object(null), "invalid_object", { field: "body" });
  failure(
    () =>
      validateModel(
        { ...model, apiKeyEnv: "PRIVATE_SUBMITTED_VALUE" },
        new Set(),
      ),
    "invalid_api_key_env",
    { field: "apiKeyEnv" },
  );
  failure(
    () => validateModel({ ...model, inputPrice: -1 }, new Set()),
    "invalid_integer",
    { field: "inputPrice", min: 0, max: 10000000000 },
  );
  const runtime = {
    artifact: "test/model",
    revision: "v1",
    dtype: "auto",
    maxModelLen: 48,
    minGpuMemoryMiB: 32768,
    tensorParallelSize: 2,
  };
  failure(
    () =>
      validateModel({ ...model, routingMode: "managed", runtime }, new Set()),
    "invalid_integer",
    { field: "runtime.tensorParallelSize", min: 1, max: 1 },
  );
  failure(
    () =>
      validateModel(
        {
          ...model,
          routingMode: "managed",
          runtime: { ...runtime, tensorParallelSize: 1, maxModelLen: 47 },
        },
        new Set(),
      ),
    "invalid_integer",
    { field: "runtime.maxModelLen", min: 48, max: 1100000 },
  );
  assert.equal(email(" User@Tests.Invalid "), "user@tests.invalid");
  assert.equal(text("  日本語 한국어  ", "name", 40), "日本語 한국어");
});

test("four languages interpolate known fields, currency, GPU memory and correlation IDs", () => {
  const requestId = randomUUID();
  for (const locale of locales) {
    const n = (x: number) => new Intl.NumberFormat(locale).format(x),
      money = (x: number) =>
        new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "CNY",
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        }).format(x / 1e6);
    const constraints = errorMessage(locale, {
      code: "invalid_integer",
      details: { field: "cards", min: 1, max: 64 },
      requestId,
    });
    assert(constraints.includes(translate(locale, "rental.cards")));
    assert(constraints.includes(n(64)));
    assert(constraints.includes(requestId));
    assert(!constraints.includes("{field}"));
    const amount = errorMessage(locale, {
      code: "invalid_integer",
      details: { field: "inputPrice", min: 0, max: 10000000000 },
    });
    assert(amount.includes(money(10000000000)));
    const memory = errorMessage(locale, {
      code: "insufficient_gpu_memory",
      details: { requiredMiB: 40960, availableMiB: 32768 },
    });
    assert(memory.includes(n(40960)));
    assert(memory.includes(n(32768)));
    for (const code of ["insufficient_balance", "budget_exceeded"]) {
      const message = errorMessage(locale, {
        code,
        details: { requiredAmount: 2000000, availableAmount: 1000000 },
      });
      assert(message.includes(money(2000000)));
      assert(message.includes(money(1000000)));
    }
    const count = errorMessage(locale, {
      code: "gpu_unavailable",
      details: { requiredCards: 4, availableCards: 2 },
    });
    assert(count.includes(n(4)));
    assert(count.includes(n(2)));
    assert.equal(
      errorMessage(locale, { code: "future_unknown_code", requestId }),
      translate(locale, "errors.withRequestId", {
        message: translate(locale, "errors.request_failed"),
        requestId,
      }),
    );
  }
});

test("untrusted or malformed details never become displayed raw text or interpolation placeholders", () => {
  for (const locale of locales)
    for (const details of [
      null,
      [],
      "PRIVATE_SUBMITTED_VALUE",
      { field: "PRIVATE_SUBMITTED_VALUE", min: 1, max: 100 },
      { field: "__proto__", min: 0, max: 100 },
      { field: "cards", min: -1, max: Infinity },
      { field: "cards", min: 100, max: 1 },
      { requiredMiB: "PRIVATE_SUBMITTED_VALUE", availableMiB: 0 },
      { requiredAmount: Number.MAX_VALUE, availableAmount: 0 },
    ]) {
      for (const code of [
        "invalid_integer",
        "insufficient_gpu_memory",
        "insufficient_balance",
        "future_unknown_code",
        "withRequestId",
      ]) {
        const message = errorMessage(locale, {
          code,
          details,
          requestId: "PRIVATE_SUBMITTED_VALUE",
        });
        assert(!message.includes("PRIVATE_SUBMITTED_VALUE"));
        assert(!message.includes("{required}"));
        assert(!message.includes("{field}"));
        assert.doesNotMatch(message, /\{\w+\}/);
      }
    }
});

test("native validation covers required, email, length, numeric ranges, step and pattern in each language", () => {
  const base: any = {
    type: "number",
    minLength: 12,
    maxLength: 128,
    min: "1",
    max: "720",
    step: "0.5",
    validity: { valid: true },
  };
  const cases = [
    ["badInput", "validation.number", {}],
    ["valueMissing", "common.required", {}],
    ["tooShort", "common.minLength", { min: "12" }],
    ["tooLong", "validation.maxLength", { max: "128" }],
    ["rangeUnderflow", "validation.minimum", { min: "1" }],
    ["rangeOverflow", "validation.maximum", { max: "720" }],
    ["stepMismatch", "validation.step", { step: "0.5" }],
    ["patternMismatch", "validation.pattern", {}],
  ] as const;
  for (const locale of locales) {
    assert.equal(inputMessage(locale, base), "");
    const micro = new Intl.NumberFormat(locale, {
      maximumFractionDigits: 20,
    }).format(0.000001);
    assert.equal(
      inputMessage(locale, {
        ...base,
        min: "0.000001",
        validity: { rangeUnderflow: true, valid: false },
      }),
      translate(locale, "validation.minimum", { min: micro }),
    );
    assert.equal(
      inputMessage(locale, {
        ...base,
        step: "0.000001",
        validity: { stepMismatch: true, valid: false },
      }),
      translate(locale, "validation.step", { step: micro }),
    );
    for (const [flag, key, params] of cases)
      assert.equal(
        inputMessage(locale, {
          ...base,
          validity: { valid: false, [flag]: true },
        }),
        translate(locale, key, params),
      );
    assert.equal(
      inputMessage(locale, {
        ...base,
        type: "email",
        validity: { typeMismatch: true, valid: false },
      }),
      translate(locale, "errors.invalid_email"),
    );
    assert.equal(
      inputMessage(locale, {
        ...base,
        type: "url",
        validity: { typeMismatch: true, valid: false },
      }),
      translate(locale, "validation.url"),
    );
  }
});

test("API client preserves structured details and safe IDs, and rejects malformed error envelopes", async (t) => {
  const requestId = randomUUID(),
    details = { field: "cards", min: 1, max: 64 };
  let response = new Response(
    JSON.stringify({
      error: {
        code: "invalid_integer",
        message: "PRIVATE_SUBMITTED_VALUE",
        details,
      },
      requestId,
    }),
    { status: 400, headers: { "X-Request-ID": requestId } },
  );
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(request("/unused"), (e) => {
    assert(e instanceof ApiError);
    assert.deepEqual(e.details, details);
    assert.equal(e.requestId, requestId);
    assert(!errorMessage("en-US", e).includes("PRIVATE_SUBMITTED_VALUE"));
    return true;
  });
  for (const status of [200, 400, 502])
    for (const body of ["not json", "null", "[]"]) {
      response = new Response(body, {
        status,
        headers: { "X-Request-ID": requestId },
      });
      await assert.rejects(request("/unused"), (e) => {
        assert(e instanceof ApiError);
        assert.equal(e.status, 0);
        assert.equal(e.code, "invalid_response");
        assert.equal(e.requestId, requestId);
        return true;
      });
    }
  response = new Response('{"error":{"code":{},"message":{}}}', {
    status: 502,
    headers: { "X-Request-ID": requestId },
  });
  await assert.rejects(request("/unused"), (e) => {
    assert(e instanceof ApiError);
    assert(!errorMessage("en-US", e).includes("[object Object]"));
    return true;
  });
  assert.equal(
    new ApiError(400, "unused", "future", undefined, "not a request id")
      .requestId,
    undefined,
  );
});

test("streamed failures retain the inference ID and safely localize their details", async (t) => {
  const requestId = randomUUID(),
    details = { requiredMiB: 40960, availableMiB: 32768 };
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        "data: " +
          JSON.stringify({
            request_id: requestId,
            error: {
              code: "insufficient_gpu_memory",
              message: "PRIVATE_SUBMITTED_VALUE",
              details,
            },
          }) +
          "\n\ndata: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  await assert.rejects(
    streamChat(
      {},
      {
        csrf: "test",
        requestId: randomUUID(),
        signal: new AbortController().signal,
        onText: () => {},
        onId: () => {},
      },
    ),
    (e) => {
      assert(e instanceof ApiError);
      assert.equal(e.requestId, requestId);
      assert.deepEqual(e.details, details);
      assert(!errorMessage("ko-KR", e).includes("PRIVATE_SUBMITTED_VALUE"));
      return true;
    },
  );
});

test("HTTP validation identifies fields, GPU shortfalls and funds while keeping inference replay IDs stable", async (t) => {
  const upstream = createServer((_, res) => {
    res.writeHead(500);
    res.end("PRIVATE_SUBMITTED_VALUE");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const origin = "http://127.0.0.1:" + (upstream.address() as any).port;
  const app = createApplication({
      databasePath: ":memory:",
      allowedOrigins: [origin],
      mail: { origin: "http://control.tests.invalid", send: async () => {} },
    }),
    s = app.store;
  const admin = s.createUser(
      "Admin",
      "admin@tests.invalid",
      "secret-hash",
      "admin",
    ),
    user = s.createUser("Buyer", "buyer@tests.invalid", "secret-hash"),
    creds = new Map();
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
  const base = "http://127.0.0.1:" + (app.server.address() as any).port;
  t.after(async () => {
    app.server.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise<void>((r) => app.server.close(() => r()));
    await app.drain();
    s.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });
  async function call(
    path: string,
    data: unknown,
    who = admin.id,
    key = randomUUID(),
    method = "POST",
  ) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...creds.get(who),
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(data),
    });
    const body = await res.json();
    assert(!JSON.stringify(body).includes("PRIVATE_SUBMITTED_VALUE"));
    if (body.error)
      assert.equal(body.requestId, res.headers.get("X-Request-ID"));
    return { status: res.status, body, id: res.headers.get("X-Request-ID") };
  }
  const name = await call("/api/auth/register", {
    email: "new@tests.invalid",
    password: "test-password-123",
    name: "PRIVATE_SUBMITTED_VALUE".repeat(4),
  });
  assert.equal(name.body.error.code, "invalid_text");
  assert.deepEqual(name.body.error.details, { field: "name", min: 1, max: 40 });
  const emailError = await call("/api/auth/register", {
    email: "PRIVATE_SUBMITTED_VALUE",
    password: "test-password-123",
    name: "Test",
  });
  assert.equal(emailError.body.error.code, "invalid_email");
  assert.equal(
    (
      await call(
        "/api/account/preferences",
        { locale: "PRIVATE_SUBMITTED_VALUE" },
        user.id,
        undefined,
        "PUT",
      )
    ).body.error.code,
    "unsupported_locale",
  );
  assert.equal(
    (
      await call("/api/auth/forgot-password", {
        email: "buyer@tests.invalid",
        locale: "PRIVATE_SUBMITTED_VALUE",
      })
    ).body.error.code,
    "unsupported_locale",
  );
  const pricing = await call("/api/admin/models", { ...model, inputPrice: -1 });
  assert.equal(pricing.body.error.details.field, "inputPrice");
  const port = await call("/api/admin/servers", {
    name: "Node",
    region: "Test",
    inferenceHost: "http://127.0.0.1",
    portStart: 1023,
    portEnd: 1030,
  });
  assert.equal(port.body.error.details.field, "portStart");
  assert.equal(
    (await call("/api/admin/models", [])).body.error.code,
    "invalid_object",
  );
  const malformed = await fetch(base + "/api/admin/models", {
    method: "POST",
    headers: { ...creds.get(admin.id), "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal((await malformed.json()).error.code, "invalid_json");
  const managed = {
    ...model,
    id: "memory-test",
    routingMode: "managed",
    runtime: {
      artifact: "test/model",
      revision: "v1",
      dtype: "auto",
      maxModelLen: 48,
      minGpuMemoryMiB: 40960,
      tensorParallelSize: 1,
    },
  };
  assert.equal((await call("/api/admin/models", managed)).status, 201);
  const nodeId = randomUUID();
  s.run(
    "INSERT INTO servers(id,data,tokenHash,lastHeartbeat,capabilities) VALUES(?,?,?,?,?)",
    nodeId,
    JSON.stringify({
      name: "Node",
      workMode: "inference",
      schedulingEnabled: true,
      maintenance: false,
      inferenceHost: "http://127.0.0.1",
      portStart: 8000,
      portEnd: 8031,
    }),
    digest(secret()),
    Date.now(),
    JSON.stringify({
      dockerReady: true,
      inferenceReady: true,
      runtimeImageDigest: "sha256:" + "a".repeat(64),
    }),
  );
  s.run(
    "INSERT INTO gpus(serverId,uuid,data) VALUES(?,?,?)",
    nodeId,
    "GPU-test",
    JSON.stringify({
      uuid: "GPU-test",
      name: "Test GPU",
      index: 0,
      totalMemoryMiB: 32768,
      externalBusy: false,
    }),
  );
  const gpu = await call("/api/admin/deployments", {
    serverId: nodeId,
    modelId: managed.id,
    gpuUuids: ["GPU-test"],
  });
  assert.equal(gpu.body.error.code, "insufficient_gpu_memory");
  assert.deepEqual(gpu.body.error.details, {
    requiredMiB: 40960,
    availableMiB: 32768,
  });
  assert.equal(s.all("SELECT * FROM gpu_allocations").length, 0);
  const live = {
    ...model,
    id: "inference-error",
    enabled: true,
    upstreamUrl: origin + "/v1/chat/completions",
    inputPrice: 1000000,
    contextTokens: 4,
    maxOutputTokens: 4,
  };
  assert.equal((await call("/api/admin/models", live)).status, 201);
  const chat = {
    model: live.id,
    messages: [{ role: "user", content: "Test" }],
    max_tokens: 2,
  };
  const balance = await call("/v1/chat/completions", chat, user.id);
  assert.equal(balance.body.error.code, "insufficient_balance");
  assert.deepEqual(balance.body.error.details, {
    requiredAmount: 4,
    availableAmount: 0,
  });
  s.run("UPDATE users SET balance=20,dailyBudget=1 WHERE id=?", user.id);
  s.run(
    "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES(?,?,'recharge','Test','Test',20,?,?)",
    randomUUID(),
    user.id,
    new Date().toISOString(),
    "2026-10-16",
  );
  const budget = await call("/v1/chat/completions", chat, user.id);
  assert.equal(budget.body.error.code, "budget_exceeded");
  assert.deepEqual(budget.body.error.details, {
    requiredAmount: 4,
    availableAmount: 1,
  });
  s.run("UPDATE users SET dailyBudget=100 WHERE id=?", user.id);
  const key = randomUUID(),
    first = await call("/v1/chat/completions", chat, user.id, key),
    replay = await call("/v1/chat/completions", chat, user.id, key);
  assert.equal(first.status, 502);
  assert.equal(first.body.requestId, first.body.request_id);
  assert.equal(first.id, replay.id);
  assert.deepEqual(first.body, replay.body);
  assert.equal(s.user(user.id)!.balance, 20);
  assert.equal(s.all("SELECT * FROM requests").length, 1);
});
