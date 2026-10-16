import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { MICRO } from "./domain";
import LanguageSelect from "./LanguageSelect";
import { useApp } from "./context";
import type { Dialog } from "./context";
import { useI18n } from "./i18n";
import { request } from "./api";
import { Note, DataTable } from "./components";
export default function InfrastructureDialog({
  dialog,
  close,
}: {
  dialog: Dialog;
  close: () => void;
}) {
  const { state, mutate, notify } = useApp(),
    { t, status, date, errorText } = useI18n(),
    ref = useRef<HTMLDialogElement>(null),
    busyRef = useRef(false);
  const existing =
    "serverId" in dialog
      ? state.servers.find((s) => s.id === dialog.serverId)
      : undefined;
  const [node, setNode] = useState(
    existing || {
      workMode: "inference" as const,
      rentalSalesEnabled: false,
      hourlyPrice: 0,
      name: "",
      region: "",
      inferenceHost: "http://",
      portStart: 8000,
      portEnd: 8031,
      schedulingEnabled: true,
      maintenance: false,
    },
  );
  const [modelId, setModelId] = useState(
      state.models.find((m) => m.routingMode === "managed")?.id || "",
    ),
    [serverId, setServerId] = useState(
      state.servers.find(
        (s) =>
          s.freeGpuCount > 0 &&
          s.workMode === (dialog.type === "rent" ? "gpu-rental" : "inference"),
      )?.id || "",
    ),
    [gpuUuids, setGpus] = useState<string[]>([]),
    [token, setToken] = useState(""),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [events, setEvents] = useState<
      { id: number; event: string; message: string; time: string }[]
    >([]),
    [cursor, setCursor] = useState(0),
    [more, setMore] = useState(true);
  const [ownerEmail, setOwnerEmail] = useState("");
  const rental = dialog.type === "rent";
  const idem = useRef({ body: "", key: crypto.randomUUID() }),
    model = state.models.find((m) => m.id === modelId),
    server = state.servers.find((s) => s.id === serverId);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  async function load() {
    if (dialog.type !== "deployment-events") return;
    try {
      const r = await request<{ data: typeof events; nextCursor: number }>(
        `/api/admin/deployments/${dialog.deploymentId}/events?after=${cursor}`,
      );
      setEvents((e) => [...e, ...r.data]);
      setCursor(r.nextCursor);
      setMore(r.data.length === 50);
    } catch (e) {
      setError(e);
    }
  }
  useEffect(() => {
    if (dialog.type === "deployment-events") void load();
  }, []);
  const title = t(
    rental
      ? "rental.create"
      : dialog.type === "server"
        ? "server.add"
        : dialog.type === "server-token"
          ? "server.rotate"
          : dialog.type === "deploy"
            ? "deployment.create"
            : dialog.type === "deployment-events"
              ? "deployment.events"
              : dialog.type === "delete-server"
                ? "common.delete"
                : "deployment.stop",
  );
  async function submit() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (dialog.type === "server") {
        const result = await mutate<{ agentToken?: string }>(
          existing ? `/api/admin/servers/${existing.id}` : "/api/admin/servers",
          existing ? "PUT" : "POST",
          node,
        );
        if (result.agentToken) {
          setToken(result.agentToken);
          return;
        }
      }
      if (dialog.type === "server-token") {
        const result = await mutate<{ agentToken: string }>(
          `/api/admin/servers/${dialog.serverId}/token`,
          "POST",
        );
        setToken(result.agentToken);
        return;
      }
      if (dialog.type === "delete-server")
        await mutate(`/api/admin/servers/${dialog.serverId}`, "DELETE");
      if (dialog.type === "deploy" || rental) {
        const body = {
            ...(rental ? { ownerEmail } : { modelId }),
            serverId,
            gpuUuids,
            ...(dialog.type === "deploy" && dialog.replaces
              ? { replaces: dialog.replaces }
              : {}),
          },
          serialized = JSON.stringify(body);
        if (idem.current.body !== serialized)
          idem.current = { body: serialized, key: crypto.randomUUID() };
        await mutate(
          rental ? "/api/admin/rentals" : "/api/admin/deployments",
          "POST",
          body,
          idem.current.key,
        );
      }
      if (
        dialog.type === "deployment-stop" ||
        dialog.type === "deployment-cleanup"
      )
        await mutate(
          `/api/admin/deployments/${dialog.deploymentId}/${dialog.type === "deployment-stop" ? "stop" : "retry-cleanup"}`,
          "POST",
        );
      notify("common.saved");
      close();
    } catch (e) {
      setError(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const field = (key: string, value: unknown) =>
    setNode((n) => ({
      ...n,
      [key]: value,
      ...(key === "workMode" && value === "inference"
        ? { rentalSalesEnabled: false }
        : {}),
    }));
  return createPortal(
    <dialog
      className="dialog"
      ref={ref}
      aria-labelledby="infra-title"
      onCancel={(e) => (busy ? e.preventDefault() : close())}
    >
      <div className="dialog-content">
        <div className="dialog-header">
          <h2 id="infra-title">{title}</h2>
          <LanguageSelect />
          <button
            className="icon-button"
            onClick={close}
            disabled={busy}
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="dialog-body form">
            {token ? (
              <>
                <Note>{t("server.tokenNote")}</Note>
                <label>
                  {t("server.token")}
                  <input
                    readOnly
                    value={token}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </label>
                <button
                  className="button"
                  type="button"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(token)
                      .then(() => notify("common.copied"))
                      .catch(() => notify("common.copyFailed", true))
                  }
                >
                  {t("common.copy")}
                </button>
              </>
            ) : (
              <>
                {dialog.type === "server" && (
                  <>
                    <label>
                      {t("common.name")}
                      <input
                        name="name"
                        value={node.name}
                        maxLength={80}
                        required
                        onChange={(e) => field("name", e.target.value)}
                      />
                    </label>
                    <label>
                      {t("server.mode")}
                      <select
                        name="workMode"
                        value={node.workMode}
                        onChange={(e) => field("workMode", e.target.value)}
                      >
                        <option value="inference">{t("mode.inference")}</option>
                        <option value="gpu-rental">
                          {t("mode.gpu-rental")}
                        </option>
                      </select>
                    </label>
                    {node.workMode === "gpu-rental" && (
                      <>
                        <label className="checkbox-label">
                          <input
                            name="rentalSalesEnabled"
                            type="checkbox"
                            checked={node.rentalSalesEnabled}
                            onChange={(e) =>
                              field("rentalSalesEnabled", e.target.checked)
                            }
                          />
                          {t("rental.salesEnabled")}
                        </label>
                        <label>
                          {t("rental.hourlyPrice")}
                          <input
                            name="hourlyPrice"
                            type="number"
                            min={node.rentalSalesEnabled ? "0.000001" : "0"}
                            max="10000"
                            step="0.000001"
                            value={node.hourlyPrice / MICRO}
                            required
                            onChange={(e) =>
                              field(
                                "hourlyPrice",
                                Math.round(Number(e.target.value) * MICRO),
                              )
                            }
                          />
                        </label>
                        <Note>{t("rental.salesNote")}</Note>
                      </>
                    )}
                    <label>
                      {t("server.region")}
                      <input
                        name="region"
                        value={node.region}
                        maxLength={80}
                        required
                        onChange={(e) => field("region", e.target.value)}
                      />
                    </label>
                    <label>
                      {t("server.host")}
                      <input
                        name="inferenceHost"
                        type="url"
                        placeholder="http://10.0.0.8"
                        value={node.inferenceHost}
                        required
                        onChange={(e) => field("inferenceHost", e.target.value)}
                      />
                    </label>
                    <div className="form-grid">
                      <label>
                        {t("server.portStart")}
                        <input
                          type="number"
                          min={1024}
                          max={65535}
                          value={node.portStart}
                          required
                          onChange={(e) =>
                            field("portStart", Number(e.target.value))
                          }
                        />
                      </label>
                      <label>
                        {t("server.portEnd")}
                        <input
                          type="number"
                          min={node.portStart}
                          max={Math.min(node.portStart + 31, 65535)}
                          value={node.portEnd}
                          required
                          onChange={(e) =>
                            field("portEnd", Number(e.target.value))
                          }
                        />
                      </label>
                    </div>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={node.schedulingEnabled}
                        onChange={(e) =>
                          field("schedulingEnabled", e.target.checked)
                        }
                      />
                      {t("server.scheduling")}
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={node.maintenance}
                        onChange={(e) => field("maintenance", e.target.checked)}
                      />
                      {t("server.maintenance")}
                    </label>
                    <Note>{t("server.agentNote")}</Note>
                  </>
                )}
                {dialog.type === "server-token" && (
                  <Note>{t("server.rotateConfirm")}</Note>
                )}
                {dialog.type === "delete-server" && (
                  <p>
                    {t("server.deleteConfirm", { name: existing?.name || "" })}
                  </p>
                )}
                {(dialog.type === "deploy" || rental) && (
                  <>
                    {rental ? (
                      <label>
                        {t("rental.owner")}
                        <input
                          type="email"
                          name="ownerEmail"
                          required
                          maxLength={254}
                          value={ownerEmail}
                          onChange={(e) => setOwnerEmail(e.target.value)}
                        />
                      </label>
                    ) : (
                      <>
                        <label>
                          {t("deployment.model")}
                          <select
                            value={modelId}
                            required
                            onChange={(e) => {
                              setModelId(e.target.value);
                              setGpus([]);
                            }}
                          >
                            <option value="">—</option>
                            {state.models
                              .filter((m) => m.routingMode === "managed")
                              .map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                          </select>
                        </label>
                      </>
                    )}
                    <label>
                      {t("deployment.server")}
                      <select
                        required
                        value={serverId}
                        onChange={(e) => {
                          setServerId(e.target.value);
                          setGpus([]);
                        }}
                      >
                        <option value="">—</option>
                        {state.servers.map((s) => (
                          <option
                            key={s.id}
                            value={s.id}
                            disabled={
                              !s.freeGpuCount ||
                              s.workMode !==
                                (rental ? "gpu-rental" : "inference")
                            }
                          >
                            {s.name} · {status(s.status)} · {s.freeGpuCount} GPU
                          </option>
                        ))}
                      </select>
                    </label>
                    <fieldset>
                      <legend>{t("deployment.gpus")}</legend>
                      {!rental && model && (
                        <p className="form-help">
                          {t("deployment.required", {
                            count: model.gpus,
                            memory: model.runtime?.minGpuMemoryMiB || 0,
                          })}
                        </p>
                      )}
                      {server?.gpus.map((g) => (
                        <label key={g.uuid} className="checkbox-label">
                          <input
                            type="checkbox"
                            disabled={
                              g.missing ||
                              g.allocated ||
                              g.externalBusy ||
                              g.totalMemoryMiB <
                                (rental
                                  ? 0
                                  : model?.runtime?.minGpuMemoryMiB || 0)
                            }
                            checked={gpuUuids.includes(g.uuid)}
                            onChange={(e) =>
                              setGpus((v) =>
                                e.target.checked
                                  ? [...v, g.uuid]
                                  : v.filter((x) => x !== g.uuid),
                              )
                            }
                          />
                          {g.index} · {g.name} · {g.totalMemoryMiB} MiB{" "}
                          <small>{g.uuid}</small>
                        </label>
                      ))}
                    </fieldset>
                    <Note>
                      {t(rental ? "rental.note" : "deployment.rollingNote")}
                    </Note>
                  </>
                )}
                {(dialog.type === "deployment-stop" ||
                  dialog.type === "deployment-cleanup") && (
                  <Note>
                    {t("deployment.stopConfirm", {
                      name:
                        state.deployments.find(
                          (d) => d.id === dialog.deploymentId,
                        )?.modelId || "",
                    })}
                  </Note>
                )}
                {dialog.type === "deployment-events" && (
                  <>
                    <DataTable
                      caption={t("deployment.events")}
                      headers={[
                        t("common.time"),
                        t("common.status"),
                        t("common.details"),
                      ]}
                      rows={events.map((e) => [
                        date(new Date(e.time).toISOString()),
                        status(e.event === "healthy" ? "checking" : e.event),
                        <code>{e.message || "—"}</code>,
                      ])}
                    />
                    {more && (
                      <button
                        className="button"
                        type="button"
                        onClick={() => void load()}
                      >
                        {t("common.refresh")}
                      </button>
                    )}
                  </>
                )}
              </>
            )}
            {error !== null && (
              <p className="form-error" role="alert">
                {errorText(error)}
              </p>
            )}
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={close}
            >
              {t(
                token || dialog.type === "deployment-events"
                  ? "common.close"
                  : "common.cancel",
              )}
            </button>
            {!token && dialog.type !== "deployment-events" && (
              <button
                className="button primary"
                type="submit"
                disabled={
                  busy ||
                  ((dialog.type === "deploy" || rental) &&
                    (rental
                      ? gpuUuids.length === 0
                      : !model || gpuUuids.length !== model.gpus))
                }
              >
                {t(busy ? "common.processing" : "common.confirm")}
              </button>
            )}
          </div>
        </form>
      </div>
    </dialog>,
    document.body,
  );
}
