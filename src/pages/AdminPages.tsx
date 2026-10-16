import { useState, useEffect, useRef } from "react";
import { request } from "../api";
import type { FinancialReport, Reconciliation } from "../domain";
import { Plus, Wallet } from "lucide-react";
import { useApp } from "../context";
import { useI18n } from "../i18n";
import {
  Badge,
  DataTable,
  Empty,
  Note,
  PageHeader,
  Panel,
  RevenueChart,
  Stat,
  Stats,
} from "../components";
import InfrastructurePages from "./InfrastructurePages";
import Operations from "../Operations";
import { PaymentOrders } from "../Payments";
import Certificates from "../Certificates";
import { AdminProviders } from "../Providers";
function Overview() {
  const { state, open, refresh, notify } = useApp(),
    { t, money, number, status } = useI18n(),
    s = state.summary!;
  return (
    <>
      <PageHeader
        title={t("nav.overview")}
        description={t("reports.note")}
        actions={
          <>
            <button
              className="button"
              onClick={() => refresh().catch((e) => notify(e, true))}
            >
              {t("common.refresh")}
            </button>
            <button
              className="button primary"
              onClick={() => open({ type: "model" })}
            >
              <Plus size={16} />
              {t("model.new")}
            </button>
          </>
        }
      />
      <Stats>
        <Stat label={t("reports.revenue")} value={money(s.revenue)} detail="" />
        <Stat label={t("reports.credits")} value={money(s.credits)} detail="" />
        <Stat label={t("reports.users")} value={number(s.users)} detail="" />
        <Stat
          label={t("reports.requests")}
          value={number(s.requests)}
          detail=""
        />
      </Stats>
      <div className="grid grid-two">
        <Panel title={t("overview.resources")}>
          <DataTable
            caption={t("overview.resources")}
            headers={[t("overview.item"), t("overview.count")]}
            rows={[
              [
                <a className="text-link" href="#/admin/servers">
                  {t("nav.servers")}
                </a>,
                number(state.servers.length),
              ],
              ...["online", "pending", "offline", "disabled"].map((kind) => [
                <span>
                  {t("nav.servers")} · {status(kind)}
                </span>,
                number(state.servers.filter((n) => n.status === kind).length),
              ]),
              [
                <span>
                  {t("nav.servers")} · {status("maintenance")}
                </span>,
                number(state.servers.filter((n) => n.maintenance).length),
              ],
              [
                t("overview.inventoryErrors"),
                number(state.servers.filter((n) => n.inventoryError).length),
              ],
              [
                t("gpu.total"),
                number(
                  new Set(
                    state.servers.flatMap((n) =>
                      n.gpus.filter((g) => !g.missing).map((g) => g.uuid),
                    ),
                  ).size,
                ),
              ],
              [
                t("gpu.allocated"),
                number(
                  new Set(
                    state.servers.flatMap((n) =>
                      n.gpus.filter((g) => g.allocated).map((g) => g.uuid),
                    ),
                  ).size,
                ),
              ],
              [
                t("gpu.free"),
                number(
                  state.servers.reduce((count, n) => count + n.freeGpuCount, 0),
                ),
              ],
            ]}
          />
        </Panel>
        <Panel title={t("overview.deploymentStatus")}>
          <DataTable
            caption={t("overview.deploymentStatus")}
            headers={[t("common.status"), t("overview.count")]}
            rows={[
              [
                <a className="text-link" href="#/admin/deployments">
                  {t("nav.deployments")}
                </a>,
                number(state.deployments.length),
              ],
              ...[
                "queued",
                "starting",
                "checking",
                "ready",
                "draining",
                "stopping",
                "failed",
                "unknown",
                "stopped",
              ].map((phase) => [
                status(phase),
                number(
                  state.deployments.filter((d) => d.phase === phase).length,
                ),
              ]),
            ]}
          />
        </Panel>
      </div>
      <Note>{t("overview.resourceNote")}</Note>
      <div className="grid grid-two">
        <Panel title={t("reports.daily")}>
          <RevenueChart values={s.daily} />
        </Panel>
        <Panel title={t("nav.models")}>
          <div className="panel-body resource-list">
            {state.models.map((m) => (
              <div key={m.id} className="row between">
                <strong>{m.name}</strong>
                <Badge tone={m.enabled && m.configured ? "green" : "amber"}>
                  {t(
                    !m.enabled
                      ? "status.unpublished"
                      : m.configured
                        ? "status.configured"
                        : "reports.unavailable",
                  )}
                </Badge>
              </div>
            ))}
            <a className="text-link" href="#/admin/pricing">
              {t("nav.pricing")}
            </a>
          </div>
        </Panel>
      </div>
      <Note>{t("reports.note")}</Note>
    </>
  );
}
function Pricing() {
  const { state, open } = useApp(),
    { t, money } = useI18n();
  return (
    <>
      <PageHeader
        title={t("nav.pricing")}
        description={t("model.configNote")}
        actions={
          <>
            <button className="button" onClick={() => open({ type: "credit" })}>
              <Wallet size={16} />
              {t("wallet.credit")}
            </button>
            <button
              className="button primary"
              onClick={() => open({ type: "model" })}
            >
              <Plus size={16} />
              {t("model.new")}
            </button>
          </>
        }
      />
      <Panel title={t("model.configure")}>
        {state.models.length ? (
          <DataTable
            caption={t("model.configure")}
            headers={[
              t("deployment.model"),
              t("model.input"),
              t("model.output"),
              t("common.status"),
              t("common.actions"),
            ]}
            rows={state.models.map((m) => [
              <div>
                <strong>{m.name}</strong>
                <code className="cell-sub">{m.id}</code>
              </div>,
              money(m.inputPrice),
              money(m.outputPrice),
              <Badge tone={m.enabled && m.configured ? "green" : "amber"}>
                {t(
                  !m.enabled
                    ? "status.unpublished"
                    : m.configured
                      ? "status.configured"
                      : "reports.unavailable",
                )}
              </Badge>,
              <div className="actions">
                <button
                  className="text-link"
                  onClick={() => open({ type: "model", modelId: m.id })}
                >
                  {t("common.edit")}
                </button>
                <button
                  className="text-link negative"
                  onClick={() => open({ type: "delete-model", modelId: m.id })}
                >
                  {t("common.delete")}
                </button>
              </div>,
            ])}
          />
        ) : (
          <Empty title={t("model.empty")} description={t("model.emptyHint")} />
        )}
      </Panel>
      <Note>{t("model.priceNote")}</Note>
      <PaymentOrders admin />
    </>
  );
}
function Reports() {
  const { state, open } = useApp(),
    { t, money, date, errorText, number } = useI18n();
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(today.slice(0, 7) + "-01"),
    [to, setTo] = useState(today),
    [range, setRange] = useState({ from, to });
  const [report, setReport] = useState<FinancialReport | null>(null),
    [audit, setAudit] = useState<Reconciliation | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    seq = useRef(0);
  async function load(more = false) {
    const id = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams(range);
      if (more && report?.nextCursor)
        query.set("before", String(report.nextCursor));
      const [data, check] = await Promise.all([
        request<FinancialReport>("/api/admin/reports?" + query),
        request<Reconciliation>("/api/admin/reconciliation"),
      ]);
      if (id === seq.current) {
        setReport((old) => ({
          ...data,
          expenses:
            more && old ? [...old.expenses, ...data.expenses] : data.expenses,
        }));
        setAudit(check);
      }
    } catch (e) {
      if (id === seq.current) setError(e);
    } finally {
      if (id === seq.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [state, range]);
  return (
    <>
      <PageHeader
        title={t("nav.reports")}
        description={t("cost.note")}
        actions={
          <button
            className="button primary"
            onClick={() => open({ type: "cost" })}
          >
            <Plus size={16} />
            {t("cost.add")}
          </button>
        }
      />
      <form
        className="panel panel-body form"
        onSubmit={(e) => {
          e.preventDefault();
          setRange({ from, to });
        }}
      >
        <div className="form-grid">
          <label>
            {t("cost.from")}
            <input
              type="date"
              name="reportFrom"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            {t("cost.to")}
            <input
              type="date"
              name="reportTo"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        <button className="button" disabled={busy}>
          {t(busy ? "common.processing" : "cost.apply")}
        </button>
      </form>
      {error !== null && (
        <p role="alert" className="form-error">
          {errorText(error)}
        </p>
      )}
      {report && (
        <>
          <p className="muted">
            {t("cost.from")}: {report.from} · {t("cost.to")}: {report.to}{" "}
            (UTC+8)
          </p>
          <Stats>
            <Stat
              label={t("reports.revenue")}
              value={money(report.revenue)}
              detail={`${t("wallet.token")}: ${money(report.tokenRevenue)} · GPU: ${money(report.gpuRevenue)}`}
            />
            <Stat
              label={t("reports.credits")}
              value={money(report.credits)}
              detail=""
            />
            <Stat
              label={t("cost.recorded")}
              value={report.costRecorded ? money(report.cost) : t("cost.none")}
              detail=""
            />
            <Stat
              label={t("cost.profit")}
              value={report.profit === null ? "—" : money(report.profit)}
              detail={t("cost.provisional")}
            />
          </Stats>
          <Panel title={t("reports.daily")}>
            <DataTable
              caption={t("reports.daily")}
              headers={[
                t("cost.day"),
                t("reports.revenue"),
                t("cost.recorded"),
              ]}
              rows={report.daily.map((d) => [
                d.day,
                money(d.revenue),
                money(d.cost),
              ])}
            />
          </Panel>
          <Panel title={t("reports.byModel")}>
            <DataTable
              caption={t("reports.byModel")}
              headers={[
                t("deployment.model"),
                t("reports.revenue"),
                t("reports.inputTokens"),
                t("reports.outputTokens"),
              ]}
              rows={report.byModel.map((m) => [
                m.name,
                money(m.revenue),
                number(m.inputTokens),
                number(m.outputTokens),
              ])}
            />
          </Panel>
          <Panel title={t("cost.categories")}>
            <DataTable
              caption={t("cost.categories")}
              headers={[t("cost.category"), t("common.amount")]}
              rows={report.byCategory.map((c) => [
                t(`cost.${c.category}`),
                money(c.amount),
              ])}
            />
          </Panel>
          <Panel title={t("cost.entries")}>
            {report.expenses.length ? (
              <>
                <DataTable
                  caption={t("cost.entries")}
                  headers={[
                    t("cost.day"),
                    t("cost.category"),
                    t("cost.server"),
                    t("common.amount"),
                    t("cost.reason"),
                    t("common.status"),
                    t("common.actions"),
                  ]}
                  rows={report.expenses.map((e) => [
                    e.day,
                    <div>
                      {t(`cost.${e.category}`)}
                      <code className="cell-sub">{e.reference}</code>
                    </div>,
                    e.serverName || t("cost.platform"),
                    money(e.amount),
                    <div className="cost-reason">
                      {e.reason}
                      {e.voidReason && (
                        <small className="cell-sub">{e.voidReason}</small>
                      )}
                    </div>,
                    t(e.voidedAt ? "cost.voided" : "cost.effective"),
                    <button
                      className="text-link negative"
                      disabled={!!e.voidedAt}
                      onClick={() => open({ type: "cost-void", costId: e.id })}
                    >
                      {t("cost.void")}
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
              <Empty title={t("cost.none")} description={t("cost.note")} />
            )}
          </Panel>
        </>
      )}
      {audit && (
        <Panel title={t("audit.title")}>
          <div className="panel-body">
            <Badge tone={audit.healthy ? "green" : "amber"}>
              {t(audit.healthy ? "audit.healthy" : "audit.unhealthy")}
            </Badge>
            <small className="cell-sub">{date(audit.checkedAt)}</small>
          </div>
          {audit.issues.length > 0 && (
            <DataTable
              caption={t("audit.title")}
              headers={[
                t("common.status"),
                "ID",
                t("audit.expected"),
                t("audit.actual"),
              ]}
              rows={audit.issues.map((i) => [
                t(`audit.${i.code}` as import("../i18n").Key),
                <code>{i.entityId}</code>,
                [
                  "stopped_gpu_allocated",
                  "payment_review",
                  "reservation_order_mismatch",
                  "reservation_overlap",
                  "duplicate_gpu_allocation",
                ].includes(i.code)
                  ? number(i.expected)
                  : money(i.expected),
                [
                  "stopped_gpu_allocated",
                  "payment_review",
                  "reservation_order_mismatch",
                  "reservation_overlap",
                  "duplicate_gpu_allocation",
                ].includes(i.code)
                  ? number(i.actual)
                  : money(i.actual),
              ])}
            />
          )}
          <Note>{t("audit.note")}</Note>
        </Panel>
      )}
    </>
  );
}
export default function AdminPages({ page }: { page: string }) {
  if (page === "providers") return <AdminProviders />;
  if (page === "certificates") return <Certificates />;
  if (page === "operations") return <Operations />;
  if (page === "pricing") return <Pricing />;
  if (page === "reports") return <Reports />;
  if (page === "servers" || page === "deployments")
    return <InfrastructurePages page={page} />;
  return <Overview />;
}
