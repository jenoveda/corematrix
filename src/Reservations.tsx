import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useApp } from "./context";
import { useI18n } from "./i18n";
import { ApiError } from "./api";
import { Badge, DataTable, Empty, Note, Panel } from "./components";
import LanguageSelect from "./LanguageSelect";
export function ReservationList({ admin = false }: { admin?: boolean }) {
  const { state, open } = useApp(),
    { t, date, money, number, errorText } = useI18n(),
    items = admin ? state.reservationSchedule || [] : state.reservations || [];
  return (
    <Panel
      className="reservation-list"
      title={t(admin ? "reservation.schedule" : "reservation.list")}
    >
      {items.length ? (
        <DataTable
          caption={t(admin ? "reservation.schedule" : "reservation.list")}
          headers={[
            "ID",
            t(admin ? "auth.email" : "rental.offer"),
            t("reservation.window"),
            t("reservation.quotedAmount"),
            t("common.status"),
            t("common.actions"),
          ]}
          rows={items.map((r) => [
            <div>
              <code>{r.id}</code>
              <small className="cell-sub">
                {r.resource} · {number(r.cards)} GPU · {number(r.memoryMiB)} MiB
              </small>
            </div>,
            <div>
              {admin ? r.email : r.serverName}
              {admin && <small className="cell-sub">{r.serverName}</small>}
              {admin && (
                <details>
                  <summary>{t("reservation.plan")}</summary>
                  <code className="cell-sub">{r.gpuUuids?.join(", ")}</code>
                  <small>
                    {t("reservation.port")}: {r.port}
                  </small>
                </details>
              )}
            </div>,
            <div>
              {date(r.startsAt)}
              <small className="cell-sub">{date(r.endsAt)}</small>
            </div>,
            <div>
              {money(r.amount)}
              <small className="cell-sub">
                {t("reservation.held", { amount: money(r.reserved) })}
              </small>
              {r.orderId && (
                <small className="cell-sub">
                  {t("reservation.order")}: <code>{r.orderId}</code>
                </small>
              )}
            </div>,
            <div>
              <Badge
                tone={
                  r.status === "active"
                    ? "green"
                    : r.status === "booked"
                      ? "blue"
                      : "amber"
                }
              >
                {t(`reservation.${r.status}`)}
              </Badge>
              {r.errorCode && (
                <small className="cell-sub">
                  {errorText(new ApiError(409, "", r.errorCode))}
                </small>
              )}
              {r.cancelReason && (
                <small className="cell-sub">{r.cancelReason}</small>
              )}
            </div>,
            <div className="actions">
              {["booked", "starting", "active"].includes(r.status) && (
                <button
                  className="button"
                  onClick={() =>
                    open({
                      type: "reservation-cancel",
                      reservationId: r.id,
                      admin,
                    })
                  }
                >
                  {t("reservation.cancel")}
                </button>
              )}
              {!admin && r.orderId && (
                <button
                  className="text-link"
                  onClick={() =>
                    document
                      .querySelector(".rental-orders")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                >
                  {t("reservation.viewOrder")}
                </button>
              )}
            </div>,
          ])}
        />
      ) : (
        <Empty
          title={t("reservation.empty")}
          description={t("reservation.emptyHint")}
        />
      )}
      {items.length > 0 && <Note>{t("reservation.listNote")}</Note>}
    </Panel>
  );
}
export function ReservationCancelDialog({
  id,
  admin,
  close,
}: {
  id: string;
  admin: boolean;
  close: () => void;
}) {
  const { state, mutate, notify } = useApp(),
    { t, money, date, errorText } = useI18n(),
    ref = useRef<HTMLDialogElement>(null),
    busyRef = useRef(false);
  const [r] = useState(() =>
      (admin ? state.reservationSchedule! : state.reservations).find(
        (r) => r.id === id,
      )!,
    ),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="reservation-cancel-title"
      onCancel={(e) => (busy ? e.preventDefault() : close())}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div className="dialog-content">
        <div className="dialog-header">
          <h2 id="reservation-cancel-title">{t("reservation.cancel")}</h2>
          <LanguageSelect />
          <button
            className="icon-button"
            aria-label={t("common.close")}
            disabled={busy}
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busyRef.current) return;
            busyRef.current = true;
            setBusy(true);
            setError(null);
            try {
              await mutate(
                `/api/${admin ? "admin/" : ""}compute/reservations/${id}/cancel`,
                "POST",
                admin ? { reason } : {},
              );
              notify("reservation.updated");
              close();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
              busyRef.current = false;
            }
          }}
        >
          <div className="dialog-body form">
            <code>{r.id}</code>
            <p>
              {r.resource} · {date(r.startsAt)} — {date(r.endsAt)}
            </p>
            <p>{t("reservation.held", { amount: money(r.reserved) })}</p>
            <Note>{t("reservation.cancelNote")}</Note>
            {admin && (
              <label>
                {t("reservation.cancelReason")}
                <textarea
                  name="reservationReason"
                  required
                  maxLength={200}
                  rows={3}
                  value={reason}
                  disabled={busy}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}
            {error !== null && (
              <p className="form-error" role="alert">
                {errorText(error)}
              </p>
            )}
          </div>
          <div className="dialog-footer">
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={close}
            >
              {t("common.close")}
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              {t(busy ? "common.processing" : "reservation.confirmCancel")}
            </button>
          </div>
        </form>
      </div>
    </dialog>,
    document.body,
  );
}
