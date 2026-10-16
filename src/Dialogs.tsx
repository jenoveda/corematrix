import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ArrowRight } from "lucide-react";
import { useApp } from "./context";
import type { Dialog } from "./context";
import { useI18n } from "./i18n";
import { MICRO } from "./domain";
import type { Model } from "./domain";
import { Note } from "./components";
import LanguageSelect from "./LanguageSelect";
import InfrastructureDialog from "./InfrastructureDialog";
import RentalOrderDialog from "./RentalOrderDialog";
import ChatDialog from "./ChatDialog";
import { RechargeDialog } from "./Payments";
import { ReservationCancelDialog } from "./Reservations";
export default function Dialogs(props: { dialog: Dialog; close: () => void }) {
  if (props.dialog.type === "reservation-cancel")
    return (
      <ReservationCancelDialog
        id={props.dialog.reservationId}
        admin={!!props.dialog.admin}
        close={props.close}
      />
    );
  if (props.dialog.type === "recharge")
    return <RechargeDialog close={props.close} />;
  if (props.dialog.type === "try")
    return <ChatDialog modelId={props.dialog.modelId} close={props.close} />;
  if (
    props.dialog.type === "rental-renew" ||
    props.dialog.type === "rental-cancel"
  )
    return <RentalOrderDialog dialog={props.dialog} close={props.close} />;
  if (
    [
      "rent",
      "server",
      "server-token",
      "delete-server",
      "deploy",
      "deployment-stop",
      "deployment-cleanup",
      "deployment-events",
    ].includes(props.dialog.type)
  )
    return <InfrastructureDialog {...props} />;
  return <BaseDialog {...props} />;
}
function BaseDialog({ dialog, close }: { dialog: Dialog; close: () => void }) {
  const { state, mutate, notify } = useApp(),
    { t, money, errorText } = useI18n(),
    ref = useRef<HTMLDialogElement>(null),
    busyRef = useRef(false);
  const existing =
    "modelId" in dialog
      ? state.models.find((m) => m.id === dialog.modelId)
      : undefined;
  const [model, setModel] = useState<Model>(
    existing || {
      id: "",
      name: "",
      tag: "",
      description: "",
      inputPrice: 2 * MICRO,
      outputPrice: 6 * MICRO,
      gpus: 1,
      vram: 24,
      enabled: false,
      configured: false,
      contextTokens: 32768,
      maxOutputTokens: 4096,
      upstreamUrl: "",
      upstreamModel: "",
      apiKeyEnv: "",
      routingMode: "external",
      runtime: null,
    },
  );
  const [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(""),
    [amount, setAmount] = useState("100"),
    [reason, setReason] = useState("");
  const [costDay, setCostDay] = useState(
      new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    ),
    [category, setCategory] = useState("equipment"),
    [costServer, setCostServer] = useState(""),
    [costReference, setCostReference] = useState<string>(() =>
      crypto.randomUUID(),
    );
  const creditRef = useRef(crypto.randomUUID());
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  async function perform(fn: () => Promise<void>, dismiss = true) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (dismiss) close();
    } catch (e) {
      setError(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function field<K extends keyof Model>(key: K, value: Model[K]) {
    setModel((m) => ({
      ...m,
      [key]: value,
      ...(key === "gpus" && m.runtime
        ? { runtime: { ...m.runtime, tensorParallelSize: Number(value) } }
        : {}),
    }));
  }
  const title =
    dialog.type === "cost"
      ? t("cost.add")
      : dialog.type === "cost-void"
        ? t("cost.void")
        : dialog.type === "model"
          ? t(existing ? "model.configure" : "model.new")
          : dialog.type === "try"
            ? `${t("model.try")} · ${model.name}`
            : dialog.type === "credit"
              ? t("wallet.credit")
              : dialog.type === "delete-model"
                ? t("common.delete")
                : t("wallet.creditInfo");
  const errors = error !== null && (
    <p className="form-error" role="alert">
      {errorText(error)}
    </p>
  );
  const footer = (label: string) => (
    <div className="dialog-footer">
      <button type="button" className="button" disabled={busy} onClick={close}>
        {t("common.cancel")}
      </button>
      <button className="button primary" type="submit" disabled={busy}>
        {busy ? t("common.processing") : label}
        <ArrowRight size={16} />
      </button>
    </div>
  );
  return createPortal(
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onCancel={(e) => (busy ? e.preventDefault() : close())}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div className="dialog-content">
        <div className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <LanguageSelect />
          <button
            className="icon-button"
            disabled={busy}
            onClick={close}
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>
        {(dialog.type === "cost" || dialog.type === "cost-void") && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              perform(async () => {
                if (dialog.type === "cost")
                  await mutate("/api/admin/costs", "POST", {
                    category,
                    day: costDay,
                    amount: Math.round(Number(amount) * MICRO),
                    reason,
                    reference: costReference,
                    serverId: costServer || null,
                  });
                else if (dialog.type === "cost-void")
                  await mutate(
                    `/api/admin/costs/${dialog.costId}/void`,
                    "POST",
                    { reason },
                  );
                notify("common.saved");
              });
            }}
          >
            <div className="dialog-body form">
              <Note>
                {t(dialog.type === "cost" ? "cost.note" : "cost.voidNote")}
              </Note>
              {dialog.type === "cost" && (
                <>
                  <div className="form-grid">
                    <label>
                      {t("cost.category")}
                      <select
                        name="costCategory"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                      >
                        {(
                          [
                            "equipment",
                            "electricity",
                            "bandwidth",
                            "storage",
                            "operations",
                            "upstream",
                            "other",
                          ] as const
                        ).map((c) => (
                          <option key={c} value={c}>
                            {t(`cost.${c}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t("cost.day")}
                      <input
                        type="date"
                        name="costDay"
                        required
                        value={costDay}
                        onChange={(e) => setCostDay(e.target.value)}
                      />
                    </label>
                  </div>
                  <label>
                    {t("cost.amount")}
                    <input
                      type="number"
                      name="costAmount"
                      min="0.000001"
                      max="100000000"
                      step="0.000001"
                      required
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </label>
                  <label>
                    {t("cost.server")}
                    <select
                      name="costServer"
                      value={costServer}
                      onChange={(e) => setCostServer(e.target.value)}
                    >
                      <option value="">{t("cost.platform")}</option>
                      {state.servers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("cost.reference")}
                    <input
                      name="costReference"
                      minLength={8}
                      maxLength={100}
                      required
                      pattern="[a-zA-Z0-9._\-]{8,100}"
                      value={costReference}
                      onChange={(e) => setCostReference(e.target.value)}
                    />
                  </label>
                </>
              )}
              <label>
                {t("cost.reason")}
                <textarea
                  name="costReason"
                  maxLength={500}
                  required
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              {errors}
            </div>
            {footer(title)}
          </form>
        )}
        {dialog.type === "model" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              perform(async () => {
                await mutate(
                  existing
                    ? `/api/admin/models/${existing.id}`
                    : "/api/admin/models",
                  existing ? "PUT" : "POST",
                  model,
                );
                notify("common.saved");
              });
            }}
          >
            <div className="dialog-body form">
              <div className="form-grid">
                <label>
                  {t("model.id")}
                  <input
                    name="id"
                    value={model.id}
                    disabled={!!existing}
                    maxLength={100}
                    required
                    pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
                    onChange={(e) => field("id", e.target.value)}
                  />
                </label>
                <label>
                  {t("common.name")}
                  <input
                    name="name"
                    value={model.name}
                    maxLength={100}
                    required
                    onChange={(e) => field("name", e.target.value)}
                  />
                </label>
              </div>
              <label>
                {t("model.tag")}
                <input
                  value={model.tag}
                  maxLength={40}
                  required
                  onChange={(e) => field("tag", e.target.value)}
                />
              </label>
              <label>
                {t("model.summary")}
                <textarea
                  value={model.description}
                  maxLength={1000}
                  rows={2}
                  onChange={(e) => field("description", e.target.value)}
                />
              </label>
              <div className="form-grid">
                <label>
                  {t("model.inputPrice")}
                  <input
                    name="inputPrice"
                    type="number"
                    min="0"
                    max="10000"
                    step=".000001"
                    value={model.inputPrice / MICRO}
                    required
                    onChange={(e) =>
                      field(
                        "inputPrice",
                        Math.round(Number(e.target.value) * MICRO),
                      )
                    }
                  />
                </label>
                <label>
                  {t("model.outputPrice")}
                  <input
                    name="outputPrice"
                    type="number"
                    min="0"
                    max="10000"
                    step=".000001"
                    value={model.outputPrice / MICRO}
                    required
                    onChange={(e) =>
                      field(
                        "outputPrice",
                        Math.round(Number(e.target.value) * MICRO),
                      )
                    }
                  />
                </label>
              </div>
              <label>
                {t("model.mode")}
                <select
                  value={model.routingMode || "external"}
                  onChange={(e) =>
                    field(
                      "routingMode",
                      e.target.value as "external" | "managed",
                    )
                  }
                >
                  <option value="external">{t("model.external")}</option>
                  <option value="managed">{t("model.managed")}</option>
                </select>
              </label>
              {model.routingMode !== "managed" && (
                <label>
                  {t("model.upstream")}
                  <input
                    name="upstreamUrl"
                    type="url"
                    value={model.upstreamUrl || ""}
                    onChange={(e) => field("upstreamUrl", e.target.value)}
                  />
                </label>
              )}
              {model.routingMode !== "managed" && (
                <label>
                  {t("model.upstreamId")}
                  <input
                    name="upstreamModel"
                    value={model.upstreamModel}
                    maxLength={200}
                    required
                    onChange={(e) => field("upstreamModel", e.target.value)}
                  />
                </label>
              )}
              <label>
                {t("model.keyEnv")}
                <input
                  value={model.apiKeyEnv}
                  maxLength={80}
                  placeholder="INFERENCE_NODE_KEY"
                  onChange={(e) => field("apiKeyEnv", e.target.value)}
                />
              </label>
              <div className="form-grid">
                <label>
                  {t("model.inputLimit")}
                  <input
                    type="number"
                    min="1"
                    max="1000000"
                    value={model.contextTokens}
                    required
                    onChange={(e) =>
                      field("contextTokens", Number(e.target.value))
                    }
                  />
                </label>
                <label>
                  {t("model.outputLimit")}
                  <input
                    type="number"
                    min="1"
                    max="100000"
                    value={model.maxOutputTokens}
                    required
                    onChange={(e) =>
                      field("maxOutputTokens", Number(e.target.value))
                    }
                  />
                </label>
                <label>
                  {t("runtime.gpus")}
                  <input
                    type="number"
                    min="1"
                    max="64"
                    value={model.gpus}
                    required
                    onChange={(e) => field("gpus", Number(e.target.value))}
                  />
                </label>
                <label>
                  {t("runtime.vram")}
                  <input
                    type="number"
                    min="1"
                    max="1024"
                    value={model.vram}
                    required
                    onChange={(e) => field("vram", Number(e.target.value))}
                  />
                </label>
              </div>
              {model.routingMode === "managed" && (
                <RuntimeFields model={model} setModel={setModel} />
              )}
              <label className="checkbox-label">
                <input
                  name="enabled"
                  type="checkbox"
                  checked={model.enabled}
                  onChange={(e) => field("enabled", e.target.checked)}
                />
                {t("model.enabled")}
              </label>
              <Note>{t("model.configNote")}</Note>
              {errors}
            </div>
            {footer(t("common.save"))}
          </form>
        )}
        {dialog.type === "credit" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              perform(async () => {
                await mutate("/api/admin/credits", "POST", {
                  email,
                  amount: Math.round(Number(amount) * MICRO),
                  reason,
                  reference: creditRef.current,
                });
                notify("common.saved");
              });
            }}
          >
            <div className="dialog-body form">
              <label>
                {t("auth.email")}
                <input
                  type="email"
                  name="email"
                  value={email}
                  required
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                {t("wallet.creditAmount")}
                <input
                  name="amount"
                  type="number"
                  min=".000001"
                  max="100000"
                  step=".000001"
                  value={amount}
                  required
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <label>
                {t("wallet.creditReason")}
                <input
                  name="reason"
                  value={reason}
                  maxLength={200}
                  required
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <Note>{t("wallet.creditWarning")}</Note>
              {errors}
            </div>
            {footer(t("common.confirm"))}
          </form>
        )}
        {dialog.type === "delete-model" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              perform(async () => {
                await mutate(`/api/admin/models/${dialog.modelId}`, "DELETE");
                notify("common.saved");
              });
            }}
          >
            <div className="dialog-body form">
              <p>{t("model.deleteConfirm", { name: existing?.name || "" })}</p>
              {errors}
            </div>
            {footer(t("common.delete"))}
          </form>
        )}
        {dialog.type === "connect" && (
          <>
            <div className="dialog-body">
              <Note>{t("server.agentNote")}</Note>
            </div>
            <div className="dialog-footer">
              <button className="button primary" onClick={close}>
                {t("common.close")}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
function RuntimeFields({
  model,
  setModel,
}: {
  model: Model;
  setModel: React.Dispatch<React.SetStateAction<Model>>;
}) {
  const { t } = useI18n();
  const runtime = model.runtime || {
    artifact: "",
    revision: "",
    dtype: "auto" as const,
    maxModelLen: model.contextTokens + model.maxOutputTokens,
    minGpuMemoryMiB: 0,
    tensorParallelSize: model.gpus,
  };
  function patch(value: Partial<typeof runtime>) {
    setModel((m) => ({
      ...m,
      runtime: { ...runtime, ...value, tensorParallelSize: m.gpus },
    }));
  }
  return (
    <>
      <label>
        {t("runtime.artifact")}
        <input
          value={runtime.artifact}
          required
          onChange={(e) => patch({ artifact: e.target.value })}
        />
      </label>
      <label>
        {t("runtime.revision")}
        <input
          value={runtime.revision}
          required
          onChange={(e) => patch({ revision: e.target.value })}
        />
      </label>
      <label>
        {t("runtime.dtype")}
        <select
          value={runtime.dtype}
          onChange={(e) =>
            patch({ dtype: e.target.value as typeof runtime.dtype })
          }
        >
          <option>auto</option>
          <option>float16</option>
          <option>bfloat16</option>
        </select>
      </label>
      <div className="form-grid">
        <label>
          {t("runtime.length")}
          <input
            type="number"
            min={model.contextTokens + model.maxOutputTokens}
            max="1100000"
            value={runtime.maxModelLen}
            required
            onChange={(e) => patch({ maxModelLen: Number(e.target.value) })}
          />
        </label>
        <label>
          {t("runtime.memory")}
          <input
            type="number"
            min="1"
            max="1048576"
            value={runtime.minGpuMemoryMiB}
            required
            onChange={(e) => patch({ minGpuMemoryMiB: Number(e.target.value) })}
          />
        </label>
      </div>
    </>
  );
}
