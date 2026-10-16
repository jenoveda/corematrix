import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  chmodSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.ts";
import { hashPassword, digest, secret } from "../server/auth.ts";
import { inspectDatabase, snapshotDatabase } from "../server/database-tools.ts";
import { createApplication } from "../server/app.ts";
import { LATEST_SCHEMA_VERSION } from "../server/migrations.ts";

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "cm-backup-")),
    path = join(dir, "source.sqlite"),
    s = new Store(path);
  s.db.exec("PRAGMA wal_autocheckpoint=0");
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path, s };
}
function fund(s: Store, userId: string, amount: number) {
  s.transaction(() => {
    s.run("UPDATE users SET balance=balance+? WHERE id=?", amount, userId);
    s.run(
      "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES(?,?,'recharge','Test','Test',?,?,?)",
      randomUUID(),
      userId,
      amount,
      new Date().toISOString(),
      "2026-10-16",
    );
  });
}
function records(s: Store) {
  return JSON.stringify(
    [
      "users",
      "ledger",
      "requests",
      "sessions",
      "api_keys",
      "gpu_allocations",
      "port_allocations",
      "deployments",
      "rental_orders",
      "rental_reservations",
      "payment_orders",
      "ops_alerts",
      "ops_notifications",
    ].map((table) => s.all(`SELECT * FROM ${table} ORDER BY rowid`)),
  );
}

test("live WAL backup and restore preserve identities, funds, frozen orders and physical claims", async (t) => {
  const { dir, path, s } = fixture(t),
    password = "restored-test-password-123",
    user = s.createUser(
      "日本語 한국어",
      "restore@tests.invalid",
      await hashPassword(password),
      "admin",
    );
  fund(s, user.id, 20000000);
  const session = secret(),
    key = "cm_" + secret();
  s.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    digest(session),
    user.id,
    secret(),
    Date.now() + 3600000,
  );
  s.run("INSERT INTO api_keys VALUES(?,?,?)", digest(key), user.id, "cm_test");
  s.run(
    "INSERT INTO requests(id,userId,requestKey,fingerprint,day,status,reserved,modelId,modelName,inputPrice,outputPrice,createdAt) VALUES(?,?,?,?,'2026-10-16','pending',5000000,'qwen3-32b','Test',0,0,?)",
    randomUUID(),
    user.id,
    randomUUID(),
    "test",
    new Date().toISOString(),
  );
  const node = randomUUID(),
    d = randomUUID(),
    order = randomUUID(),
    reservation = randomUUID();
  s.run(
    "INSERT INTO servers(id,data,tokenHash) VALUES(?,?,?)",
    node,
    JSON.stringify({
      name: "Offline fixture",
      workMode: "gpu-rental",
      schedulingEnabled: true,
      maintenance: false,
    }),
    digest(secret()),
  );
  s.run(
    "INSERT INTO deployments(id,serverId,modelId,phase,spec,actorId,requestKey,fingerprint,createdAt,workloadType,ownerId) VALUES(?,?,'__gpu-rental__','queued','{}',?,?,?,?,'gpu-rental',?)",
    d,
    node,
    user.id,
    randomUUID(),
    "test",
    Date.now(),
    user.id,
  );
  s.run(
    "UPDATE deployments SET spec=? WHERE id=?",
    JSON.stringify({
      gpuUuids: ["GPU-test"],
      endpointPort: 8000,
      workloadType: "gpu-rental",
    }),
    d,
  );
  s.run("INSERT INTO gpu_allocations VALUES(?,?,?,0)", d, node, "GPU-test");
  s.run("INSERT INTO port_allocations VALUES(?,?,8000,0)", d, node);
  s.run(
    "INSERT INTO rental_orders(id,userId,deploymentId,offerId,resource,cards,hours,hourlyPrice,amount,reserved,status,createdAt,requestKey,fingerprint) VALUES(?,?,?,'test','Test GPU',1,1,2000000,2000000,2000000,'provisioning',?,?,?)",
    order,
    user.id,
    d,
    Date.now(),
    randomUUID(),
    "test",
  );
  s.run(
    "INSERT INTO rental_reservations(id,userId,serverId,serverName,offerId,resource,memoryMiB,cards,hours,hourlyPrice,amount,reserved,status,gpuUuids,port,startsAt,endsAt,createdAt,requestKey,fingerprint) VALUES(?,?,?,'Offline fixture','test','Test GPU',24000,1,1,3000000,3000000,3000000,'booked','[\"GPU-other\"]',8001,?,?,?,?,?)",
    reservation,
    user.id,
    node,
    Date.now() + 3600000,
    Date.now() + 7200000,
    Date.now(),
    randomUUID(),
    "test",
  );
  assert(existsSync(path + "-wal"));
  const before = records(s),
    copy = join(dir, "archive.sqlite"),
    restored = join(dir, "restored.sqlite");
  const report = await snapshotDatabase(path, copy);
  assert.equal(report.pendingRequests, 1);
  assert.equal(report.activeGpuClaims, 1);
  assert.equal(report.reconciliation?.healthy, true);
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  await snapshotDatabase(copy, restored);
  const r = new Store(restored, false, { readOnly: true });
  assert.equal(records(r), before);
  r.close();
  assert.equal(records(s), before);
  const app = createApplication({ databasePath: restored });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise<void>((done) => app.server.close(() => done()));
    await app.drain();
    app.store.close();
  });
  const response = await fetch(
    "http://127.0.0.1:" +
      (app.server.address() as any).port +
      "/api/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password }),
    },
  );
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.user.id, user.id);
  assert.equal(state.user.role, "admin");
  assert.equal(app.store.user(user.id)!.balance, 20000000);
  assert.equal(app.store.held(user.id), 5000000);
  assert.equal(
    app.store.get<{ status: string }>("SELECT status FROM requests")!.status,
    "failed",
  );
  assert.equal(
    app.store.get<{ released: number }>("SELECT released FROM gpu_allocations")!
      .released,
    0,
  );
  assert.equal(records(s), before);
  assert.equal(inspectDatabase(restored).reconciliation?.healthy, true);
});

test("snapshots refuse existing targets, symlinks, leftover journals and competing publication", async (t) => {
  const { dir, path } = fixture(t),
    existing = join(dir, "existing.sqlite"),
    link = join(dir, "link.sqlite"),
    dangling = join(dir, "dangling.sqlite");
  writeFileSync(existing, "original");
  symlinkSync(existing, link);
  symlinkSync(join(dir, "missing"), dangling);
  for (const target of [path, existing, link, dangling])
    await assert.rejects(snapshotDatabase(path, target), /target_exists/);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const target = join(dir, "leftover" + suffix + ".sqlite");
    writeFileSync(target + suffix, "original");
    await assert.rejects(snapshotDatabase(path, target), /target_exists/);
    assert.equal(readFileSync(target + suffix, "utf8"), "original");
  }
  const target = join(dir, "competing.sqlite"),
    result = await Promise.allSettled([
      snapshotDatabase(path, target),
      snapshotDatabase(path, target),
    ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(result.filter((r) => r.status === "rejected").length, 1);
  assert.equal(inspectDatabase(target).integrity, "ok");
  assert.equal(readFileSync(existing, "utf8"), "original");
  assert.equal(
    readdirSync(dir).filter((n) => n.startsWith(".corematrix-backup-")).length,
    0,
  );
});

test("invalid sources and foreign-key corruption fail without publishing or changing originals", async (t) => {
  const { dir, path, s } = fixture(t),
    bad = join(dir, "bad.sqlite"),
    other = join(dir, "other.sqlite"),
    future = join(dir, "future.sqlite");
  writeFileSync(bad, "not SQLite PRIVATE_SOURCE_TEXT");
  const db = new DatabaseSync(other);
  db.exec("CREATE TABLE example(id)");
  db.close();
  for (const [source, pattern] of [
    [bad, /./],
    [other, /not_corematrix/],
    [join(dir, "missing"), /./],
  ] as const) {
    const target = source + ".copy";
    await assert.rejects(snapshotDatabase(source, target), pattern);
    assert.equal(existsSync(target), false);
  }
  const fs = new Store(future);
  fs.run(
    "INSERT INTO schema_migrations VALUES(?,?)",
    LATEST_SCHEMA_VERSION + 1,
    new Date().toISOString(),
  );
  fs.close();
  await assert.rejects(
    snapshotDatabase(future, future + ".copy"),
    /unsupported_schema/,
  );
  s.db.exec("PRAGMA foreign_keys=OFF");
  s.run(
    "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES('orphan','missing','recharge','Test','Test',1,'now','2026-10-16')",
  );
  await assert.rejects(
    snapshotDatabase(path, path + ".copy"),
    /foreign_keys_failed/,
  );
  assert.equal(
    s.get<{ count: number }>("SELECT COUNT(*) count FROM ledger")!.count,
    1,
  );
  assert.equal(readFileSync(bad, "utf8"), "not SQLite PRIVATE_SOURCE_TEXT");
  assert.equal(
    readdirSync(dir).filter((n) => n.startsWith(".corematrix-backup-")).length,
    0,
  );
});

test("inspection is genuinely read-only, preserves debt and expired credentials, and does not migrate", async (t) => {
  const { dir, path, s } = fixture(t),
    u = s.createUser("Buyer", "buyer@tests.invalid", "PRIVATE_HASH");
  s.run("UPDATE users SET balance=100,paymentDebt=10 WHERE id=?", u.id);
  s.run(
    "INSERT INTO sessions VALUES(?,?,?,0)",
    digest(secret()),
    u.id,
    secret(),
  );
  chmodSync(path, 0o640);
  const before = records(s),
    reader = new Store(path, false, { readOnly: true });
  assert.throws(() => reader.run("UPDATE users SET balance=0"));
  reader.close();
  const report = inspectDatabase(path);
  assert.equal(report.reconciliation?.healthy, false);
  assert.equal(report.reconciliation?.issueCounts.payment_debt, 1);
  assert.equal(records(s), before);
  const copy = await snapshotDatabase(path, join(dir, "debt.sqlite"));
  assert.equal(statSync(path).mode & 0o777, 0o640);
  assert.equal(copy.reconciliation?.healthy, false);
  assert.equal(records(s), before);
  s.run("DELETE FROM schema_migrations WHERE version=?", LATEST_SCHEMA_VERSION);
  const legacy = inspectDatabase(path);
  assert.equal(legacy.needsMigration, true);
  assert.equal(legacy.reconciliation, null);
  assert.equal(
    s.get<{ count: number }>(
      "SELECT COUNT(*) count FROM schema_migrations WHERE version=?",
      LATEST_SCHEMA_VERSION,
    )!.count,
    0,
  );
  assert(!JSON.stringify(report).includes(u.email));
  assert(!JSON.stringify(report).includes("PRIVATE_HASH"));
});

test("backup remains transactionally consistent while a second connection updates the live WAL", async (t) => {
  const { dir, path, s } = fixture(t),
    u = s.createUser("Buyer", "buyer@tests.invalid", "unused");
  fund(s, u.id, 1000);
  s.db.exec("CREATE TABLE backup_padding(data TEXT)");
  const insert = s.db.prepare("INSERT INTO backup_padding VALUES(?)");
  for (let i = 0; i < 300; i++) insert.run("x".repeat(10000));
  const task = snapshotDatabase(path, join(dir, "concurrent.sqlite"));
  for (let i = 0; i < 20; i++) {
    fund(s, u.id, 1);
    await new Promise((r) => setTimeout(r, 1));
  }
  const report = await task;
  assert.equal(report.reconciliation?.healthy, true);
  const copy = new Store(report.path, false, { readOnly: true });
  const amount = copy.user(u.id)!.balance,
    sum = copy.get<{ amount: number }>(
      "SELECT SUM(amount) amount FROM ledger",
    )!.amount;
  copy.close();
  assert.equal(amount, sum);
  assert(amount >= 1000 && amount <= 1020);
});

test("database CLI produces private snapshots and concise verification results without credentials", async (t) => {
  const { dir, path, s } = fixture(t),
    u = s.createUser("Buyer", "buyer@tests.invalid", "PRIVATE_HASH");
  fund(s, u.id, 1000);
  const run = promisify(execFile),
    script = join(process.cwd(), "server/database-cli.ts"),
    copy = join(dir, "cli copy.sqlite"),
    restored = join(dir, "cli restored.sqlite"),
    env = { ...process.env, DATABASE_PATH: path };
  const backup = JSON.parse(
    (await run(process.execPath, [script, "backup", copy], { env })).stdout,
  );
  assert.match(backup.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    backup.sha256,
    createHash("sha256").update(readFileSync(copy)).digest("hex"),
  );
  const restore = JSON.parse(
    (await run(process.execPath, [script, "restore", copy, restored], { env }))
      .stdout,
  );
  assert.equal(restore.counts.users, 1);
  assert.equal(restore.reconciliation.healthy, true);
  const verified = JSON.parse(
    (await run(process.execPath, [script, "verify", restored], { env })).stdout,
  );
  assert.equal(verified.reconciliation.healthy, true);
  assert(!JSON.stringify(verified).includes("PRIVATE_HASH"));
  assert(!JSON.stringify(verified).includes(u.email));
  await assert.rejects(
    run(process.execPath, [script, "restore", copy, path], { env }),
    (e) => {
      assert.equal((e as any).code, 1);
      assert.match((e as any).stderr, /target_exists/);
      return true;
    },
  );
  s.run("UPDATE users SET balance=999 WHERE id=?", u.id);
  await assert.rejects(
    run(process.execPath, [script, "verify", path], { env }),
    (e) => {
      assert.equal((e as any).code, 2);
      assert.equal(JSON.parse((e as any).stdout).reconciliation.healthy, false);
      return true;
    },
  );
});
