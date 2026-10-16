import { useEffect } from "react";
import { ReservationList } from "../Reservations";
import { Plus, RefreshCw } from "lucide-react";
import { useApp } from "../context";
import { useI18n } from "../i18n";
import {
  PageHeader,
  Panel,
  Stats,
  Stat,
  Badge,
  Note,
  Empty,
  DataTable,
} from "../components";
export default function InfrastructurePages({ page }: { page: string }) {
  const { state, open, refresh, notify } = useApp(),
    { t, date, number, status } = useI18n();
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) refresh().catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, []);
  const refreshButton = (
    <button
      className="button"
      onClick={() => refresh().catch((e) => notify(e, true))}
    >
      <RefreshCw size={16} />
      {t("common.refresh")}
    </button>
  );
  if (page === "servers")
    return (
      <>
        <PageHeader
          title={t("nav.servers")}
          description={t("server.description")}
          actions={
            <>
              {refreshButton}
              <button
                className="button primary"
                onClick={() => open({ type: "server" })}
              >
                <Plus size={16} />
                {t("server.add")}
              </button>
            </>
          }
        />
        <Stats>
          <Stat
            label={t("nav.servers")}
            value={number(state.servers.length)}
            detail={t("server.heartbeat")}
          />
          <Stat
            label={t("gpu.total")}
            value={number(
              new Set(
                state.servers.flatMap((s) =>
                  s.gpus.filter((g) => !g.missing).map((g) => g.uuid),
                ),
              ).size,
            )}
            detail={t("server.agentNote")}
          />
          <Stat
            label={t("gpu.allocated")}
            value={number(
              new Set(
                state.servers.flatMap((s) =>
                  s.gpus.filter((g) => g.allocated).map((g) => g.uuid),
                ),
              ).size,
            )}
            detail={t("deployment.held")}
          />
          <Stat
            label={t("gpu.free")}
            value={number(
              state.servers.reduce((a, s) => a + s.freeGpuCount, 0),
            )}
            detail={t("server.scheduling")}
          />
        </Stats>
        <Note>{t("server.agentNote")}</Note>
        {!state.servers.length && (
          <Empty
            title={t("server.empty")}
            description={t("server.description")}
          />
        )}
        <div className="node-list">
          {state.servers.map((s) => (
            <Panel
              key={s.id}
              title={`${s.name} · ${s.region} · ${t(s.workMode === "gpu-rental" ? "mode.gpu-rental" : "mode.inference")}`}
              action={
                <Badge tone={s.status === "online" ? "green" : "amber"}>
                  {status(s.status)}
                  {s.maintenance ? ` · ${t("status.maintenance")}` : ""}
                </Badge>
              }
            >
              <div className="node-meta">
                <span>
                  {s.inferenceHost} · {s.portStart}–{s.portEnd}
                </span>
                <span>
                  {t("server.heartbeat")}: {date(s.lastHeartbeatAt)}
                </span>
              </div>
              {s.inventoryError && (
                <p className="form-error">
                  {s.inventoryError === "duplicate_gpu_identity"
                    ? t("server.duplicateGpu")
                    : s.inventoryError}
                </p>
              )}
              {s.gpus.length ? (
                <DataTable
                  caption={t("nav.servers")}
                  headers={[
                    "GPU",
                    t("gpu.memory"),
                    t("gpu.utilization"),
                    t("gpu.temperature"),
                    t("common.status"),
                  ]}
                  rows={s.gpus.map((g) => [
                    <div>
                      <strong>
                        {g.index} · {g.name}
                      </strong>
                      <small className="block code">{g.uuid}</small>
                      <small className="block">{date(g.lastSeenAt)}</small>
                      {g.allocated && (
                        <small className="block">
                          {state.deployments
                            .filter(
                              (d) =>
                                d.allocated &&
                                d.serverId === s.id &&
                                d.spec.gpuUuids.includes(g.uuid),
                            )
                            .map(
                              (d) =>
                                state.models.find((m) => m.id === d.modelId)
                                  ?.name || d.modelId,
                            )
                            .join(", ")}
                        </small>
                      )}
                    </div>,
                    `${g.usedMemoryMiB === null ? "—" : number(g.usedMemoryMiB)} / ${number(g.totalMemoryMiB)} MiB`,
                    g.utilizationPercent === null
                      ? "—"
                      : `${number(g.utilizationPercent)}%`,
                    g.temperatureC === null
                      ? "—"
                      : `${number(g.temperatureC)} °C`,
                    <Badge
                      tone={
                        g.allocated || g.externalBusy || g.missing
                          ? "amber"
                          : "green"
                      }
                    >
                      {g.missing
                        ? t("gpu.missing")
                        : g.allocated
                          ? t("gpu.allocated")
                          : g.externalBusy
                            ? t("gpu.external")
                            : t("gpu.free")}
                    </Badge>,
                  ])}
                />
              ) : (
                <Empty
                  title={t("gpu.none")}
                  description={t("server.agentNote")}
                />
              )}
              <div className="node-actions">
                <button
                  className="button"
                  onClick={() => open({ type: "server", serverId: s.id })}
                >
                  {t("common.edit")}
                </button>
                <button
                  className="button"
                  onClick={() => open({ type: "server-token", serverId: s.id })}
                >
                  {t("server.rotate")}
                </button>
                <button
                  className="button danger"
                  onClick={() =>
                    open({ type: "delete-server", serverId: s.id })
                  }
                >
                  {t("common.delete")}
                </button>
              </div>
            </Panel>
          ))}
        </div>
        <ReservationList admin />
      </>
    );
  return (
    <>
      <PageHeader
        title={t("nav.deployments")}
        description={t("deployment.description")}
        actions={
          <>
            {refreshButton}
            <button className="button" onClick={() => open({ type: "rent" })}>
              {t("rental.create")}
            </button>
            <button
              className="button primary"
              onClick={() => open({ type: "deploy" })}
            >
              <Plus size={16} />
              {t("deployment.create")}
            </button>
          </>
        }
      />
      <Note>{t("deployment.rollingNote")}</Note>
      <Panel title={t("nav.deployments")}>
        {!state.deployments.length ? (
          <Empty
            title={t("deployment.empty")}
            description={t("deployment.description")}
          />
        ) : (
          <DataTable
            caption={t("nav.deployments")}
            headers={[
              t("deployment.model"),
              t("deployment.server"),
              t("deployment.gpus"),
              t("common.status"),
              t("common.actions"),
            ]}
            rows={state.deployments.map((d) => [
              <div>
                <strong>
                  {d.workloadType === "gpu-rental"
                    ? t("mode.gpu-rental")
                    : state.models.find((m) => m.id === d.modelId)?.name ||
                      d.modelId}
                </strong>
                <small className="block code">{d.id}</small>
              </div>,
              <div>
                {state.servers.find((s) => s.id === d.serverId)?.name}
                <small className="block">:{d.spec.endpointPort}</small>
              </div>,
              <div>
                {d.spec.gpuUuids.length}
                <small className="block">
                  {d.workloadType === "gpu-rental"
                    ? "JupyterLab"
                    : `${d.spec.dtype} · ${d.spec.maxModelLen}`}
                </small>
              </div>,
              <div>
                <Badge tone={d.phase === "ready" ? "green" : "amber"}>
                  {status(d.phase)}
                </Badge>
                {d.allocated && (
                  <small className="block">{t("deployment.held")}</small>
                )}
                {d.lastError && (
                  <small className="block code">{d.lastError}</small>
                )}
              </div>,
              <div className="row-actions">
                <button
                  className="text-link"
                  onClick={() =>
                    open({ type: "deployment-events", deploymentId: d.id })
                  }
                >
                  {t("deployment.events")}
                </button>
                {d.phase === "ready" && d.workloadType !== "gpu-rental" && (
                  <button
                    className="text-link"
                    onClick={() => open({ type: "deploy", replaces: d.id })}
                  >
                    {t("deployment.switch")}
                  </button>
                )}
                {!["stopped", "stopping", "draining"].includes(d.phase) && (
                  <button
                    className="text-link"
                    onClick={() =>
                      open({ type: "deployment-stop", deploymentId: d.id })
                    }
                  >
                    {t("deployment.stop")}
                  </button>
                )}
                {["failed", "unknown"].includes(d.phase) && (
                  <button
                    className="text-link"
                    onClick={() =>
                      open({ type: "deployment-cleanup", deploymentId: d.id })
                    }
                  >
                    {t("deployment.cleanup")}
                  </button>
                )}
              </div>,
            ])}
          />
        )}
      </Panel>
    </>
  );
}
