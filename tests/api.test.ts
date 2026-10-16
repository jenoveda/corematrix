import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../server/app.ts";
import { hashPassword } from "../server/auth.ts";
import { Store } from "../server/store.ts";
import type { UserRow } from "../server/store.ts";
import type { State, Model } from "../src/domain.ts";
import type { ChatResponse } from "../src/api.ts";
const password = "test-password-123";
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
class Client {
  origin: string;
  cookie = "";
  csrf = "";
  constructor(origin: string) {
    this.origin = origin;
  }
  async call<T = State>(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(this.origin + path, {
      method,
      headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0];
    const data = (await response.json()) as T;
    const csrf = (data as { csrfToken?: string }).csrfToken;
    if (csrf) this.csrf = csrf;
    return { status: response.status, data, headers: response.headers };
  }
  register(email: string) {
    return this.call("/api/auth/register", "POST", {
      email,
      name: "测试用户",
      password,
      role: "admin",
      balance: 999999999,
    });
  }
}
test("真实 HTTP 注册、鉴权、模型管理与 Token 账本", async (t) => {
  let mode = "ok",
    upstreamCalls = 0,
    receivedModel = "",
    receivedKey = "";
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    receivedModel = JSON.parse(Buffer.concat(chunks).toString()).model;
    receivedKey = req.headers.authorization || "";
    upstreamCalls++;
    if (mode === "slow")
      await new Promise((resolve) => setTimeout(resolve, 150));
    if (mode === "timeout")
      await new Promise((resolve) => setTimeout(resolve, 1200));
    if (mode === "fail") {
      res.writeHead(500);
      res.end("{}");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "测试推理回复" } }],
        ...(mode !== "no-usage"
          ? { usage: { prompt_tokens: 1200, completion_tokens: 600 } }
          : {}),
      }),
    );
  });
  const upstreamOrigin = await listen(upstream),
    app = createApplication({
      databasePath: ":memory:",
      allowedOrigins: [upstreamOrigin],
      upstreamTimeoutMs: 1000,
    }),
    origin = await listen(app.server),
    admin = new Client(origin),
    user = new Client(origin),
    other = new Client(origin),
    anonymous = new Client(origin);
  t.after(async () => {
    await close(app.server);
    await close(upstream);
    app.store.close();
    delete process.env.INFERENCE_TEST_KEY;
  });
  app.store.createUser(
    "管理员",
    "admin@tests.invalid",
    await hashPassword(password),
    "admin",
  );
  assert.equal(
    (
      await admin.call("/api/auth/login", "POST", {
        email: "admin@tests.invalid",
        password,
      })
    ).status,
    200,
  );
  let model: Model;
  const completion = {
    model: "qwen3-32b",
    messages: [{ role: "user", content: "你好" }],
    max_tokens: 1024,
    stream: false,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  };
  async function credit(
    client: Client,
    email: string,
    amount: number,
    reference = crypto.randomUUID(),
  ) {
    return client.call("/api/admin/credits", "POST", {
      email,
      amount,
      reason: "测试人工入账",
      reference,
    });
  }
  await t.test(
    "注册不信任角色或余额，密码哈希，重复邮箱与错误登录",
    async () => {
      const result = await user.register("User@Tests.Invalid");
      assert.equal(result.status, 201);
      assert.equal(result.data.user?.role, "user");
      assert.equal(result.data.balance, 0);
      assert.match(result.headers.get("set-cookie")!, /HttpOnly/);
      const row = app.store.get<UserRow>(
        "SELECT * FROM users WHERE email=?",
        "user@tests.invalid",
      )!;
      assert.notEqual(row.passwordHash, password);
      assert.equal(JSON.stringify(result.data).includes("passwordHash"), false);
      assert.equal((await other.register("USER@tests.invalid")).status, 409);
      assert.equal(
        (
          await other.call("/api/auth/login", "POST", {
            email: "user@tests.invalid",
            password: "wrong-password-123",
          })
        ).status,
        401,
      );
      assert.equal((await other.register("other@tests.invalid")).status, 201);
    },
  );
  await t.test("管理员权限、CSRF 和跨站保护", async () => {
    assert.equal((await anonymous.call("/api/admin/models")).status, 401);
    assert.equal((await user.call("/api/admin/models")).status, 403);
    assert.equal((await credit(user, "user@tests.invalid", 100)).status, 403);
    assert.equal(
      (
        await user.call(
          "/api/wallet/budget",
          "PUT",
          { amount: 1_000_000 },
          { "X-CSRF-Token": "forged" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await user.call(
          "/api/wallet/budget",
          "PUT",
          { amount: 1_000_000 },
          { Origin: "https://evil.invalid" },
        )
      ).status,
      403,
    );
    assert.equal((await anonymous.call("/api/state")).data.models.length, 0);
  });
  await t.test(
    "模型 CRUD、地址白名单、上架可见性和管理员人工入账幂等",
    async () => {
      model = (await admin.call<{ data: Model[] }>("/api/admin/models")).data
        .data[0];
      assert.equal(
        (
          await admin.call("/api/admin/models/" + model.id, "PUT", {
            ...model,
            upstreamUrl: "http://169.254.169.254/latest/meta-data",
          })
        ).status,
        400,
      );
      model = {
        ...model,
        upstreamUrl: upstreamOrigin + "/v1/chat/completions",
        upstreamModel: "upstream-model",
        enabled: true,
        contextTokens: 2000,
      };
      assert.equal(
        (await admin.call("/api/admin/models/" + model.id, "PUT", model))
          .status,
        200,
      );
      const publicModel = (await user.call("/api/state")).data.models[0];
      assert.equal(publicModel.id, model.id);
      assert.equal(publicModel.upstreamUrl, undefined);
      assert.equal(publicModel.apiKeyEnv, undefined);
      const reference = crypto.randomUUID();
      assert.equal(
        (await credit(admin, "user@tests.invalid", 10_000_000, reference))
          .status,
        200,
      );
      assert.equal(
        (await credit(admin, "user@tests.invalid", 10_000_000, reference))
          .status,
        200,
      );
      assert.equal((await user.call("/api/wallet")).data.balance, 10_000_000);
      assert.equal(
        (await credit(admin, "user@tests.invalid", 20_000_000, reference))
          .status,
        409,
      );
    },
  );
  await t.test(
    "余额不足不请求上游，实际 usage 计费，幂等重放与请求冲突",
    async () => {
      const before = upstreamCalls;
      assert.equal(
        (
          await other.call("/v1/chat/completions", "POST", completion, {
            "Idempotency-Key": "no-money-request",
          })
        ).status,
        402,
      );
      assert.equal(upstreamCalls, before);
      const result = await user.call<ChatResponse>(
        "/v1/chat/completions",
        "POST",
        completion,
        { "Idempotency-Key": "first-request-001" },
      );
      assert.equal(result.status, 200);
      assert.equal(result.data.billing.amount, 6000);
      assert.equal(receivedModel, "upstream-model");
      const replay = await user.call<ChatResponse>(
        "/v1/chat/completions",
        "POST",
        completion,
        { "Idempotency-Key": "first-request-001" },
      );
      assert.deepEqual(replay.data, result.data);
      assert.equal(upstreamCalls, before + 1);
      assert.equal(
        (
          await user.call(
            "/v1/chat/completions",
            "POST",
            {
              ...completion,
              messages: [{ role: "user", content: "不同内容" }],
            },
            { "Idempotency-Key": "first-request-001" },
          )
        ).status,
        409,
      );
      const wallet = (await user.call("/api/state")).data;
      assert.equal(wallet.balance, 9_994_000);
      assert.equal(wallet.bills[0].amount, 6000);
      assert.equal(wallet.tokenSpend, 6000);
      assert.equal((await other.call("/api/state")).data.bills.length, 0);
    },
  );
  await t.test("价格快照：改价不影响历史账单", async () => {
    model = { ...model, inputPrice: 4_000_000 };
    await admin.call("/api/admin/models/" + model.id, "PUT", model);
    const result = await user.call<ChatResponse>(
      "/v1/chat/completions",
      "POST",
      completion,
      { "Idempotency-Key": "new-price-request" },
    );
    assert.equal(result.data.billing.amount, 8400);
    const bills = (await user.call("/api/state")).data.bills;
    assert.equal(bills[1].amount, 6000);
    assert.equal(bills[1].inputPrice, 2_000_000);
  });
  await t.test(
    "上游错误或缺失 usage 不扣费且释放预留；失败重放不重复请求",
    async () => {
      const before = (await user.call("/api/state")).data.balance;
      for (const value of ["fail", "no-usage", "timeout"]) {
        mode = value;
        const key = "failed-" + value;
        const result = await user.call(
          "/v1/chat/completions",
          "POST",
          completion,
          { "Idempotency-Key": key },
        );
        assert.equal(result.status, 502);
        const wallet = (await user.call("/api/state")).data;
        assert.equal(wallet.balance, before);
        assert.equal(wallet.heldBalance, 0);
        const calls = upstreamCalls;
        assert.equal(
          (
            await user.call("/v1/chat/completions", "POST", completion, {
              "Idempotency-Key": key,
            })
          ).status,
          502,
        );
        assert.equal(upstreamCalls, calls);
      }
      mode = "ok";
    },
  );
  await t.test("API Key 哈希保存、真实调用、撤销与不能管理后台", async () => {
    process.env.INFERENCE_TEST_KEY = "upstream-test-secret";
    model = { ...model, apiKeyEnv: "INFERENCE_TEST_KEY" };
    await admin.call("/api/admin/models/" + model.id, "PUT", model);
    const key = (await user.call<{ key: string }>("/api/keys", "POST")).data
        .key,
      bearer = new Client(origin);
    const result = await bearer.call<ChatResponse>(
      "/v1/chat/completions",
      "POST",
      completion,
      {
        Authorization: `Bearer ${key}`,
        "Idempotency-Key": "bearer-request-001",
      },
    );
    assert.equal(result.status, 200);
    assert.equal(receivedKey, "Bearer upstream-test-secret");
    assert.equal(
      JSON.stringify(app.store.all("SELECT * FROM api_keys")).includes(key),
      false,
    );
    assert.equal(
      (
        await bearer.call("/api/admin/models", "GET", undefined, {
          Authorization: `Bearer ${key}`,
        })
      ).status,
      401,
    );
    await user.call("/api/keys", "DELETE");
    assert.equal(
      (
        await bearer.call("/v1/chat/completions", "POST", completion, {
          Authorization: `Bearer ${key}`,
          "Idempotency-Key": "revoked-request-001",
        })
      ).status,
      401,
    );
  });
  await t.test("并发预留避免透支；重复处理中请求不重复调用", async () => {
    const poor = new Client(origin);
    await poor.register("poor@tests.invalid");
    await credit(admin, "poor@tests.invalid", 14144);
    mode = "slow";
    const results = await Promise.all([
      poor.call("/v1/chat/completions", "POST", completion, {
        "Idempotency-Key": "parallel-request-a",
      }),
      poor.call("/v1/chat/completions", "POST", completion, {
        "Idempotency-Key": "parallel-request-b",
      }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 402]);
    const wallet = (await poor.call("/api/state")).data;
    assert.equal(wallet.balance, 5744);
    assert.equal(wallet.heldBalance, 0);
    const before = upstreamCalls;
    const replay = await Promise.all([
      user.call("/v1/chat/completions", "POST", completion, {
        "Idempotency-Key": "same-pending-request",
      }),
      user.call("/v1/chat/completions", "POST", completion, {
        "Idempotency-Key": "same-pending-request",
      }),
    ]);
    assert.deepEqual(replay.map((r) => r.status).sort(), [200, 409]);
    assert.equal(upstreamCalls, before + 1);
    mode = "ok";
  });
  await t.test("预算、禁用模型、删除保留账单、登出使会话失效", async () => {
    await user.call("/api/wallet/budget", "PUT", { amount: 1_000_000 });
    model = { ...model, contextTokens: 1_000_000 };
    await admin.call("/api/admin/models/" + model.id, "PUT", model);
    assert.equal(
      (
        await user.call("/v1/chat/completions", "POST", completion, {
          "Idempotency-Key": "over-budget-request",
        })
      ).status,
      402,
    );
    const count = (await user.call("/api/state")).data.bills.length;
    assert.equal(
      (await admin.call("/api/admin/models/" + model.id, "DELETE")).status,
      200,
    );
    assert.equal((await user.call("/api/state")).data.models.length, 0);
    assert.equal((await user.call("/api/state")).data.bills.length, count);
    assert.equal(
      (
        await user.call("/v1/chat/completions", "POST", completion, {
          "Idempotency-Key": "deleted-model-request",
        })
      ).status,
      404,
    );
    const oldCookie = user.cookie;
    await user.call("/api/auth/logout", "POST");
    assert.equal(
      (await user.call("/api/state", "GET", undefined, { Cookie: oldCookie }))
        .data.user,
      null,
    );
    assert.equal(
      (await admin.call("/api/state")).data.summary!.revenue > 0,
      true,
    );
  });
});
test("SQLite 重启保留账户、价格和账本，并释放中断请求的预留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corematrix-test-")),
    path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    const user = store.createUser(
      "持久化用户",
      "persist@tests.invalid",
      await hashPassword(password),
    );
    store.run("UPDATE users SET balance=1000000 WHERE id=?", user.id);
    store.run(
      `INSERT INTO requests(id,userId,requestKey,fingerprint,day,status,reserved,modelId,modelName,inputPrice,outputPrice,createdAt) VALUES('interrupted',?,'restart-request','hash','2026-10-15','pending',100,'qwen3-32b','Qwen3',2000000,6000000,?)`,
      user.id,
      new Date().toISOString(),
    );
    const maintenance = new Store(path);
    assert.equal(
      maintenance.get<{ status: string }>(
        "SELECT status FROM requests WHERE id=?",
        "interrupted",
      )?.status,
      "pending",
    );
    maintenance.close();
    store.close();
    store = new Store(path, true);
    assert.equal(store.user(user.id)?.balance, 1_000_000);
    assert.equal(
      store.get<{ status: string }>(
        "SELECT status FROM requests WHERE id=?",
        "interrupted",
      )?.status,
      "failed",
    );
    assert.equal(store.snapshot(store.user(user.id)).heldBalance, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
