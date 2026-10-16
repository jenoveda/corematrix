import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { emptyState, MICRO } from "../src/domain.ts";
import type {
  State,
  Model,
  User,
  Summary,
  Bill,
  BillPage,
} from "../src/domain.ts";
import { Infrastructure } from "./infrastructure.ts";
import { migrate } from "./migrations.ts";
import { check, day } from "./validation.ts";
export type UserRow = User & {
  passwordHash: string;
  balance: number;
  dailyBudget: number;
  paymentDebt: number;
};
export type RequestRow = {
  id: string;
  userId: string;
  requestKey: string;
  fingerprint: string;
  day: string;
  status: "pending" | "succeeded" | "failed";
  reserved: number;
  response: string | null;
  httpStatus: number;
  modelId: string;
  modelName: string;
  inputPrice: number;
  outputPrice: number;
  inputTokens: number;
  outputTokens: number;
  amount: number;
};
export class Store {
  db: DatabaseSync;
  constructor(
    path: string,
    recoverInterrupted = false,
    options: { readOnly?: boolean } = {},
  ) {
    if (options.readOnly) {
      this.db = new DatabaseSync(path, { readOnly: true });
      try {
        this.db.exec(
          "PRAGMA foreign_keys=ON; PRAGMA query_only=ON; PRAGMA busy_timeout=5000;",
        );
      } catch (error) {
        this.db.close();
        throw error;
      }
      return;
    }
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('user','admin')), passwordHash TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0 CHECK(balance BETWEEN 0 AND 9007199254740991), dailyBudget INTEGER NOT NULL DEFAULT 100000000, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys(tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL UNIQUE REFERENCES users(id), prefix TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY, data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), requestKey TEXT NOT NULL, fingerprint TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL, reserved INTEGER NOT NULL, response TEXT, httpStatus INTEGER NOT NULL DEFAULT 200, modelId TEXT NOT NULL, modelName TEXT NOT NULL, inputPrice INTEGER NOT NULL, outputPrice INTEGER NOT NULL, inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0, amount INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, UNIQUE(userId,requestKey));
      CREATE INDEX IF NOT EXISTS requests_user_day ON requests(userId,day,status);
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), type TEXT NOT NULL CHECK(type IN ('token','recharge')), resource TEXT NOT NULL, quantity TEXT NOT NULL, amount INTEGER NOT NULL, inputPrice INTEGER, outputPrice INTEGER, time TEXT NOT NULL, day TEXT NOT NULL, requestId TEXT UNIQUE REFERENCES requests(id), reference TEXT UNIQUE, actorId TEXT REFERENCES users(id));
      CREATE INDEX IF NOT EXISTS ledger_user_time ON ledger(userId,time);
      CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    `);
    try {
      migrate(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    // shortcut: 单进程 SQLite 网关，横向扩容前换用共享数据库和持久化任务恢复。
    if (recoverInterrupted) this.recoverInterruptedRequests();
    this.run("DELETE FROM sessions WHERE expires < ?", Date.now());
    this.run("DELETE FROM rate_limits WHERE expires < ?", Date.now());
    const defaults = [
      ["qwen3-32b", "Qwen3-32B", "通用对话", 2, 6, 2, 48],
      ["r1-distill-32b", "R1-Distill-32B", "深度推理", 3, 9, 2, 48],
      ["qwen2.5-7b", "Qwen2.5-7B", "轻量高效", 0.5, 1.5, 1, 24],
    ] as const;
    for (const [id, name, tag, input, output, gpus, vram] of defaults)
      this.run(
        "INSERT OR IGNORE INTO models(id,data) VALUES(?,?)",
        id,
        JSON.stringify({
          id,
          name,
          tag,
          description: "预置模型配置，请管理员配置推理服务及确认定价后上架。",
          inputPrice: input * MICRO,
          outputPrice: output * MICRO,
          gpus,
          vram,
          enabled: false,
          configured: false,
          contextTokens: 32768,
          maxOutputTokens: 4096,
          upstreamUrl: "",
          upstreamModel: id,
          apiKeyEnv: "",
        } satisfies Model),
      );
  }
  get<T>(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  bills(
    userId: string,
    before = Number.MAX_SAFE_INTEGER,
    type?: Bill["type"],
    limit = 50,
  ): BillPage {
    const rows = this.all<
      Omit<Bill, "metadata"> & { cursor: number; metadata: string | null }
    >(
      `SELECT rowid cursor,id,time,type,resource,quantity,amount,inputPrice,outputPrice,metadata FROM ledger WHERE userId=? AND rowid<? ${type ? "AND type=?" : ""} ORDER BY rowid DESC LIMIT ?`,
      userId,
      before,
      ...(type ? [type] : []),
      limit + 1,
    );
    return {
      data: rows
        .slice(0, limit)
        .map(({ cursor: _cursor, metadata, ...b }) => ({
          ...b,
          metadata: typeof metadata === "string" ? JSON.parse(metadata) : null,
        })),
      nextCursor: rows.length > limit ? rows[limit - 1].cursor : null,
    };
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      // Reversed payments use only unfrozen funds; existing GPU/Token holds stay funded.
      for (const u of this.all<{
        id: string;
        balance: number;
        paymentDebt: number;
      }>("SELECT id,balance,paymentDebt FROM users WHERE paymentDebt>0")) {
        const amount = Math.min(
          u.paymentDebt,
          Math.max(0, u.balance - this.held(u.id)),
        );
        if (amount)
          this.run(
            "UPDATE users SET balance=balance-?,paymentDebt=paymentDebt-? WHERE id=?",
            amount,
            amount,
            u.id,
          );
      }
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  user(id: string) {
    return this.get<UserRow>("SELECT * FROM users WHERE id=?", id);
  }
  createUser(
    name: string,
    email: string,
    passwordHash: string,
    role: User["role"] = "user",
  ) {
    const id = randomUUID();
    this.run(
      "INSERT INTO users(id,name,email,role,passwordHash,createdAt) VALUES(?,?,?,?,?,?)",
      id,
      name,
      email,
      role,
      passwordHash,
      new Date().toISOString(),
    );
    return this.user(id)!;
  }
  model(id: string) {
    const row = this.get<{ data: string }>(
      "SELECT data FROM models WHERE id=? AND deleted=0",
      id,
    );
    return row ? (JSON.parse(row.data) as Model) : undefined;
  }
  limit(key: string, count: number, windowMs: number) {
    this.transaction(() => {
      this.run("DELETE FROM rate_limits WHERE expires < ?", Date.now());
      const row = this.get<{ count: number }>(
        "SELECT count FROM rate_limits WHERE key=?",
        key,
      );
      check(
        !row || row.count < count,
        "请求过于频繁，请稍后再试。",
        429,
        "rate_limited",
      );
      this.run(
        "INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
        key,
        Date.now() + windowMs,
      );
    });
  }
  publicUser(user: UserRow): User {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      locale: user.locale,
      emailVerifiedAt: user.emailVerifiedAt,
    };
  }
  held(userId: string) {
    return this.get<{ value: number }>(
      `SELECT (SELECT COALESCE(SUM(reserved),0) FROM requests WHERE userId=? AND status='pending')+(SELECT COALESCE(SUM(reserved),0) FROM rental_orders WHERE userId=?)+(SELECT COALESCE(SUM(reserved),0) FROM rental_reservations WHERE userId=?) value`,
      userId,
      userId,
      userId,
    )!.value;
  }
  paymentReview(userId: string) {
    return !!this.get(
      "SELECT id FROM payment_orders WHERE userId=? AND review=1 LIMIT 1",
      userId,
    );
  }
  available(userId: string) {
    const user = this.user(userId)!;
    return this.paymentReview(userId)
      ? 0
      : Math.max(0, user.balance - this.held(userId) - user.paymentDebt);
  }
  snapshot(user?: UserRow, csrfToken = ""): State {
    const state = emptyState(),
      admin = user?.role === "admin";
    const infrastructure = new Infrastructure(this);
    state.models = this.all<{ data: string }>(
      "SELECT data FROM models WHERE deleted=0 ORDER BY rowid",
    )
      .map((r) => JSON.parse(r.data) as Model)
      .filter((m) => admin || m.enabled)
      .map((m) => {
        m.configured =
          m.routingMode === "managed"
            ? !!infrastructure.route(m.id)
            : !!m.upstreamUrl;
        if (admin) return m;
        const {
          upstreamUrl: _url,
          upstreamModel: _model,
          apiKeyEnv: _key,
          runtime: _runtime,
          ...pub
        } = m;
        return pub;
      });
    if (!user) return state;
    state.rentals = infrastructure
      .deployments()
      .filter((d) => d.workloadType === "gpu-rental" && d.ownerId === user.id)
      .map((d) => ({
        id: d.id,
        phase: d.phase,
        createdAt: d.createdAt,
        gpuCount: d.spec.gpuUuids.length,
        allocated: d.allocated,
      }));
    state.user = this.publicUser(user);
    state.csrfToken = csrfToken;
    state.account = user.name;
    state.email = user.email;
    state.registered = true;
    state.dailyBudget = user.dailyBudget;
    state.heldBalance = this.held(user.id);
    state.orders = infrastructure.billing.orders(user.id);
    state.reservations = infrastructure.billing.reservations.list(user.id);
    if (admin)
      state.reservationSchedule =
        infrastructure.billing.reservations.list(null);
    state.balance = this.available(user.id);
    state.paymentDebt = user.paymentDebt;
    state.paymentReview = this.paymentReview(user.id);
    state.tokenSpend = this.get<{ value: number }>(
      `SELECT COALESCE(SUM(amount),0) value FROM requests WHERE userId=? AND day=? AND status='succeeded'`,
      user.id,
      day(),
    )!.value;
    const key = this.get<{ prefix: string }>(
      "SELECT prefix FROM api_keys WHERE userId=?",
      user.id,
    );
    state.hasKey = !!key;
    state.keyPrefix = key?.prefix || "";
    state.bills = this.bills(user.id, undefined, undefined, 500).data;
    if (admin) {
      state.servers = infrastructure.servers();
      state.deployments = infrastructure.deployments();
      state.summary = {
        revenue: this.get<{ value: number }>(
          `SELECT COALESCE(SUM(amount),0) value FROM ledger WHERE type IN ('token','compute','compute_refund')`,
        )!.value,
        credits: this.get<{ value: number }>(
          `SELECT COALESCE(SUM(CASE WHEN type='recharge' THEN amount ELSE -amount END),0) value FROM ledger WHERE type IN ('recharge','recharge_refund')`,
        )!.value,
        users: this.get<{ value: number }>("SELECT COUNT(*) value FROM users")!
          .value,
        requests: this.get<{ value: number }>(
          `SELECT COUNT(*) value FROM requests WHERE status='succeeded'`,
        )!.value,
        byModel: this.all<Summary["byModel"][number]>(
          `SELECT modelName name,SUM(amount) revenue,SUM(inputTokens) inputTokens,SUM(outputTokens) outputTokens FROM requests WHERE status='succeeded' GROUP BY modelId,modelName`,
        ),
        daily: this.all<Summary["daily"][number]>(
          `SELECT day,SUM(amount) revenue FROM ledger WHERE type IN ('token','compute','compute_refund') GROUP BY day ORDER BY day DESC LIMIT 7`,
        ).reverse(),
      };
    }
    return state;
  }
  recoverInterruptedRequests() {
    this.transaction(() =>
      this.run(
        `UPDATE requests SET status='failed',reserved=0,httpStatus=503,response=? WHERE status='pending'`,
        JSON.stringify({
          error: {
            code: "request_interrupted",
            message: "服务重启导致请求中断，未扣费。请使用新请求 ID 重试。",
          },
        }),
      ),
    );
  }
  close() {
    this.db.close();
  }
}
