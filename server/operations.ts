import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { Infrastructure } from "./infrastructure.ts";
import type { AccountMail } from "./mail.ts";
import type { Model, OpsMetrics, OpsAlert } from "../src/domain.ts";
import { check, email } from "./validation.ts";
import { locales, translate } from "../src/i18n/messages.ts";
import type { Locale, Key } from "../src/i18n/messages.ts";
import { reconcile } from "./finance.ts";

export type OpsMail = { mail: AccountMail; recipient: string; locale: Locale };
export function opsMailFromEnv(
  env: NodeJS.ProcessEnv,
  mail?: AccountMail,
): OpsMail | undefined {
  if (!env.OPS_ALERT_EMAIL) return;
  check(mail, "OPS_ALERT_EMAIL requires SMTP configuration");
  const locale = env.OPS_ALERT_LOCALE || "zh-CN";
  check(locales.includes(locale as Locale), "Invalid OPS_ALERT_LOCALE");
  return {
    mail,
    recipient: email(env.OPS_ALERT_EMAIL),
    locale: locale as Locale,
  };
}
type Condition = {
  code: string;
  entityId: string;
  severity: "warning" | "critical";
  details: { expected?: number; actual?: number };
  delay: number;
};
type AlertRow = Omit<
  OpsAlert,
  "detectedAt" | "openedAt" | "lastSeenAt" | "ackAt" | "resolvedAt" | "details"
> & {
  detectedAt: number;
  openedAt: number | null;
  lastSeenAt: number;
  ackAt: number | null;
  resolvedAt: number | null;
  details: string;
};
type Change = {
  id: string;
  code: string;
  entityId: string;
  severity: string;
  resolved: boolean;
};
type Notification = {
  id: string;
  recipient: string;
  locale: Locale;
  payload: string;
  attempts: number;
  createdAt: number;
};
const MINUTE = 60_000,
  WINDOW = 5 * MINUTE;
const iso = (n: number | null) =>
  n === null ? null : new Date(n).toISOString();
const emptyMetric = () => ({
  requests: 0,
  errors: 0,
  aborted: 0,
  durationMs: 0,
});
type Bucket = {
  second: number;
  api: ReturnType<typeof emptyMetric>;
  inference: ReturnType<typeof emptyMetric>;
  agent: ReturnType<typeof emptyMetric>;
};

export class Operations {
  store: Store;
  infrastructure: Infrastructure;
  mail?: OpsMail;
  buckets = new Map<number, Bucket>();
  startedAt = Date.now();
  delivering = false;
  controlFailed = false;
  constructor(store: Store, infrastructure: Infrastructure, mail?: OpsMail) {
    this.store = store;
    this.infrastructure = infrastructure;
    this.mail = mail;
  }
  record(
    group: "api" | "inference" | "agent",
    status: number,
    durationMs: number,
    aborted = false,
  ) {
    const second = Math.floor(Date.now() / 1000);
    let bucket = this.buckets.get(second);
    if (!bucket) {
      bucket = {
        second,
        api: emptyMetric(),
        inference: emptyMetric(),
        agent: emptyMetric(),
      };
      this.buckets.set(second, bucket);
    }
    const m = bucket[group];
    if (aborted) m.aborted++;
    else {
      m.requests++;
      m.errors += status >= 500 ? 1 : 0;
      m.durationMs += Math.max(0, durationMs);
    }
    this.prune();
  }
  prune() {
    const cutoff = Math.floor((Date.now() - WINDOW) / 1000);
    for (const key of this.buckets.keys())
      if (key <= cutoff) this.buckets.delete(key);
  }
  metrics(): OpsMetrics {
    this.prune();
    const totals = {
      api: emptyMetric(),
      inference: emptyMetric(),
      agent: emptyMetric(),
    };
    for (const bucket of this.buckets.values())
      for (const key of ["api", "inference", "agent"] as const) {
        const a = totals[key],
          b = bucket[key];
        a.requests += b.requests;
        a.errors += b.errors;
        a.aborted += b.aborted;
        a.durationMs += b.durationMs;
      }
    return {
      since: new Date(
        Math.max(this.startedAt, Date.now() - WINDOW),
      ).toISOString(),
      ...Object.fromEntries(
        Object.entries(totals).map(([key, m]) => [
          key,
          {
            requests: m.requests,
            errors: m.errors,
            aborted: m.aborted,
            errorRate: m.requests ? m.errors / m.requests : 0,
            averageMs: m.requests
              ? Math.round(m.durationMs / m.requests)
              : null,
          },
        ]),
      ),
    } as OpsMetrics;
  }
  conditions(): Condition[] {
    const result: Condition[] = [];
    const add = (
      code: string,
      entityId: string,
      severity: Condition["severity"] = "warning",
      delay = WINDOW,
      details: Condition["details"] = {},
    ) => result.push({ code, entityId, severity, delay, details });
    for (const issue of reconcile(this.store).issues)
      add(
        "audit." + issue.code,
        issue.entityId,
        ["payment_debt", "payment_review"].includes(issue.code)
          ? "warning"
          : "critical",
        0,
        { expected: issue.expected, actual: issue.actual },
      );
    const nodes = this.infrastructure.servers(),
      deployments = this.infrastructure.deployments();
    for (const node of nodes) {
      const occupied = deployments.some(
        (d) => d.serverId === node.id && d.phase !== "stopped",
      );
      if ((!node.schedulingEnabled || node.maintenance) && !occupied) continue;
      const online =
        !!node.lastHeartbeatAt &&
        new Date(node.lastHeartbeatAt).getTime() > Date.now() - 45_000;
      if (!online) add("ops.node_offline", node.id);
      else {
        if (
          node.inventoryError ||
          !node.capabilities.dockerReady ||
          (node.workMode === "gpu-rental"
            ? !node.capabilities.workspaceReady
            : !node.capabilities.inferenceReady)
        )
          add("ops.inventory_error", node.id);
        if (node.gpus.some((g) => g.missing)) add("ops.gpu_missing", node.id);
      }
    }
    for (const d of deployments) {
      if (d.phase === "failed")
        add("ops.deployment_failed", d.id, "critical", 0);
      else if (!["ready", "stopped"].includes(d.phase))
        add("ops.deployment_unhealthy", d.id);
    }
    for (const { data } of this.store.all<{ data: string }>(
      "SELECT data FROM models WHERE deleted=0",
    )) {
      const model: Model = JSON.parse(data);
      if (
        model.enabled &&
        model.routingMode === "managed" &&
        !this.infrastructure.route(model.id)
      )
        add("ops.model_unavailable", model.id);
    }
    const metrics = this.metrics();
    for (const group of ["api", "agent", "inference"] as const) {
      const m = metrics[group];
      if (m.requests >= 20 && m.errorRate >= 0.1)
        add("ops.http_errors", group, "critical", 0, {
          expected: 10,
          actual: Math.round(m.errorRate * 100),
        });
    }
    if (metrics.api.requests >= 20 && metrics.api.averageMs! >= 2000)
      add("ops.api_slow", "api", "warning", 0, {
        expected: 2000,
        actual: metrics.api.averageMs!,
      });
    // SSE may already have HTTP 200 when generation fails; use settled request records as well.
    const inference = this.store.get<{ count: number; failed: number }>(
      "SELECT COUNT(*) count,COALESCE(SUM(status='failed'),0) failed FROM requests WHERE status!='pending' AND createdAt>?",
      new Date(Date.now() - WINDOW).toISOString(),
    )!;
    if (inference.count >= 20 && inference.failed / inference.count >= 0.1)
      add("ops.inference_errors", "gateway", "critical", 0, {
        expected: 10,
        actual: Math.round((inference.failed / inference.count) * 100),
      });
    if (this.controlFailed) add("ops.control_failed", "control", "critical", 0);
    return result;
  }
  scan() {
    const now = Date.now();
    let conditions: Condition[],
      success = true;
    try {
      conditions = this.conditions();
    } catch {
      success = false;
      conditions = [
        {
          code: "ops.scan_failed",
          entityId: "monitor",
          severity: "critical",
          delay: 0,
          details: {},
        },
      ];
    }
    const changes: Change[] = [];
    // This transaction must not invoke Store.transaction's payment-debt settlement.
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const present = new Set<string>();
      for (const c of conditions) {
        const key = JSON.stringify([c.code, c.entityId]);
        present.add(key);
        let row = this.store.get<AlertRow>(
          "SELECT * FROM ops_alerts WHERE code=? AND entityId=? AND resolvedAt IS NULL",
          c.code,
          c.entityId,
        );
        if (!row) {
          const id = randomUUID();
          this.store.run(
            "INSERT INTO ops_alerts(id,code,entityId,severity,details,detectedAt,lastSeenAt) VALUES(?,?,?,?,?,?,?)",
            id,
            c.code,
            c.entityId,
            c.severity,
            JSON.stringify(c.details),
            now,
            now,
          );
          row = this.store.get<AlertRow>(
            "SELECT * FROM ops_alerts WHERE id=?",
            id,
          )!;
        }
        this.store.run(
          "UPDATE ops_alerts SET lastSeenAt=?,details=? WHERE id=?",
          now,
          JSON.stringify(c.details),
          row.id,
        );
        if (row.openedAt === null && now - row.detectedAt >= c.delay) {
          this.store.run(
            "UPDATE ops_alerts SET openedAt=? WHERE id=?",
            now,
            row.id,
          );
          changes.push({
            id: row.id,
            code: c.code,
            entityId: c.entityId,
            severity: c.severity,
            resolved: false,
          });
        }
      }
      if (success)
        for (const row of this.store.all<AlertRow>(
          "SELECT * FROM ops_alerts WHERE resolvedAt IS NULL",
        )) {
          if (present.has(JSON.stringify([row.code, row.entityId]))) continue;
          if (row.openedAt === null)
            this.store.run("DELETE FROM ops_alerts WHERE id=?", row.id);
          else {
            this.store.run(
              "UPDATE ops_alerts SET resolvedAt=? WHERE id=?",
              now,
              row.id,
            );
            changes.push({
              id: row.id,
              code: row.code,
              entityId: row.entityId,
              severity: row.severity,
              resolved: true,
            });
          }
        }
      this.store.run(
        "INSERT INTO ops_checks(id,attemptAt,successAt,metrics) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET attemptAt=excluded.attemptAt,successAt=COALESCE(excluded.successAt,ops_checks.successAt),metrics=excluded.metrics",
        now,
        success ? now : null,
        JSON.stringify(this.metrics()),
      );
      if (changes.length && this.mail)
        this.store.run(
          "INSERT INTO ops_notifications(id,recipient,locale,payload,createdAt,nextAttemptAt) VALUES(?,?,?,?,?,?)",
          randomUUID(),
          this.mail.recipient,
          this.mail.locale,
          JSON.stringify(changes),
          now,
          now,
        );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  status() {
    const row = this.store.get<{ attemptAt: number; successAt: number | null }>(
      "SELECT * FROM ops_checks WHERE id=1",
    );
    return {
      attemptAt: row ? iso(row.attemptAt) : null,
      successAt: row ? iso(row.successAt) : null,
      stale:
        !!this.store.get(
          "SELECT 1 FROM ops_alerts WHERE code='ops.scan_failed' AND resolvedAt IS NULL",
        ) ||
        !row?.successAt ||
        row.successAt < Date.now() - 2 * MINUTE ||
        row.attemptAt !== row.successAt,
      notificationsEnabled: !!this.mail,
      metrics: this.metrics(),
    };
  }
  list(state: string | null, cursor: string | null) {
    check(
      state === null || ["active", "resolved"].includes(state),
      "Invalid alert state",
    );
    check(
      cursor === null || /^[1-9]\d{0,14}$/.test(cursor),
      "Invalid alert cursor",
    );
    const rows = this.store.all<AlertRow & { cursor: number }>(
      `SELECT rowid cursor,* FROM ops_alerts WHERE openedAt IS NOT NULL AND resolvedAt IS ${state === "resolved" ? "NOT " : ""}NULL AND rowid<? ORDER BY rowid DESC LIMIT 51`,
      cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER,
    );
    return {
      ...this.status(),
      alerts: rows.slice(0, 50).map(({ cursor: _, ...r }) => ({
        ...r,
        details: JSON.parse(r.details),
        detectedAt: iso(r.detectedAt),
        openedAt: iso(r.openedAt),
        lastSeenAt: iso(r.lastSeenAt),
        ackAt: iso(r.ackAt),
        resolvedAt: iso(r.resolvedAt),
      })),
      nextCursor: rows.length > 50 ? rows[49].cursor : null,
      counts: this.store.get<{
        active: number;
        unacknowledged: number;
        resolved: number;
      }>(
        "SELECT COALESCE(SUM(openedAt IS NOT NULL AND resolvedAt IS NULL),0) active,COALESCE(SUM(openedAt IS NOT NULL AND resolvedAt IS NULL AND ackAt IS NULL),0) unacknowledged,COALESCE(SUM(resolvedAt IS NOT NULL),0) resolved FROM ops_alerts",
      ),
      notifications: this.store.all(
        "SELECT id,state,attempts,createdAt,sentAt,errorCode FROM ops_notifications ORDER BY rowid DESC LIMIT 50",
      ),
      deliveryCounts: this.store.get(
        "SELECT COALESCE(SUM(state='pending'),0) pending,COALESCE(SUM(state='failed'),0) failed FROM ops_notifications",
      ),
    };
  }
  acknowledge(id: string, actorId: string) {
    check(
      this.store.get(
        "SELECT 1 FROM ops_alerts WHERE id=? AND openedAt IS NOT NULL",
        id,
      ),
      "Alert not found",
      404,
      "not_found",
    );
    this.store.run(
      "UPDATE ops_alerts SET ackAt=?,ackActorId=? WHERE id=? AND ackAt IS NULL AND resolvedAt IS NULL",
      Date.now(),
      actorId,
      id,
    );
  }
  retry(id: string) {
    check(this.mail, "Alert email is not configured", 503, "mail_unavailable");
    const row = this.store.get<{ recipient: string; createdAt: number }>(
      "SELECT recipient,createdAt FROM ops_notifications WHERE id=? AND state='failed'",
      id,
    );
    check(row, "Failed notification not found", 404, "not_found");
    check(
      row.createdAt >= Date.now() - 86400000,
      "Notification expired",
      409,
      "conflict",
    );
    check(
      row.recipient === this.mail.recipient,
      "Recipient changed",
      409,
      "conflict",
    );
    this.store.run(
      "UPDATE ops_notifications SET state='pending',attempts=0,nextAttemptAt=?,errorCode=NULL WHERE id=?",
      Date.now(),
      id,
    );
  }
  async flush() {
    if (!this.mail || this.delivering) return;
    this.delivering = true;
    try {
      const row = this.store.get<Notification>(
        "SELECT * FROM ops_notifications WHERE state='pending' AND nextAttemptAt<=? ORDER BY rowid LIMIT 1",
        Date.now(),
      );
      if (!row) return;
      if (row.attempts >= 5) {
        this.store.run(
          "UPDATE ops_notifications SET state='failed',errorCode='smtp_failed' WHERE id=?",
          row.id,
        );
        return;
      }
      if (
        row.recipient !== this.mail.recipient ||
        row.createdAt < Date.now() - 86400000
      ) {
        this.store.run(
          "UPDATE ops_notifications SET state='failed',errorCode=? WHERE id=?",
          row.recipient !== this.mail.recipient
            ? "recipient_changed"
            : "expired",
          row.id,
        );
        return;
      }
      // Persist the attempt before SMTP; a crash after acceptance may duplicate one digest.
      this.store.run(
        "UPDATE ops_notifications SET attempts=attempts+1,nextAttemptAt=? WHERE id=?",
        Date.now() + 60_000,
        row.id,
      );
      try {
        const t = (key: Key) => translate(row.locale, key);
        const lines = (JSON.parse(row.payload) as Change[]).map(
          (c) =>
            `${t(c.resolved ? "ops.resolved" : "ops.active")} · ${t(c.severity === "critical" ? "ops.critical" : "ops.warning")} · ${t(c.code as Key)} · ${c.entityId} · ${c.id}`,
        );
        const url = new URL("/", this.mail.mail.origin);
        url.hash = "/admin/operations";
        await this.mail.mail.send({
          to: row.recipient,
          subject: t("ops.mailSubject"),
          text:
            new Date(row.createdAt).toISOString() +
            "\n" +
            lines.join("\n") +
            "\n\n" +
            url.href,
        });
        this.store.run(
          "UPDATE ops_notifications SET state='sent',sentAt=?,errorCode=NULL WHERE id=?",
          Date.now(),
          row.id,
        );
      } catch {
        const attempts = row.attempts + 1;
        this.store.run(
          "UPDATE ops_notifications SET state=?,nextAttemptAt=?,errorCode='smtp_failed' WHERE id=?",
          attempts >= 5 ? "failed" : "pending",
          Date.now() + Math.min(3600000, MINUTE * 2 ** attempts),
          row.id,
        );
      }
    } finally {
      this.delivering = false;
    }
  }
}
