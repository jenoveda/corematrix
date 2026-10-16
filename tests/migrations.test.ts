import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.ts";
import { LATEST_SCHEMA_VERSION } from "../server/migrations.ts";
test("upgrade a pre-i18n database twice without changing accounts or historical money", () => {
  const dir = mkdtempSync(join(tmpdir(), "corematrix-migration-")),
    path = join(dir, "db.sqlite");
  let s = new Store(path);
  try {
    const user = s.createUser(
      "日本語 한국어",
      "legacy@tests.invalid",
      "original-password-hash",
      "admin",
    );
    s.run("UPDATE users SET balance=123456789 WHERE id=?", user.id);
    s.run(
      "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES('old',?,'recharge','管理员人工入账','历史原文',123456789,'2026-10-15T00:00:00Z','2026-10-15')",
      user.id,
    );
    // Reconstruct the deployed v0 schema by removing only the new feature tables/columns.
    s.db.exec(
      "DROP TABLE provider_usage;DROP TABLE provider_settlements;DROP TABLE provider_nodes;DROP TABLE providers;ALTER TABLE users DROP COLUMN accountType;DROP INDEX requests_pending_deployment;DROP TABLE ops_notifications;DROP TABLE ops_checks;DROP TABLE ops_alerts;DROP INDEX rental_reservation_order;ALTER TABLE rental_orders DROP COLUMN reservationId;ALTER TABLE rental_orders DROP COLUMN scheduledStart;ALTER TABLE rental_orders DROP COLUMN scheduledEnd;DROP TABLE rental_reservations;DROP TABLE payment_refunds;DROP TABLE payment_events;DROP TABLE payment_orders;DROP INDEX users_payment_debt;ALTER TABLE users DROP COLUMN paymentDebt;DROP TABLE account_tokens;ALTER TABLE users DROP COLUMN emailVerifiedAt;DROP TABLE expenses;DROP TABLE rental_actions;DROP TABLE rental_orders;DROP INDEX gpus_uuid;ALTER TABLE requests DROP COLUMN deploymentId;DROP TABLE deployment_events;DROP TABLE deployment_jobs;DROP TABLE gpu_allocations;DROP TABLE port_allocations;DROP TABLE deployments;DROP TABLE gpus;DROP TABLE servers;ALTER TABLE users DROP COLUMN locale;ALTER TABLE ledger DROP COLUMN metadata;DROP TABLE schema_migrations;",
    );
    s.close();
    for (let i = 0; i < 2; i++) {
      s = new Store(path);
      assert.equal(s.user(user.id)?.balance, 123456789);
      assert.equal(s.user(user.id)?.role, "admin");
      assert.equal(s.user(user.id)?.passwordHash, "original-password-hash");
      assert.equal(s.user(user.id)?.locale, "zh-CN");
      assert.equal(s.snapshot(s.user(user.id)).bills[0].quantity, "历史原文");
      assert.equal(s.snapshot(s.user(user.id)).bills[0].metadata, null);
      assert.equal(s.all("SELECT * FROM schema_migrations").length, LATEST_SCHEMA_VERSION);
      if (i === 0) s.close();
    }
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed v11 migration rolls back its index and metadata without changing historical funds", () => {
  const dir = mkdtempSync(join(tmpdir(), "corematrix-migration-failure-")),
    path = join(dir, "db.sqlite");
  const s = new Store(path),
    user = s.createUser(
      "Legacy",
      "legacy@tests.invalid",
      "unchanged-password-hash",
      "admin",
    );
  s.run("UPDATE users SET balance=123456 WHERE id=?", user.id);
  s.run(
    "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES('old',?,'recharge','Test','Test',123456,'2026-10-16T00:00:00Z','2026-10-16')",
    user.id,
  );
  s.db.exec(
    "DROP INDEX requests_pending_deployment;DROP INDEX deployments_ready_model;DELETE FROM schema_migrations WHERE version=11;CREATE TRIGGER fail_v11 BEFORE INSERT ON schema_migrations WHEN NEW.version=11 BEGIN SELECT RAISE(ABORT,'forced migration failure');END;",
  );
  const before = JSON.stringify([
    s.all("SELECT * FROM users"),
    s.all("SELECT * FROM ledger"),
  ]);
  s.close();
  let raw: DatabaseSync | undefined, recovered: Store | undefined;
  try {
    assert.throws(() => new Store(path), /forced migration failure/);
    raw = new DatabaseSync(path);
    assert.equal(
      raw.prepare("SELECT 1 FROM schema_migrations WHERE version=11").get(),
      undefined,
    );
    assert.equal(
      raw
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE name='requests_pending_deployment'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      raw
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE name='deployments_ready_model'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      JSON.stringify([
        raw.prepare("SELECT * FROM users").all(),
        raw.prepare("SELECT * FROM ledger").all(),
      ]),
      before,
    );
    raw.exec("DROP TRIGGER fail_v11");
    raw.close();
    raw = undefined;
    recovered = new Store(path);
    assert.equal(
      recovered.user(user.id)!.passwordHash,
      "unchanged-password-hash",
    );
    assert.equal(recovered.user(user.id)!.balance, 123456);
    assert(recovered.get("SELECT 1 FROM schema_migrations WHERE version=11"));
    assert(
      recovered.get(
        "SELECT 1 FROM sqlite_schema WHERE name='requests_pending_deployment'",
      ),
    );
    assert.equal(recovered.all("PRAGMA foreign_key_check").length, 0);
  } finally {
    raw?.close();
    recovered?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
