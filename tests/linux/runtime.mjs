import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

assert.equal(process.getuid(), 1001);
for (const path of [
  "/opt/corematrix/current/qa-write-denied",
  "/etc/qa-write-denied",
]) {
  assert.throws(
    () => writeFileSync(path, "denied"),
    (e) => ["EROFS", "EACCES"].includes(e.code),
  );
}
const database = "/var/lib/corematrix/runtime.sqlite",
  origin = "https://console.tests.invalid";
let child;
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child,
    exited = once(current, "exit");
  current.kill("SIGTERM");
  const timer = setTimeout(() => current.kill("SIGKILL"), 8000);
  try {
    assert.deepEqual(await exited, [0, null]);
  } finally {
    clearTimeout(timer);
  }
}
async function start() {
  child = spawn("/usr/bin/node", ["server/index.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_PATH: database,
      PUBLIC_ORIGIN: origin,
      ADMIN_PUBLIC_ORIGIN: "https://admin.tests.invalid",
      ADMIN_API_PORT: "3002",
      PROVIDER_API_PORT: "3003",
      PROVIDER_PUBLIC_ORIGIN: "https://supplier.tests.invalid",
      API_PORT: "3001",
      SMTP_HOST: "",
      STRIPE_SECRET_KEY: "",
      OPS_ALERT_EMAIL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    assert.equal(
      child.exitCode,
      null,
      "production API exited before readiness",
    );
    try {
      if (
        (
          await fetch("http://127.0.0.1:3001/api/health", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        return;
    } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("production API did not become ready");
}
async function call(path, method = "GET", body, headers = {}) {
  const admin = headers["X-Test-Admin"] === "1";
  delete headers["X-Test-Admin"];
  const response = await fetch(`http://127.0.0.1:${admin ? 3002 : 3001}` + path, {
    method,
    signal: AbortSignal.timeout(5000),
    headers: {
      ...(body ? { "Content-Type": "application/json", Origin: admin ? "https://admin.tests.invalid" : origin } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    headers: response.headers,
    data: await response.json(),
  };
}
try {
  const run = promisify(execFile),
    adminPassword = "linux-admin-test-password-123";
  const adminEnv = {
    ...process.env,
    DATABASE_PATH: database,
    ADMIN_EMAIL: "linux-admin@tests.invalid",
    ADMIN_PASSWORD: adminPassword,
  };
  await run("/usr/bin/node", ["server/create-admin.ts"], {
    env: adminEnv,
    timeout: 10000,
  });
  const beforeDb = new DatabaseSync(database, { readOnly: true });
  const initialAdmin = beforeDb
    .prepare("SELECT id,role,passwordHash,balance FROM users WHERE email=?")
    .get(adminEnv.ADMIN_EMAIL);
  beforeDb.close();
  assert.equal(initialAdmin.role, "admin");
  assert.equal(initialAdmin.balance, 0);
  assert.match(initialAdmin.passwordHash, /^scrypt\$/);
  await assert.rejects(
    run("/usr/bin/node", ["server/create-admin.ts"], {
      env: adminEnv,
      timeout: 10000,
    }),
    (e) => e.code === 1 && !e.stderr.includes(adminPassword),
  );
  const afterDb = new DatabaseSync(database, { readOnly: true });
  assert.deepEqual(
    afterDb
      .prepare("SELECT id,role,passwordHash,balance FROM users WHERE email=?")
      .get(adminEnv.ADMIN_EMAIL),
    initialAdmin,
  );
  afterDb.close();
  await start();
  const adminLogin = await call("/api/auth/login", "POST", {
    email: adminEnv.ADMIN_EMAIL,
    password: adminPassword,
  }, { "X-Test-Admin": "1" });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.data.user.role, "admin");
  assert.equal(
    (
      await call("/api/admin/servers", "GET", undefined, {
        Cookie: adminLogin.headers.get("set-cookie").split(";")[0],
        "X-Test-Admin": "1",
      })
    ).status,
    200,
  );
  const registered = await call("/api/auth/register", "POST", {
    name: "Linux fixture",
    email: "linux@tests.invalid",
    password: "linux-test-password-123",
    role: "admin",
    balance: 999999,
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.user.role, "user");
  assert.equal(registered.data.balance, 0);
  const rawCookie = registered.headers.get("set-cookie");
  assert.match(rawCookie, /HttpOnly/);
  assert.match(rawCookie, /SameSite=Lax/);
  assert.match(rawCookie, /; Secure/);
  const cookie = rawCookie.split(";")[0],
    headers = { Cookie: cookie, "X-CSRF-Token": registered.data.csrfToken };
  for (const locale of ["zh-CN", "en-US", "ja-JP", "ko-KR"]) {
    assert.equal(
      (await call("/api/account/preferences", "PUT", { locale }, headers))
        .status,
      200,
    );
    assert.equal(
      (await call("/api/state", "GET", undefined, headers)).data.user.locale,
      locale,
    );
  }
  assert.equal(
    (await call("/api/admin/servers", "GET", undefined, headers)).status,
    404,
  );
  assert.deepEqual(
    (await call("/api/wallet/bills", "GET", undefined, headers)).data,
    { data: [], nextCursor: null },
  );
  await stop();
  assert.equal(statSync(database).mode & 0o777, 0o600);
  assert.equal(statSync(database).uid, 1001);
  assert.equal(statSync(database).gid, 1001);
  const db = new DatabaseSync(database, { readOnly: true });
  const user = db
    .prepare(
      "SELECT role,passwordHash,balance FROM users WHERE email='linux@tests.invalid'",
    )
    .get();
  assert.equal(user.role, "user");
  assert.match(user.passwordHash, /^scrypt\$/);
  assert.equal(user.balance, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 0);
  db.close();
  await assert.rejects(
    run("/usr/bin/node", ["server/create-admin.ts"], {
      env: { ...adminEnv, ADMIN_EMAIL: "linux@tests.invalid" },
      timeout: 10000,
    }),
    (e) => e.code === 1,
  );
  const unchanged = new DatabaseSync(database, { readOnly: true });
  assert.deepEqual(
    unchanged
      .prepare(
        "SELECT role,passwordHash,balance FROM users WHERE email='linux@tests.invalid'",
      )
      .get(),
    user,
  );
  unchanged.close();
  await start();
  const state = await call("/api/state", "GET", undefined, headers);
  assert.equal(state.data.user.id, registered.data.user.id);
  assert.equal(state.data.user.locale, "ko-KR");
  assert.equal(state.data.balance, 0);
  assert.equal(
    (await call("/api/auth/logout", "POST", {}, headers)).status,
    200,
  );
  assert.equal(
    (await call("/api/state", "GET", undefined, headers)).data.user,
    null,
  );
  await stop();
  console.log(
    "PASS: Linux production entry, non-root admin initialization with no overwrite or promotion, read-only code, private SQLite, registration/roles/cookies, four locales, restart/session persistence and graceful shutdown. Isolated tmpfs data only.",
  );
} finally {
  await stop();
}
