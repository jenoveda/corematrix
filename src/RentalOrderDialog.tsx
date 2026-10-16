import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useApp } from "./context";
import { useI18n } from "./i18n";
import { ApiError } from "./api";
import { Note } from "./components";
import LanguageSelect from "./LanguageSelect";

export default function RentalOrderDialog({
  dialog,
  close,
}: {
  dialog: { type: "rental-renew" | "rental-cancel"; orderId: string };
  close: () => void;
}) {
  const { state, mutate, notify } = useApp(),
    { t, money, date, errorText } = useI18n(),
    ref = useRef<HTMLDialogElement>(null),
    busyRef = useRef(false);
  const [order] = useState(() =>
      state.orders.find((o) => o.id === dialog.orderId)!,
    ),
    renew = dialog.type === "rental-renew",
    kind = renew ? "renew" : "cancel",
    [storageKey] = useState(
      () => `cm-rental-action:${state.user!.id}:${order.id}:${kind}`,
    );
  const [saved] = useState<{
    key: string;
    hours: number;
    baseExpiresAt?: string | null;
  } | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      return value &&
        typeof value.key === "string" &&
        Number.isInteger(value.hours) &&
        value.hours >= 1 &&
        value.hours <= 720 &&
        (value.baseExpiresAt == null ||
          (typeof value.baseExpiresAt === "string" &&
            Number.isFinite(Date.parse(value.baseExpiresAt))))
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const [hours, setHours] = useState(saved?.hours ?? 1),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(!!saved),
    [error, setError] = useState<unknown>(null);
  const attempt = useRef(saved);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  async function submit() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!attempt.current) {
        attempt.current = {
          key: crypto.randomUUID(),
          hours,
          baseExpiresAt: order.expiresAt,
        };
        sessionStorage.setItem(storageKey, JSON.stringify(attempt.current));
      }
      const result = await mutate<{ action: { status: string } }>(
        `/api/compute/orders/${order.id}/${kind}`,
        "POST",
        renew ? { hours: attempt.current.hours } : {},
        attempt.current.key,
      );
      sessionStorage.removeItem(storageKey);
      notify(
        !renew
          ? "rental.cancelSubmitted"
          : result.action.status === "succeeded"
            ? "rental.renewed"
            : result.action.status === "failed"
              ? "rental.renewFailed"
              : "rental.renewSubmitted",
      );
      close();
    } catch (e) {
      const unknown =
        !(e instanceof ApiError) || e.status === 0 || e.status >= 500;
      setUncertain(unknown);
      if (!unknown) {
        attempt.current = null;
        sessionStorage.removeItem(storageKey);
      }
      setError(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="rental-dialog-title"
      onCancel={(e) => (busy ? e.preventDefault() : close())}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div className="dialog-content">
        <div className="dialog-header">
          <h2 id="rental-dialog-title">
            {t(renew ? "rental.renew" : "rental.cancel")}
          </h2>
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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="dialog-body form">
            <code>{order.id}</code>
            <Note>{t(renew ? "rental.renewNote" : "rental.cancelNote")}</Note>
            {renew ? (
              <>
                <label>
                  {t("rental.renewHours")}
                  <input
                    name="renewHours"
                    type="number"
                    min="1"
                    max={Math.max(
                      1,
                      Math.min(
                        720,
                        Math.floor(
                          (Date.now() +
                            720 * 3600000 -
                            Date.parse(order.expiresAt!)) /
                            3600000,
                        ),
                      ),
                    )}
                    required
                    disabled={busy || uncertain}
                    value={hours}
                    onChange={(e) => setHours(Number(e.target.value))}
                  />
                </label>
                <p>
                  {t("rental.renewQuote", {
                    price: money(order.hourlyPrice),
                    amount: money(order.hourlyPrice * order.cards * hours),
                    expires: date(
                      new Date(
                        Date.parse(
                          attempt.current?.baseExpiresAt || order.expiresAt!,
                        ) +
                          hours * 3600000,
                      ).toISOString(),
                    ),
                  })}
                </p>
              </>
            ) : (
              <p>{t("rental.cancelConfirm")}</p>
            )}
            {uncertain && <Note>{t("rental.uncertain")}</Note>}
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
              {t(
                busy
                  ? "common.processing"
                  : uncertain
                    ? "common.retry"
                    : renew
                      ? "rental.renew"
                      : "rental.cancel",
              )}
            </button>
          </div>
        </form>
      </div>
    </dialog>,
    document.body,
  );
}
