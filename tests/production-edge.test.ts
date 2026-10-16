import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { execFile, execFileSync } from "node:child_process";
import { promisify, parseEnv } from "node:util";
import { createServer as httpServer, request as httpRequest } from "node:http";
import {
  createServer as httpsServer,
  request as httpsRequest,
} from "node:https";
import { createApplication } from "../server/app.ts";
import { runtimeFromEnv } from "../server/runtime-config.ts";

async function close(server: any) {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

test("production entry point rejects invalid configuration before creating the database", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cm-startup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = promisify(execFile);
  for (const origin of [
    "",
    "http://console.tests.invalid",
    "https://PRIVATE_SECRET@console.tests.invalid",
  ]) {
    const path = join(dir, "not-created.sqlite");
    await assert.rejects(
      run(process.execPath, ["server/index.ts"], {
        env: {
          ...process.env,
          NODE_ENV: "production",
          DATABASE_PATH: path,
          PUBLIC_ORIGIN: origin,
          SMTP_HOST: "",
          STRIPE_SECRET_KEY: "",
          OPS_ALERT_EMAIL: "",
        },
      }),
      (e) => {
        assert.equal((e as any).code, 1);
        assert(!String((e as any).stderr).includes("PRIVATE_SECRET"));
        return true;
      },
    );
    assert.equal(existsSync(path), false);
  }
});

test("deployment examples agree on the public origin, API port, release path and persistent state", () => {
  const env = parseEnv(
      readFileSync("deploy/corematrix-api.env.example", "utf8"),
    ),
    config = runtimeFromEnv(env),
    unit = readFileSync("deploy/corematrix-api.service", "utf8"),
    nginx = readFileSync("deploy/nginx-console.conf.example", "utf8");
  const working = unit.match(/^WorkingDirectory=(.+)$/m)![1],
    writePath = unit.match(/^ReadWritePaths=(.+)$/m)![1];
  assert.equal(config.secureCookie, true);
  assert(config.databasePath.startsWith(writePath + "/"));
  assert(nginx.includes("root " + working + "/dist;"));
  assert(nginx.includes("http://127.0.0.1:" + config.port + ";"));
  assert(
    nginx.includes(
      "server_name " + new URL(config.publicOrigin!).hostname + ";",
    ),
  );
});

test("API works behind a certificate-verified TLS edge with Secure cookies, origin checks, cleaned forwarding and incremental SSE", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cm-tls-edge-")),
    keyPath = join(dir, "key.pem"),
    certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "pipe" },
  );
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath),
    cert = readFileSync(certPath);
  let endStream: () => void = () => {};
  const upstream = httpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.stream_options.include_usage, true);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      "data: " +
        JSON.stringify({
          id: "upstream",
          choices: [
            { index: 0, delta: { content: "hello" }, finish_reason: null },
          ],
        }) +
        "\n\n",
    );
    endStream = () =>
      res.end(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }) +
          "\n\ndata: " +
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }) +
          "\n\ndata: [DONE]\n\n",
      );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  let apiPort = 0;
  const edge = httpsServer({ key, cert }, (req, res) => {
    const proxy = httpRequest(
      {
        hostname: "127.0.0.1",
        port: apiPort,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          "x-forwarded-for": req.socket.remoteAddress!,
          "x-forwarded-proto": "https",
          forwarded: "",
          "x-real-ip": "",
        },
      },
      (up) => {
        res.writeHead(up.statusCode!, up.headers);
        up.pipe(res);
      },
    );
    proxy.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(proxy);
  });
  edge.listen(0, "127.0.0.1");
  await once(edge, "listening");
  const edgePort = (edge.address() as any).port,
    origin = `https://127.0.0.1:${edgePort}`;
  const { port: _, ...runtime } = runtimeFromEnv({
      NODE_ENV: "production",
      DATABASE_PATH: join(dir, "test.sqlite"),
      PUBLIC_ORIGIN: origin,
      TRUSTED_PROXY_IPS: "127.0.0.1",
      INFERENCE_ALLOWED_ORIGINS: `http://127.0.0.1:${(upstream.address() as any).port}`,
    }),
    app = createApplication(runtime);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  apiPort = (app.server.address() as any).port;
  t.after(async () => {
    endStream();
    await close(edge);
    await close(app.server);
    await app.drain();
    app.store.close();
    await close(upstream);
    rmSync(dir, { recursive: true, force: true });
  });
  function call(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    trusted = true,
    method = body === undefined ? "GET" : "POST",
  ) {
    return new Promise<{
      status: number;
      headers: Record<string, any>;
      body: any;
    }>((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: "127.0.0.1",
          servername: "localhost",
          port: edgePort,
          path,
          method,
          ...(trusted ? { ca: cert } : {}),
          headers: {
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  await assert.rejects(call("/api/health", undefined, {}, false), (e) => {
    assert.match((e as any).code, /SELF_SIGNED/);
    return true;
  });
  assert.equal((await call("/api/health")).status, 200);
  const registered = await call(
    "/api/auth/register",
    {
      name: "TLS user",
      email: "tls@tests.invalid",
      password: "tls-test-password-123",
    },
    { Origin: origin, "X-Forwarded-For": "198.51.100.99" },
  );
  assert.equal(registered.status, 201);
  const setCookie = registered.headers["set-cookie"][0];
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(";")[0],
    csrf = registered.body.csrfToken;
  assert.equal(
    (await call("/api/state", undefined, { Cookie: cookie })).body.user.id,
    registered.body.user.id,
  );
  assert.equal(
    app.store.get("SELECT 1 FROM rate_limits WHERE key='auth:198.51.100.99'"),
    undefined,
  );
  assert(app.store.get("SELECT 1 FROM rate_limits WHERE key='auth:127.0.0.1'"));
  const rejected = await call(
    "/api/wallet/budget",
    { amount: 1000000 },
    {
      Origin: "https://attacker.tests.invalid",
      Cookie: cookie,
      "X-CSRF-Token": csrf,
      "X-Forwarded-Host": "attacker.tests.invalid",
    },
    true,
    "PUT",
  );
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error.code, "origin_rejected");
  const missingCsrf = await call(
    "/api/wallet/budget",
    { amount: 1000000 },
    { Origin: origin, Cookie: cookie },
    true,
    "PUT",
  );
  assert.equal(missingCsrf.body.error.code, "csrf_failed");
  assert.equal(
    (
      await call(
        "/api/wallet/budget",
        { amount: 1000000 },
        { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf },
        true,
        "PUT",
      )
    ).status,
    200,
  );
  const invalid = await call(
    "/api/auth/login",
    { email: "bad", password: "tls-test-password-123" },
    { Origin: origin },
  );
  assert.equal(invalid.body.error.code, "invalid_email");
  assert.equal(invalid.headers["x-request-id"], invalid.body.requestId);
  const model = {
    ...app.store.model("qwen2.5-7b")!,
    id: "tls-model",
    enabled: true,
    inputPrice: 0,
    outputPrice: 0,
    contextTokens: 4,
    maxOutputTokens: 4,
    upstreamUrl: runtime.allowedOrigins[0] + "/v1/chat/completions",
    upstreamModel: "upstream",
  };
  app.store.run(
    "INSERT INTO models(id,data) VALUES(?,?)",
    model.id,
    JSON.stringify(model),
  );
  let first!: () => void,
    text = "",
    responseId = "";
  const firstChunk = new Promise<void>((r) => (first = r));
  const done = new Promise<void>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: "127.0.0.1",
        servername: "localhost",
        port: edgePort,
        path: "/v1/chat/completions",
        method: "POST",
        ca: cert,
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "Idempotency-Key": "tls-stream-request",
        },
      },
      (res) => {
        assert.equal(res.statusCode, 200);
        responseId = String(res.headers["x-request-id"]);
        res.on("data", (chunk) => {
          text += chunk.toString();
          if (text.includes("hello")) first();
        });
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end(
      JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "Test" }],
        max_tokens: 2,
        stream: true,
      }),
    );
  });
  await Promise.race([
    firstChunk,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error("Stream buffered")), 5000);
      timer.unref();
    }),
  ]);
  assert(!text.includes("[DONE]"));
  endStream();
  await done;
  const billingFrame = text
    .split("\n\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)))
    .find((frame) => frame.billing);
  assert.equal(billingFrame?.billing.amount, 0);
  assert(text.includes("[DONE]"));
  assert.equal(
    app.store.get<{ id: string }>("SELECT id FROM requests")!.id,
    responseId,
  );
  assert.equal(
    app.store.get<{ count: number }>(
      "SELECT COUNT(*) count FROM ledger WHERE type='token'",
    )!.count,
    1,
  );
});
