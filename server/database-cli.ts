import { createReadStream, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { inspectDatabase, snapshotDatabase } from "./database-tools.ts";

const [command, ...args] = process.argv.slice(2);
try {
  if (
    !["backup", "restore", "verify"].includes(command) ||
    args.length !== (command === "restore" ? 2 : 1) ||
    args.some((value) => !value || value.startsWith("--"))
  )
    throw new Error("usage");
  const result =
    command === "verify"
      ? { ...inspectDatabase(args[0]), path: realpathSync(args[0]) }
      : await snapshotDatabase(
          command === "backup"
            ? process.env.DATABASE_PATH || "data/corematrix.sqlite"
            : args[0],
          command === "backup" ? args[0] : args[1],
        );
  let sha256: string | null = null;
  if (!existsSync(result.path + "-wal")) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(result.path)) hash.update(chunk);
    sha256 = hash.digest("hex");
  }
  console.log(JSON.stringify({ command, ...result, sha256 }, null, 2));
  if (
    command === "verify" &&
    (result.needsMigration || result.reconciliation?.healthy === false)
  )
    process.exitCode = 2;
} catch (error) {
  const known = new Set([
    "usage",
    "invalid_source",
    "integrity_failed",
    "foreign_keys_failed",
    "not_corematrix_database",
    "unsupported_schema",
    "target_exists",
  ]);
  console.error(
    JSON.stringify({
      error:
        error instanceof Error && known.has(error.message)
          ? error.message
          : "database_operation_failed",
    }),
  );
  if (error instanceof Error && error.message === "usage")
    console.error(
      "Usage: npm run db:backup -- <new-file> | npm run db:restore -- <backup-file> <new-file> | npm run db:verify -- <file>",
    );
  process.exitCode = 1;
}
