import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, createHmac } from "node:crypto";
import { Infrastructure } from "./infrastructure.ts";
import { Store } from "./store.ts";
import type { RequestRow, UserRow } from "./store.ts";
import { digest, hashPassword, secret, verifyPassword } from "./auth.ts";
import {
  check,
  cost,
  day,
  email,
  HttpError,
  int,
  object,
  password,
  requestKey,
  text,
  validateEndpoint,
  validateModel,
} from "./validation.ts";
import { MICRO } from "../src/domain.ts";
import type { Bill } from "../src/domain.ts";
import { consumeCompletion, finishStream, streamData } from "./stream.ts";
import type { ChatResponse } from "../src/api.ts";
import { accountToken, issueMail } from "./mail.ts";
import type { AccountMail } from "./mail.ts";
import { locales } from "../src/i18n/messages.ts";
import type { Locale } from "../src/i18n/messages.ts";
import { Payments } from "./payments.ts";
import type { StripeConfig } from "./payments.ts";
import { clientIpResolver } from "./client-ip.ts";
import { Operations } from "./operations.ts";
import type { OpsMail } from "./operations.ts";
import type { Certificates } from "./certificates.ts";
import { ownedServers, handleProviders } from "./providers.ts";
import { runtimeCredential } from "./node-credentials.ts";
import { reservationWindow, SETUP_MS } from "./reservations.ts";
import {
  recordExpense,
  voidExpense,
  financeReport,
  reconcile,
} from "./finance.ts";

type Options = {
  databasePath: string;
  allowedOrigins?: string[];
  publicOrigin?: string;
  adminPublicOrigin?: string;
  providerPublicOrigin?: string;
  splitPortals?: boolean;
  certificates?: Certificates;
  secureCookie?: boolean;
  upstreamTimeoutMs?: number;
  mail?: AccountMail;
  stripe?: StripeConfig;
  trustedProxyIps?: string[];
  opsMail?: OpsMail;
};
type Auth = { user: UserRow; csrf: string; bearer: boolean };
export function createApplication(options: Options) {
  type Portal = "user" | "admin" | "provider" | "legacy";
  const portals = new WeakMap<IncomingMessage, Portal>();
  const portal = (req: IncomingMessage) => portals.get(req) || "legacy";
  const cookieName = (req: IncomingMessage) =>
    portal(req) === "legacy" ? "cm_session" : `cm_${portal(req)}_session`;
  const sessionHash = (req: IncomingMessage, token: string) =>
    digest(portal(req) === "legacy" ? token : `${portal(req)}:${token}`);
  const publicOrigin = (req: IncomingMessage) =>
    options.certificates?.origin(portal(req) === "legacy" ? "user" : portal(req) as "user"|"admin"|"provider") ||
    (portal(req) === "admin" ? options.adminPublicOrigin : portal(req) === "provider" ? options.providerPublicOrigin : options.publicOrigin) ||
    `http://${req.headers.host}`;
  const secureCookie = (req: IncomingMessage) => options.secureCookie ||
    !!options.certificates?.origin(portal(req) === "legacy" ? "user" : portal(req) as "user"|"admin"|"provider");
  const clientIp = clientIpResolver(options.trustedProxyIps);
  const store = new Store(options.databasePath),
    origins = new Set(options.allowedOrigins || []);
  const infrastructure = new Infrastructure(store);
  const payments = new Payments(store, options.stripe);
  const operations = new Operations(store, infrastructure, options.opsMail);
  let activeAuth = 0,
    activeMail = 0;
  const inFlight = new Set<Promise<unknown>>();
  async function track<T>(task: Promise<T>) {
    inFlight.add(task);
    try {
      return await task;
    } finally {
      inFlight.delete(task);
    }
  }
  async function deliver(
    user: UserRow,
    purpose: "verify" | "reset",
    locale: Locale,
  ) {
    check(activeMail < 4, "Email service is busy", 503, "mail_unavailable");
    activeMail++;
    const task = issueMail(store, options.mail!, user, purpose, locale);
    inFlight.add(task);
    try {
      await task;
    } finally {
      inFlight.delete(task);
      activeMail--;
    }
  }
  function session(req: IncomingMessage): Auth | undefined {
    const raw = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookieName(req) + "="))
      ?.slice(cookieName(req).length + 1);
    if (!raw || !/^[a-zA-Z0-9_-]{43}$/.test(raw)) return;
    const session = store.get<{ userId: string; csrf: string }>(
      "SELECT userId,csrf FROM sessions WHERE tokenHash=? AND expires>?",
      sessionHash(req, raw),
      Date.now(),
    );
    const user = session && store.user(session.userId);
    return user && (portal(req) === "legacy" || user.role === portal(req))
      ? { user, csrf: session!.csrf, bearer: false }
      : undefined;
  }
  function authenticate(req: IncomingMessage, allowBearer = false): Auth {
    if (allowBearer && req.headers.authorization) {
      const token = req.headers.authorization.match(
        /^Bearer (cm_[a-zA-Z0-9_-]{43})$/,
      )?.[1];
      const key =
        token &&
        store.get<{ userId: string }>(
          "SELECT userId FROM api_keys WHERE tokenHash=?",
          digest(token),
        );
      const user = key && store.user(key.userId);
      check(user && (portal(req) === "legacy" || user.role === "user"), "API Key 无效或已撤销。", 401, "unauthorized");
      return { user, csrf: "", bearer: true };
    }
    const auth = session(req);
    check(auth, "请先登录。", 401, "unauthorized");
    if (!["GET", "HEAD"].includes(req.method || ""))
      check(
        req.headers["x-csrf-token"] === auth.csrf,
        "请求验证失败，请刷新页面重试。",
        403,
        "csrf_failed",
      );
    return auth;
  }
  function admin(req: IncomingMessage) {
    const auth = authenticate(req);
    check(auth.user.role === "admin", "此操作仅允许管理员。", 403, "forbidden");
    return auth;
  }
  function send(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(data));
  }
  function setSession(
    req: IncomingMessage,
    res: ServerResponse,
    user: UserRow,
  ) {
    const previous = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookieName(req) + "="))
      ?.slice(cookieName(req).length + 1);
    if (previous)
      store.run("DELETE FROM sessions WHERE tokenHash=?", sessionHash(req, previous));
    const token = secret(),
      csrf = secret();
    store.run(
      "INSERT INTO sessions VALUES(?,?,?,?)",
      sessionHash(req, token),
      user.id,
      csrf,
      Date.now() + 7 * 86400000,
    );
    res.setHeader(
      "Set-Cookie",
      `${cookieName(req)}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secureCookie(req) ? "; Secure" : ""}`,
    );
    return csrf;
  }
  async function body(req: IncomingMessage) {
    check(
      req.headers["content-type"]?.split(";")[0] === "application/json",
      "Content-Type 必须为 application/json。",
      415,
      "unsupported_content_type",
    );
    check(
      Number(req.headers["content-length"] || 0) <= 65536,
      "请求体过大。",
      413,
      "body_too_large",
    );
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const b = Buffer.from(chunk);
      length += b.length;
      check(length <= 65536, "请求体过大。", 413, "body_too_large");
      chunks.push(b);
    }
    try {
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "JSON 格式不正确。", "invalid_json");
    }
  }
  async function authHash<T>(operation: () => Promise<T>) {
    check(activeAuth < 8, "认证服务繁忙，请稍后重试。", 429);
    activeAuth++;
    try {
      return await operation();
    } finally {
      activeAuth--;
    }
  }
  async function chat(req: IncomingMessage, res: ServerResponse) {
    const { user } = authenticate(req, true),
      data = await body(req),
      key = requestKey(req.headers["idempotency-key"]);
    check(
      data.stream === undefined || typeof data.stream === "boolean",
      "stream must be boolean",
      400,
      "invalid_boolean",
      { field: "stream" },
    );
    const streaming = data.stream === true;
    check(
      !streaming || data.n === undefined || data.n === 1,
      "Only one streaming choice supported",
      400,
      "invalid_integer",
      { field: "n", min: 1, max: 1 },
    );
    const modelId = text(data.model, "model", 100),
      maxTokens = int(data.max_tokens ?? 1024, "max_tokens", 1, 100000);
    check(
      Array.isArray(data.messages) &&
        data.messages.length >= 1 &&
        data.messages.length <= 32,
      "messages 必须包含 1–32 条消息。",
      400,
      "invalid_messages",
      { field: "messages", min: 1, max: 32 },
    );
    const messages = data.messages.map((value) => {
      const m = object(value, "messages");
      check(
        ["user", "assistant", "system"].includes(String(m.role)),
        "消息角色不正确。",
        400,
        "invalid_option",
        { field: "messages.role" },
      );
      return {
        role: String(m.role),
        content: text(m.content, "messages.content", 16000),
      };
    });
    const fingerprint = digest(
      JSON.stringify({
        modelId,
        maxTokens,
        messages,
        ...(streaming ? { stream: true } : {}),
      }),
    );
    const previous = store.get<RequestRow>(
      "SELECT * FROM requests WHERE userId=? AND requestKey=?",
      user.id,
      key,
    );
    if (previous) {
      check(
        previous.fingerprint === fingerprint,
        "同一请求 ID 不能用于不同内容。",
        409,
        "idempotency_conflict",
      );
      res.setHeader("X-Request-ID", previous.id);
      check(
        previous.status !== "pending",
        "请求仍在处理中，请使用相同请求 ID 稍后重试。",
        409,
        "request_pending",
      );
      if (streaming && previous.status === "succeeded")
        finishStream(res, JSON.parse(previous.response!), modelId, true);
      else send(res, previous.httpStatus, JSON.parse(previous.response!));
      return;
    }
    store.limit(`chat:${user.id}`, 60, 60_000);
    const model = store.model(modelId);
    check(model?.enabled, "模型不存在或已下架。", 404, "model_unavailable");
    const managed = model.routingMode === "managed";
    let deployment = managed ? infrastructure.route(model.id) : undefined;
    check(
      !managed || deployment,
      "No healthy deployment",
      503,
      "no_healthy_deployment",
    );
    const spec = deployment ? JSON.parse(deployment.spec) : null;
    const endpoint = deployment
      ? infrastructure.endpoint(deployment) + "/v1/chat/completions"
      : model.upstreamUrl;
    check(endpoint, "Model not configured", 503, "model_not_configured");
    if (!managed) validateEndpoint(endpoint, origins);
    check(
      maxTokens <= model.maxOutputTokens,
      `max_tokens 不得超过 ${model.maxOutputTokens}。`,
      400,
      "invalid_integer",
      { field: "max_tokens", min: 1, max: model.maxOutputTokens },
    );
    const keyEnv = spec?.apiKeyEnv ?? model.apiKeyEnv;
    const apiKey = keyEnv ? deployment ? runtimeCredential(store,deployment.serverId,keyEnv) : process.env[keyEnv] : undefined;
    check(
      !keyEnv || apiKey,
      "模型服务密钥尚未配置。",
      503,
      "model_not_configured",
    );
    const reserved = cost(
        model.inputPrice,
        model.outputPrice,
        model.contextTokens,
        maxTokens,
      ),
      requestId = randomUUID(),
      requestCreated = Date.now(),
      requestDay = day();
    store.transaction(() => {
      if (deployment) {
        check(
          infrastructure.route(model.id)?.id === deployment.id,
          "Deployment no longer ready",
          503,
          "no_healthy_deployment",
        );
      }
      const current = store.user(user.id)!;
      const budgetUsed = store.get<{ value: number }>(
        `SELECT COALESCE(SUM(CASE WHEN status='pending' THEN reserved ELSE amount END),0) value FROM requests WHERE userId=? AND day=? AND status IN ('pending','succeeded')`,
        user.id,
        requestDay,
      )!.value;
      check(
        !store.paymentReview(user.id) &&
          current.paymentDebt === 0 &&
          store.available(user.id) >= reserved,
        "可用余额不足以预留本次最大费用，请联系管理员入账。",
        402,
        "insufficient_balance",
        { requiredAmount: reserved, availableAmount: store.available(user.id) },
      );
      check(
        budgetUsed + reserved <= current.dailyBudget,
        "本次预留费用超过每日预算。",
        402,
        "budget_exceeded",
        {
          requiredAmount: reserved,
          availableAmount: Math.max(0, current.dailyBudget - budgetUsed),
        },
      );
      store.run(
        `INSERT INTO requests(id,userId,requestKey,fingerprint,day,status,reserved,modelId,modelName,inputPrice,outputPrice,createdAt,deploymentId) VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?,?)`,
        requestId,
        user.id,
        key,
        fingerprint,
        requestDay,
        reserved,
        model.id,
        model.name,
        model.inputPrice,
        model.outputPrice,
        new Date(requestCreated).toISOString(),
        deployment?.id ?? null,
      );
    });
    res.setHeader("X-Request-ID", requestId);
    let response: Record<string, unknown>,
      inputTokens: number,
      outputTokens: number;
    try {
      const upstream = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: spec?.servedModelName ?? model.upstreamModel,
          messages,
          max_tokens: maxTokens,
          stream: streaming,
          ...(streaming ? { stream_options: { include_usage: true } } : {}),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(options.upstreamTimeoutMs ?? 60000),
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw new HttpError(
          502,
          "推理服务返回错误，本次未扣费。",
          "upstream_error",
        );
      }
      if (streaming)
        response = await consumeCompletion(
          upstream,
          res,
          requestId,
          modelId,
          Math.floor(requestCreated / 1000),
        );
      else {
        check(upstream.body, "推理服务返回空响应。", 502, "upstream_error");
        const reader = upstream.body.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            check(size <= 1024 * 1024, "推理响应过大。", 502, "upstream_error");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        response = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        check(
          Array.isArray(response.choices) &&
            response.choices.length > 0 &&
            response.choices.every(
              (c) => typeof object(object(c).message).content === "string",
            ),
          "推理服务回复格式不正确，本次未扣费。",
          502,
          "invalid_upstream",
        );
      }
      const usage = object(response.usage);
      inputTokens = int(
        usage.prompt_tokens,
        "上游 prompt_tokens",
        0,
        model.contextTokens,
      );
      outputTokens = int(
        usage.completion_tokens,
        "上游 completion_tokens",
        0,
        maxTokens,
      );
      check(
        usage.total_tokens === undefined ||
          usage.total_tokens === inputTokens + outputTokens,
        "Invalid usage total",
        502,
        "invalid_upstream",
      );
    } catch (e) {
      const message =
        e instanceof HttpError && e.status === 502
          ? e.message
          : "推理服务超时、无法连接或用量格式无效，本次未扣费。";
      const failure = {
        error: { code: "upstream_error", message },
        request_id: requestId,
        requestId,
      };
      store.transaction(() =>
        store.run(
          `UPDATE requests SET status='failed',reserved=0,response=?,httpStatus=502 WHERE id=? AND status='pending'`,
          JSON.stringify(failure),
          requestId,
        ),
      );
      if (res.headersSent) {
        streamData(res, failure);
        streamData(res, "[DONE]");
        if (!res.destroyed) res.end();
      } else if (!res.destroyed) send(res, 502, failure);
      return;
    }
    const amount = cost(
      model.inputPrice,
      model.outputPrice,
      inputTokens,
      outputTokens,
    );
    const output = {
      id: requestId,
      object: "chat.completion",
      created: Math.floor(requestCreated / 1000),
      model: modelId,
      choices: response.choices,
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      billing: {
        amount,
        currency: "CNY",
        unit: "micro_yuan",
        inputPrice: model.inputPrice,
        outputPrice: model.outputPrice,
      },
    };
    store.transaction(() => {
      store.run(
        "UPDATE users SET balance=balance-? WHERE id=?",
        amount,
        user.id,
      );
      store.run(
        `INSERT INTO ledger(id,userId,type,resource,quantity,amount,inputPrice,outputPrice,time,day,requestId,metadata) VALUES(?,?,'token',?,?,?,?,?,?,?,?,?)`,
        randomUUID(),
        user.id,
        model.name,
        `输入 ${inputTokens.toLocaleString("en-US")} / 输出 ${outputTokens.toLocaleString("en-US")} Token`,
        amount,
        model.inputPrice,
        model.outputPrice,
        new Date().toISOString(),
        requestDay,
        requestId,
        JSON.stringify({
          inputTokens,
          outputTokens,
          modelId,
          ...(streaming ? { streamed: true } : {}),
        }),
      );
      store.run(
        `UPDATE requests SET status='succeeded',reserved=0,inputTokens=?,outputTokens=?,amount=?,response=? WHERE id=? AND status='pending'`,
        inputTokens,
        outputTokens,
        amount,
        JSON.stringify(output),
        requestId,
      );
    });
    if (streaming) finishStream(res, output as ChatResponse, modelId);
    else if (!res.destroyed) send(res, 200, output);
  }
  async function handle(req: IncomingMessage, res: ServerResponse, audience: Portal) {
    portals.set(req, audience);
    const requestId = randomUUID(),
      began = process.hrtime.bigint();
    res.setHeader("X-Request-ID", requestId);
    const group = req.url?.startsWith("/v1/")
      ? "inference"
      : req.url?.startsWith("/api/agent/")
        ? "agent"
        : "api";
    let recorded = false;
    const record = (aborted: boolean) => {
      if (recorded) return;
      recorded = true;
      const durationMs = Number(process.hrtime.bigint() - began) / 1e6;
      operations.record(group, res.statusCode, durationMs, aborted);
      if (!aborted && res.statusCode >= 500)
        console.error(
          JSON.stringify({
            event: "http_error",
            requestId: String(res.getHeader("X-Request-ID")),
            group,
            status: res.statusCode,
            durationMs: Math.round(durationMs),
          }),
        );
    };
    res.once("finish", () => record(false));
    res.once("close", () => record(!res.writableFinished));
    try {
      const path = new URL(req.url || "/", "http://localhost").pathname,
        method = req.method || "GET";
      // Separate listeners enforce the audience; request headers cannot select it.
      if (audience === "user")
        check(!/^\/api\/(admin|provider)(?:\/|$)/.test(path), "Not found", 404, "not_found");
      if (audience === "admin")
        check(
          /^\/api\/admin(?:\/|$)/.test(path) ||
          ["/api/health", "/api/portal", "/api/state", "/api/auth/login", "/api/auth/logout", "/api/account/preferences"].includes(path),
          "Not found", 404, "not_found",
        );
      if (audience === "provider")
        check(/^\/api\/provider(?:\/|$)/.test(path) || ["/api/health","/api/portal","/api/state","/api/auth/login","/api/auth/register","/api/auth/logout","/api/account/preferences"].includes(path), "Not found",404,"not_found");
      if (method === "GET" && path === "/api/portal") {
        send(res, 200, {portal:audience, origin:options.certificates?.origin(audience === "legacy" ? "user" : audience)});
        return;
      }
      if (path !== "/api/health" && options.certificates?.origin(audience === "legacy" ? "user" : audience))
        check(req.headers["x-forwarded-proto"] === "https" && options.trustedProxyIps?.includes(req.socket.remoteAddress || ""),
          "HTTPS is required", 426, "https_required");
      if (
        !["GET", "HEAD"].includes(method) &&
        path !== "/api/payments/webhook"
      ) {
        const origin = req.headers.origin;
        check(
          !origin ||
            origin === publicOrigin(req),
          "不允许跨站请求。",
          403,
          "origin_rejected",
        );
      }
      if (path === "/api/admin/certificates" && method === "GET") {
        admin(req);
        send(res, 200, {available:!!options.certificates, data:options.certificates?.list() || []});
        return;
      }
      const certificatePath = path.match(/^\/api\/admin\/certificates\/(user|admin|provider)$/);
      if (certificatePath && method === "PUT") {
        const actor = admin(req).user;
        check(options.certificates, "Certificate management unavailable", 503, "certificate_unavailable");
        const result = await track(options.certificates.save(certificatePath[1] as "user"|"admin"|"provider", await body(req), actor.id));
        send(res, 200, {data:result});
        return;
      }
      if (method === "POST" && path === "/api/payments/webhook") {
        await track(payments.webhook(req));
        send(res, 200, { ok: true });
        return;
      }
      if (await handleProviders(req,res,path,method,{store,infrastructure,authenticate,admin,body,send})) return;
      if (method === "POST" && path === "/api/payments") {
        const { user } = authenticate(req),
          data = await body(req),
          key = requestKey(req.headers["idempotency-key"]);
        const payment = await track(payments.checkout(user, key, data));
        send(res, 201, { payment });
        return;
      }
      if (
        method === "GET" &&
        (path === "/api/payments" || path === "/api/admin/payments")
      ) {
        const user = path.includes("/admin/")
          ? admin(req).user
          : authenticate(req).user;
        send(
          res,
          200,
          payments.list(
            path.includes("/admin/") ? null : user.id,
            new URL(req.url!, "http://localhost").searchParams.get("before"),
          ),
        );
        return;
      }
      const paymentPath = path.match(/^\/api\/payments\/([a-f0-9-]+)$/);
      if (method === "GET" && paymentPath) {
        const { user } = authenticate(req),
          row = payments.row(paymentPath[1]);
        check(
          row && row.userId === user.id,
          "Payment not found",
          404,
          "not_found",
        );
        send(res, 200, { payment: payments.project(row) });
        return;
      }
      if (
        await infrastructure.handle(req, res, path, method, {
          admin,
          body,
          send,
        })
      )
        return;
      if (method === "GET" && path === "/api/health") {
        const ok = !operations.status().stale && !operations.controlFailed;
        send(res, ok ? 200 : 503, { ok });
        return;
      }
      if (method === "GET" && path === "/api/admin/operations") {
        admin(req);
        const query = new URL(req.url!, "http://localhost").searchParams;
        send(
          res,
          200,
          operations.list(query.get("state"), query.get("before")),
        );
        return;
      }
      const opsAction = path.match(
        /^\/api\/admin\/operations\/(alerts|notifications)\/([a-f0-9-]+)\/(ack|retry)$/,
      );
      if (method === "POST" && opsAction) {
        const actor = admin(req).user;
        if (opsAction[1] === "alerts" && opsAction[3] === "ack")
          operations.acknowledge(opsAction[2], actor.id);
        else if (opsAction[1] === "notifications" && opsAction[3] === "retry")
          operations.retry(opsAction[2]);
        else throw new HttpError(404, "Not found", "not_found");
        send(res, 200, { ok: true });
        return;
      }
      if (method === "GET" && path === "/api/state") {
        const auth = session(req);
        const snapshot=store.snapshot(auth?.user,auth?.csrf);
        if (audience==="provider") {
          snapshot.models=[];
          snapshot.servers=auth?.user.role==="provider"?ownedServers(store,infrastructure,auth.user.id):[];
        }
        send(res, 200, {
          ...snapshot,
          mailEnabled: !!options.mail,
          paymentsEnabled: !!options.stripe,
        });
        return;
      }
      if (
        method === "POST" &&
        [
          "/api/auth/forgot-password",
          "/api/auth/reset-password",
          "/api/auth/verify-email",
        ].includes(path)
      ) {
        const data = await body(req);
        store.limit(`mail:ip:${clientIp(req)}`, 30, 15 * 60000);
        if (path.endsWith("forgot-password")) {
          check(
            options.mail,
            "SMTP is not configured",
            503,
            "mail_unavailable",
          );
          const address = email(data.email),
            locale = data.locale ?? "zh-CN";
          check(
            locales.includes(locale as Locale),
            "Unsupported locale",
            400,
            "unsupported_locale",
            { field: "locale" },
          );
          store.limit(`mail:reset:${digest(address)}`, 3, 3600000);
          const found = store.get<UserRow>(
            "SELECT * FROM users WHERE email=?",
            address,
          );
          const user=found && store.user(found.id);
          // Respond identically before SMTP work to avoid revealing registered addresses.
          if (user && (audience === "legacy" || user.role === audience))
            void deliver(user, "reset", locale as Locale).catch(() =>
              console.error("Account reset email delivery failed"),
            );
          send(res, 200, { ok: true });
          return;
        }
        const purpose = path.endsWith("reset-password") ? "reset" : "verify";
        const candidate = accountToken(store, data.token, purpose);
        check(audience === "legacy" || store.user(candidate.userId)?.role === audience, "Invalid or expired link", 400, "invalid_mail_token");
        const hash =
          purpose === "reset"
            ? await authHash(() => hashPassword(password(data.password)))
            : null;
        store.transaction(() => {
          const row = accountToken(store, data.token, purpose);
          if (purpose === "reset") {
            store.run(
              "UPDATE users SET passwordHash=? WHERE id=?",
              hash!,
              row.userId,
            );
            store.run("DELETE FROM sessions WHERE userId=?", row.userId);
            store.run("DELETE FROM api_keys WHERE userId=?", row.userId);
            store.run("DELETE FROM account_tokens WHERE userId=?", row.userId);
          } else {
            store.run(
              "UPDATE users SET emailVerifiedAt=COALESCE(emailVerifiedAt,?) WHERE id=?",
              new Date().toISOString(),
              row.userId,
            );
            store.run(
              "DELETE FROM account_tokens WHERE tokenHash=?",
              row.tokenHash,
            );
          }
        });
        send(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && path === "/api/account/verification") {
        const { user } = authenticate(req);
        check(options.mail, "SMTP is not configured", 503, "mail_unavailable");
        if (!user.emailVerifiedAt) {
          store.limit(`mail:verify:${user.id}`, 1, 60000);
          store.limit(`mail:verify-hour:${user.id}`, 10, 3600000);
          try {
            await deliver(user, "verify", user.locale);
          } catch {
            throw new HttpError(
              503,
              "Unable to send email",
              "mail_unavailable",
            );
          }
        }
        send(res, 200, { ok: true });
        return;
      }
      if (
        method === "GET" &&
        (path === "/api/models" || path === "/v1/models")
      ) {
        send(res, 200, {
          object: "list",
          data: store.snapshot(session(req)?.user).models,
        });
        return;
      }
      if (
        method === "POST" &&
        (path === "/api/auth/register" || path === "/api/auth/login")
      ) {
        const data = await body(req),
          address = clientIp(req),
          emailAddress = email(data.email),
          pass = password(data.password);
        store.limit(`auth:${audience === "legacy" ? "" : audience + ":"}${address}`, 20, 15 * 60_000);
        if (path.endsWith("register")) {
          const name = text(data.name, "name", 40);
          check(
            !store.get("SELECT id FROM users WHERE email=?", emailAddress),
            "该邮箱已注册。",
            409,
            "email_exists",
          );
          const hash = await authHash(() => hashPassword(pass));
          const user = store.transaction(() => {
            check(
              !store.get("SELECT id FROM users WHERE email=?", emailAddress),
              "该邮箱已注册。",
              409,
              "email_exists",
            );
            return store.createUser(name, emailAddress, hash, audience === "provider" ? "provider" : "user");
          });
          send(res, 201, store.snapshot(user, setSession(req, res, user)));
          return;
        }
        const found = store.get<UserRow>(
          "SELECT * FROM users WHERE email=?",
          emailAddress,
        );
        const user = found && store.user(found.id);
        const valid = await authHash(() =>
          verifyPassword(
            pass,
            user?.passwordHash || `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`,
          ),
        );
        check(user && valid && (audience === "legacy" || user.role === audience), "邮箱或密码错误。", 401, "invalid_credentials");
        check(
          store.user(user.id)?.passwordHash === user.passwordHash,
          "邮箱或密码错误。",
          401,
          "invalid_credentials",
        );
        send(res, 200, store.snapshot(user, setSession(req, res, user)));
        return;
      }
      if (method === "POST" && path === "/api/auth/logout") {
        const auth = authenticate(req);
        store.run(
          "DELETE FROM sessions WHERE userId=? AND csrf=?",
          auth.user.id,
          auth.csrf,
        );
        res.setHeader(
          "Set-Cookie",
          `${cookieName(req)}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie(req) ? "; Secure" : ""}`,
        );
        send(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && path === "/v1/chat/completions") {
        const task = chat(req, res);
        inFlight.add(task);
        try {
          await task;
        } finally {
          inFlight.delete(task);
        }
        return;
      }
      if (method === "GET" && path === "/api/requests") {
        const { user } = authenticate(req, true),
          key = requestKey(
            new URL(req.url!, "http://localhost").searchParams.get("key"),
          );
        const r = store.get<RequestRow & { createdAt: string }>(
          "SELECT * FROM requests WHERE userId=? AND requestKey=?",
          user.id,
          key,
        );
        check(r, "Request not found", 404, "not_found");
        send(res, 200, {
          id: r.id,
          status: r.status,
          reserved: r.reserved,
          amount: r.amount,
          modelId: r.modelId,
          createdAt: r.createdAt,
          result: r.response ? JSON.parse(r.response) : null,
        });
        return;
      }
      if (method === "GET" && path === "/api/compute/offers") {
        authenticate(req);
        const control = new URL(
            publicOrigin(req),
          ),
          params = new URL(req.url!, "http://localhost").searchParams,
          hours = int(Number(params.get("hours") ?? 1), "hours", 1, 720),
          window = params.has("startsAt")
            ? reservationWindow(params.get("startsAt"), hours)
            : {
                start: Date.now(),
                end: Date.now() + SETUP_MS + hours * 3600000,
              };
        send(res, 200, {
          data: infrastructure.billing.offers(
            infrastructure,
            control.hostname,
            window,
          ),
        });
        return;
      }
      if (method === "POST" && path === "/api/compute/reservations") {
        const { user } = authenticate(req),
          data = await body(req),
          control = new URL(
            publicOrigin(req),
          );
        send(res, 202, {
          reservation: infrastructure.billing.reservations.book(
            infrastructure,
            user.id,
            requestKey(req.headers["idempotency-key"]),
            data,
            control.hostname,
          ),
        });
        return;
      }
      if (
        method === "GET" &&
        (path === "/api/compute/reservations" ||
          path === "/api/admin/compute/reservations")
      ) {
        const scope = path.includes("/admin/")
          ? null
          : authenticate(req).user.id;
        if (scope === null) admin(req);
        send(res, 200, {
          data: infrastructure.billing.reservations.list(scope),
        });
        return;
      }
      const reservationCancel = path.match(
        /^\/api\/(admin\/)?compute\/reservations\/([a-f0-9-]+)\/cancel$/,
      );
      if (method === "POST" && reservationCancel) {
        const isAdmin = !!reservationCancel[1],
          { user } = isAdmin ? admin(req) : authenticate(req),
          data = await body(req);
        send(res, 202, {
          reservation: infrastructure.billing.reservations.cancel(
            infrastructure,
            reservationCancel[2],
            user.id,
            isAdmin,
            data.reason,
          ),
        });
        return;
      }
      if (method === "POST" && path === "/api/compute/orders") {
        const { user } = authenticate(req),
          data = await body(req),
          control = new URL(
            publicOrigin(req),
          );
        send(res, 202, {
          order: infrastructure.billing.purchase(
            infrastructure,
            user.id,
            requestKey(req.headers["idempotency-key"]),
            data,
            control.hostname,
          ),
        });
        return;
      }
      if (method === "GET" && path === "/api/compute/orders") {
        const { user } = authenticate(req);
        send(res, 200, { data: infrastructure.billing.orders(user.id) });
        return;
      }
      const orderAction = path.match(
        /^\/api\/compute\/orders\/([a-f0-9-]+)\/(renew|cancel)$/,
      );
      if (method === "POST" && orderAction) {
        const { user } = authenticate(req),
          data = await body(req);
        send(
          res,
          202,
          infrastructure.billing.act(
            infrastructure,
            user.id,
            orderAction[1],
            orderAction[2] as "renew" | "cancel",
            requestKey(req.headers["idempotency-key"]),
            data,
          ),
        );
        return;
      }
      const accessPath = path.match(
        /^\/api\/compute\/rentals\/([a-f0-9-]+)\/access$/,
      );
      if (method === "POST" && accessPath) {
        const { user } = authenticate(req),
          d = infrastructure.dep(accessPath[1]),
          node = infrastructure.node(d.serverId);
        check(
          d.workloadType === "gpu-rental" && d.ownerId === user.id,
          "Workspace access denied",
          403,
          "forbidden",
        );
        check(
          infrastructure.billing.canAccess(d.id) &&
            d.phase === "ready" &&
            d.desiredState === "running" &&
            !!d.healthAt &&
            d.healthAt > Date.now() - 45000 &&
            infrastructure.online(node) &&
            JSON.parse(node.data).schedulingEnabled &&
            !node.inventoryError,
          "Workspace unavailable",
          503,
          "workspace_not_ready",
        );
        const endpoint = new URL(infrastructure.endpoint(d)),
          control = new URL(
            publicOrigin(req),
          ),
          spec = JSON.parse(d.spec),
          key = runtimeCredential(store,d.serverId,spec.apiKeyEnv);
        check(
          endpoint.hostname !== control.hostname,
          "Use an isolated workspace host",
          409,
          "workspace_host_required",
        );
        check(
          endpoint.protocol === "https:" ||
            process.env.NODE_ENV !== "production",
          "Workspace HTTPS required",
          400,
          "workspace_host_required",
        );
        check(key, "Workspace key missing", 503, "workspace_not_ready");
        endpoint.pathname = `/api/compute/rentals/${d.id}/lab/lab`;
        endpoint.searchParams.set(
          "token",
          createHmac("sha256", key)
            .update("corematrix-jupyter:" + d.id)
            .digest("hex"),
        );
        send(res, 200, { url: endpoint.href });
        return;
      }
      if (method === "PUT" && path === "/api/account/preferences") {
        const { user } = authenticate(req),
          data = await body(req);
        check(
          ["zh-CN", "en-US", "ja-JP", "ko-KR"].includes(String(data.locale)),
          "不支持此语言。",
          400,
          "unsupported_locale",
          { field: "locale" },
        );
        store.run(
          "UPDATE users SET locale=? WHERE id=?",
          String(data.locale),
          user.id,
        );
        send(res, 200, { locale: data.locale });
        return;
      }
      if (method === "PUT" && path === "/api/wallet/budget") {
        const { user } = authenticate(req),
          data = await body(req);
        store.run(
          "UPDATE users SET dailyBudget=? WHERE id=?",
          int(data.amount, "dailyBudget", MICRO, 100000 * MICRO),
          user.id,
        );
        send(res, 200, { ok: true });
        return;
      }
      if (path === "/api/keys" && ["POST", "DELETE"].includes(method)) {
        const { user } = authenticate(req);
        if (method === "DELETE") {
          store.run("DELETE FROM api_keys WHERE userId=?", user.id);
          send(res, 200, { ok: true });
          return;
        }
        const token = "cm_" + secret();
        store.transaction(() => {
          store.run("DELETE FROM api_keys WHERE userId=?", user.id);
          store.run(
            "INSERT INTO api_keys VALUES(?,?,?)",
            digest(token),
            user.id,
            token.slice(0, 11),
          );
        });
        send(res, 201, { key: token });
        return;
      }
      if (method === "GET" && path === "/api/wallet/bills") {
        const auth = authenticate(req),
          params = new URL(req.url!, "http://localhost").searchParams;
        const before = params.has("before")
          ? int(
              Number(params.get("before")),
              "before",
              1,
              Number.MAX_SAFE_INTEGER,
            )
          : undefined;
        const type = params.get("type") ?? "all";
        check(
          [
            "all",
            "token",
            "recharge",
            "compute",
            "compute_refund",
            "recharge_refund",
          ].includes(type),
          "Invalid bill type",
          400,
          "invalid_request",
        );
        send(
          res,
          200,
          store.bills(
            auth.user.id,
            before,
            type === "all" ? undefined : (type as Bill["type"]),
          ),
        );
        return;
      }
      if (method === "GET" && path === "/api/wallet") {
        const auth = authenticate(req),
          s = store.snapshot(auth.user);
        send(res, 200, {
          balance: s.balance,
          heldBalance: s.heldBalance,
          paymentDebt: s.paymentDebt,
          paymentReview: s.paymentReview,
          dailyBudget: s.dailyBudget,
          todaySpend: s.tokenSpend,
          bills: s.bills,
        });
        return;
      }
      if (method === "GET" && path === "/api/admin/models") {
        const auth = admin(req);
        send(res, 200, { data: store.snapshot(auth.user).models });
        return;
      }
      if (method === "POST" && path === "/api/admin/models") {
        admin(req);
        const model = validateModel(await body(req), origins);
        check(
          !store.get("SELECT id FROM models WHERE id=?", model.id),
          "模型 ID 已存在（含已删除模型）。",
          409,
        );
        store.run(
          "INSERT INTO models(id,data) VALUES(?,?)",
          model.id,
          JSON.stringify(model),
        );
        send(res, 201, model);
        return;
      }
      const modelPath = path.match(/^\/api\/admin\/models\/([a-zA-Z0-9._-]+)$/);
      if (modelPath && ["PUT", "DELETE"].includes(method)) {
        admin(req);
        const existing = store.model(modelPath[1]);
        check(existing, "模型不存在。", 404);
        if (method === "DELETE") {
          check(
            !store.get(
              "SELECT 1 FROM deployments WHERE modelId=? AND phase!='stopped'",
              existing.id,
            ),
            "Model in use",
            409,
            "model_in_use",
          );
          store.run("UPDATE models SET deleted=1 WHERE id=?", existing.id);
          send(res, 200, { ok: true });
          return;
        }
        const model = validateModel(await body(req), origins);
        check(model.id === existing.id, "模型 ID 不可修改。");
        store.run(
          "UPDATE models SET data=? WHERE id=?",
          JSON.stringify(model),
          existing.id,
        );
        send(res, 200, model);
        return;
      }
      if (method === "GET" && path === "/api/admin/reports") {
        admin(req);
        send(
          res,
          200,
          financeReport(
            store,
            new URL(req.url!, "http://localhost").searchParams,
          ),
        );
        return;
      }
      if (method === "GET" && path === "/api/admin/reconciliation") {
        admin(req);
        send(res, 200, reconcile(store));
        return;
      }
      if (method === "POST" && path === "/api/admin/costs") {
        const { user } = admin(req);
        send(res, 201, {
          expense: recordExpense(store, user.id, await body(req)),
        });
        return;
      }
      const voidCost = path.match(/^\/api\/admin\/costs\/([a-f0-9-]+)\/void$/);
      if (method === "POST" && voidCost) {
        const { user } = admin(req);
        send(res, 200, {
          expense: voidExpense(store, user.id, voidCost[1], await body(req)),
        });
        return;
      }
      if (method === "POST" && path === "/api/admin/credits") {
        const { user: actor } = admin(req),
          data = await body(req),
          emailAddress = email(data.email),
          amount = int(data.amount, "amount", 1, 100000 * MICRO),
          reason = text(data.reason, "reason", 200),
          reference = requestKey(data.reference, "reference");
        store.transaction(() => {
          const user = store.get<UserRow>(
            "SELECT * FROM users WHERE email=?",
            emailAddress,
          );
          check(user, "用户不存在。", 404);
          const previous = store.get<{
            userId: string;
            amount: number;
            quantity: string;
          }>(
            "SELECT userId,amount,quantity FROM ledger WHERE reference=?",
            reference,
          );
          if (previous) {
            check(
              previous.userId === user.id &&
                previous.amount === amount &&
                previous.quantity === reason,
              "相同入账编号的内容不一致。",
              409,
            );
            return;
          }
          check(
            BigInt(user.balance) +
              BigInt(amount) +
              BigInt(
                store.get<{ value: number }>(
                  "SELECT COALESCE(SUM(charged-refunded),0) value FROM rental_orders WHERE userId=? AND closedAt IS NULL",
                  user.id,
                )!.value,
              ) <=
              BigInt(Number.MAX_SAFE_INTEGER),
            "余额超出安全范围。",
          );
          store.run(
            "UPDATE users SET balance=balance+? WHERE id=?",
            amount,
            user.id,
          );
          store.run(
            `INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day,reference,actorId,metadata) VALUES(?,?,'recharge','管理员人工入账',?,?,?,?,?,?,?)`,
            randomUUID(),
            user.id,
            reason,
            amount,
            new Date().toISOString(),
            day(),
            reference,
            actor.id,
            JSON.stringify({ reason }),
          );
        });
        send(res, 200, { ok: true });
        return;
      }
      throw new HttpError(404, "接口不存在。", "not_found");
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError)
        send(res, e.status, {
          error: {
            code: e.code,
            message: e.message,
            ...(e.details ? { details: e.details } : {}),
          },
          requestId: res.getHeader("X-Request-ID"),
        });
      else {
        console.error(
          "API request failed:",
          e instanceof Error ? e.name : "unknown",
        );
        send(res, 500, {
          requestId: res.getHeader("X-Request-ID"),
          error: {
            code: "internal_error",
            message: "服务暂时不可用，请稍后重试。",
          },
        });
      }
    }
  }
  const server = createServer((req, res) => void handle(req, res, options.splitPortals ? "user" : "legacy"));
  const adminServer = options.splitPortals
    ? createServer((req, res) => void handle(req, res, "admin"))
    : undefined;
  const providerServer = options.splitPortals
    ? createServer((req,res) => void handle(req,res,"provider"))
    : undefined;
  let timer: ReturnType<typeof setInterval>,
    monitorTimer: ReturnType<typeof setInterval>;
  function checkOperations() {
    try {
      operations.scan();
    } catch {
      console.error("Operations scan failed");
    }
    void track(operations.flush()).catch(() =>
      console.error("Operations delivery failed"),
    );
  }
  function controlTick() {
    try {
      infrastructure.tick();
      operations.controlFailed = false;
    } catch {
      operations.controlFailed = true;
      console.error("Infrastructure tick failed");
    }
  }
  server.once("listening", () => {
    store.recoverInterruptedRequests();
    controlTick();
    checkOperations();
    timer = setInterval(() => {
      controlTick();
      void track(operations.flush()).catch(() =>
        console.error("Operations delivery failed"),
      );
    }, 15000);
    monitorTimer = setInterval(checkOperations, 60000);
    monitorTimer.unref();
    timer.unref();
  });
  server.once("close", () => {
    clearInterval(timer);
    clearInterval(monitorTimer);
    infrastructure.disposed = true;
  });
  server.requestTimeout = 90000;
  server.headersTimeout = 15000;
  if (adminServer) {
    adminServer.requestTimeout = server.requestTimeout;
    adminServer.headersTimeout = server.headersTimeout;
  }
  if (providerServer) {
    providerServer.requestTimeout = server.requestTimeout;
    providerServer.headersTimeout = server.headersTimeout;
  }
  return {
    server,
    adminServer,
    providerServer,
    store,
    operations,
    async drain() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
  };
}
