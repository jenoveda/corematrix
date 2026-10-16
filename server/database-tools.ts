import { backup } from "node:sqlite";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Store } from "./store.ts";
import { reconcile } from "./finance.ts";
import { LATEST_SCHEMA_VERSION } from "./migrations.ts";

function regularSource(path: string) {
  try {
    const source = realpathSync(path);
    if (statSync(source).isFile()) return source;
  } catch {}
  throw new Error("invalid_source");
}
export function inspectDatabase(path: string) {
  const s = new Store(regularSource(path), false, { readOnly: true });
  try {
    // Keep counts and financial checks in one read snapshot, including when inspecting a live WAL database.
    s.db.exec("BEGIN");
    const integrity = s.all<{ quick_check: string }>("PRAGMA quick_check");
    if (integrity.length !== 1 || integrity[0].quick_check !== "ok")
      throw new Error("integrity_failed");
    if (s.all("PRAGMA foreign_key_check").length)
      throw new Error("foreign_keys_failed");
    const tables = new Set(
      s
        .all<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type='table'",
        )
        .map((row) => row.name),
    );
    for (const table of [
      "users",
      "models",
      "ledger",
      "requests",
      "schema_migrations",
    ])
      if (!tables.has(table)) throw new Error("not_corematrix_database");
    const schema = s.get<{ version: number }>(
      "SELECT COALESCE(MAX(version),0) version FROM schema_migrations",
    )!.version;
    if (schema < 1 || schema > LATEST_SCHEMA_VERSION)
      throw new Error("unsupported_schema");
    const counts = Object.fromEntries(
      [
        "users",
        "models",
        "ledger",
        "requests",
        "deployments",
        "gpu_allocations",
        "rental_orders",
        "rental_reservations",
        "payment_orders",
        "ops_alerts",
        "ops_notifications",
      ]
        .filter((table) => tables.has(table))
        .map((table) => [
          table,
          s.get<{ count: number }>(`SELECT COUNT(*) count FROM ${table}`)!
            .count,
        ]),
    );
    const pendingRequests = s.get<{ count: number }>(
      "SELECT COUNT(*) count FROM requests WHERE status='pending'",
    )!.count;
    const activeGpuClaims = tables.has("gpu_allocations")
      ? s.get<{ count: number }>(
          "SELECT COUNT(*) count FROM gpu_allocations WHERE released=0",
        )!.count
      : 0;
    const audit = schema === LATEST_SCHEMA_VERSION ? reconcile(s) : null;
    s.db.exec("COMMIT");
    return {
      schema,
      currentSchema: LATEST_SCHEMA_VERSION,
      needsMigration: schema !== LATEST_SCHEMA_VERSION,
      integrity: "ok",
      foreignKeys: "ok",
      counts,
      pendingRequests,
      activeGpuClaims,
      reconciliation: audit
        ? {
            healthy: audit.healthy,
            issueCounts: audit.issues.reduce<Record<string, number>>(
              (counts, issue) => {
                counts[issue.code] = (counts[issue.code] || 0) + 1;
                return counts;
              },
              {},
            ),
          }
        : null,
    };
  } finally {
    s.close();
  }
}
export async function snapshotDatabase(
  sourcePath: string,
  destinationPath: string,
) {
  const source = regularSource(sourcePath),
    destination = resolve(destinationPath);
  // Never overwrite a database, link, or leftover journal belonging to another database.
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      lstatSync(destination + suffix);
      throw new Error("target_exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(
    join(dirname(destination), ".corematrix-backup-"),
  );
  chmodSync(staging, 0o700);
  const temporary = join(staging, "snapshot.sqlite");
  let s: Store | undefined;
  try {
    s = new Store(source, false, { readOnly: true });
    await backup(s.db, temporary);
    chmodSync(temporary, 0o600);
    const inspection = inspectDatabase(temporary);
    // A hard link publishes atomically and fails if another process created the destination meanwhile.
    linkSync(temporary, destination);
    return { path: destination, ...inspection };
  } finally {
    s?.close();
    rmSync(staging, { recursive: true, force: true });
  }
}
