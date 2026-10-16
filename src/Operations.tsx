import { useEffect, useRef, useState } from "react";
import type { OperationsReport } from "./domain";
import { request } from "./api";
import { useApp } from "./context";
import { useI18n } from "./i18n";
import type { Key } from "./i18n";
import {
  Badge,
  DataTable,
  Empty,
  Note,
  PageHeader,
  Panel,
  Stat,
  Stats,
} from "./components";

export default function Operations() {
  const { mutate } = useApp(),
    { t, date, number, money, errorText } = useI18n();
  const [report, setReport] = useState<OperationsReport | null>(null),
    [history, setHistory] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    seq = useRef(0),
    paged = useRef(false);
  const value = (code: string, n: number) =>
    code.startsWith("audit.") &&
    ![
      "audit.stopped_gpu_allocated",
      "audit.payment_review",
      "audit.reservation_order_mismatch",
      "audit.reservation_overlap",
    ].includes(code)
      ? money(n)
      : number(n);
  async function load(more = false) {
    const id = ++seq.current;
    if (!more) paged.current = false;
    try {
      const query = new URLSearchParams({
        state: history ? "resolved" : "active",
      });
      if (more && report?.nextCursor)
        query.set("before", String(report.nextCursor));
      const data = await request<OperationsReport>(
        "/api/admin/operations?" + query,
      );
      if (id === seq.current) {
        paged.current = more;
        setError(null);
        setReport((old) => ({
          ...data,
          alerts: more && old ? [...old.alerts, ...data.alerts] : data.alerts,
        }));
      }
    } catch (e) {
      if (id === seq.current) setError(e);
    }
  }
  useEffect(() => {
    setReport(null);
    void load();
    const timer = setInterval(() => {
      if (!paged.current) void load();
    }, 15000);
    return () => {
      clearInterval(timer);
      seq.current++;
    };
  }, [history]);
  async function act(path: string) {
    setBusy(true);
    setError(null);
    try {
      await mutate(path, "POST");
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title={t("nav.operations")}
        description={t("ops.description")}
        actions={
          <button
            className="button"
            disabled={busy}
            onClick={() => void load()}
          >
            {t("ops.refresh")}
          </button>
        }
      />
      {error !== null && (
        <p className="form-error" role="alert">
          {errorText(error)}
        </p>
      )}
      {!report && error === null && <p className="muted">{t("app.loading")}</p>}
      {report && (
        <>
          <Stats>
            <Stat
              label={t("ops.active")}
              value={number(report.counts.active)}
              detail={
                t("ops.unacknowledged") +
                ": " +
                number(report.counts.unacknowledged)
              }
            />
            <Stat
              label={t("ops.check")}
              value={t(report.stale ? "ops.stale" : "ops.current")}
              detail={date(report.successAt)}
            />
            <Stat
              label={t("ops.notifications")}
              value={t(
                report.notificationsEnabled ? "ops.enabled" : "ops.disabled",
              )}
              detail={t("ops.deliveryCounts", {
                pending: report.deliveryCounts.pending,
                failed: report.deliveryCounts.failed,
              })}
            />
          </Stats>
          <Panel title={t("ops.metrics")}>
            <DataTable
              caption={t("ops.metrics")}
              headers={[
                t("ops.group"),
                t("ops.requests"),
                t("ops.errors"),
                t("ops.errorRate"),
                t("ops.average"),
                t("ops.aborted"),
              ]}
              rows={(["api", "inference", "agent"] as const).map((key) => {
                const m = report.metrics[key];
                return [
                  t(`ops.${key}`),
                  number(m.requests),
                  number(m.errors),
                  number(Math.round(m.errorRate * 10000) / 100) + "%",
                  m.averageMs === null ? "—" : number(m.averageMs) + " ms",
                  number(m.aborted),
                ];
              })}
            />
            <Note>
              {t("ops.metricsNote", { since: date(report.metrics.since) })}
            </Note>
          </Panel>
          <Panel
            title={t(history ? "ops.history" : "ops.active")}
            action={
              <button
                className="text-link"
                onClick={() => setHistory(!history)}
              >
                {t(history ? "ops.active" : "ops.history")}
              </button>
            }
          >
            {report.alerts.length ? (
              <>
                <DataTable
                  caption={t(history ? "ops.history" : "ops.active")}
                  headers={[
                    t("common.status"),
                    t("ops.condition"),
                    t("ops.times"),
                    t("ops.acknowledge"),
                    t("common.actions"),
                  ]}
                  rows={report.alerts.map((a) => [
                    <Badge tone={a.resolvedAt ? "green" : "amber"}>
                      {t(
                        a.resolvedAt
                          ? "ops.resolved"
                          : a.severity === "critical"
                            ? "ops.critical"
                            : "ops.warning",
                      )}
                    </Badge>,
                    <div className="cost-reason">
                      <strong>{t(a.code as Key)}</strong>
                      <code className="cell-sub">{a.entityId}</code>
                      <code className="cell-sub">{a.id}</code>
                      {a.details.actual !== undefined && (
                        <small className="cell-sub">
                          {t("audit.expected")}:{" "}
                          {value(a.code, a.details.expected!)} ·{" "}
                          {t("audit.actual")}: {value(a.code, a.details.actual)}
                        </small>
                      )}
                    </div>,
                    <div>
                      {t("ops.detected")}: {date(a.detectedAt)}
                      <small className="cell-sub">
                        {t("ops.opened")}: {date(a.openedAt)}
                      </small>
                      <small className="cell-sub">
                        {t(a.resolvedAt ? "ops.resolved" : "ops.seen")}:{" "}
                        {date(a.resolvedAt || a.lastSeenAt)}
                      </small>
                    </div>,
                    a.ackAt ? (
                      <div>
                        {date(a.ackAt)}
                        <code className="cell-sub">{a.ackActorId}</code>
                      </div>
                    ) : (
                      "—"
                    ),
                    <button
                      className="text-link"
                      disabled={busy || !!a.ackAt || !!a.resolvedAt}
                      onClick={() =>
                        void act(`/api/admin/operations/alerts/${a.id}/ack`)
                      }
                    >
                      {t("ops.acknowledge")}
                    </button>,
                  ])}
                />
                {report.nextCursor && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void load(true)}
                  >
                    {t("cost.more")}
                  </button>
                )}
              </>
            ) : (
              <Empty title={t("ops.empty")} description={t("ops.emptyHint")} />
            )}
          </Panel>
          <Panel title={t("ops.notifications")}>
            {report.notifications.length ? (
              <DataTable
                caption={t("ops.notifications")}
                headers={[
                  t("common.status"),
                  t("ops.times"),
                  t("ops.attempts"),
                  t("common.actions"),
                ]}
                rows={report.notifications.map((n) => [
                  <div>
                    {t(`ops.${n.state}`)}
                    <code className="cell-sub">{n.id}</code>
                    {n.errorCode && (
                      <small className="cell-sub">
                        {t(`ops.${n.errorCode}`)}
                      </small>
                    )}
                  </div>,
                  <div>
                    {date(new Date(n.createdAt).toISOString())}
                    <small className="cell-sub">
                      {n.sentAt ? date(new Date(n.sentAt).toISOString()) : "—"}
                    </small>
                  </div>,
                  number(n.attempts),
                  <button
                    className="text-link"
                    disabled={
                      busy ||
                      n.state !== "failed" ||
                      n.errorCode === "expired" ||
                      !report.notificationsEnabled
                    }
                    onClick={() =>
                      void act(
                        `/api/admin/operations/notifications/${n.id}/retry`,
                      )
                    }
                  >
                    {t("common.retry")}
                  </button>,
                ])}
              />
            ) : (
              <Empty title={t("ops.noNotifications")} description="" />
            )}
            <Note>{t("ops.notificationNote")}</Note>
          </Panel>
        </>
      )}
      <Note>{t("ops.note")}</Note>
    </>
  );
}
