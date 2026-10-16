import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useApp } from "./context";
import { useI18n } from "./i18n";
import { ApiError, request } from "./api";
import type { PaymentOrder } from "./domain";
import { Badge, DataTable, Empty, Note, Panel } from "./components";
import LanguageSelect from "./LanguageSelect";
type Attempt = { key: string; amount: number };
export function RechargeDialog({ close }: { close: () => void }) {
  const { state, mutate } = useApp(),
    { t, money, locale, errorText } = useI18n(),
    ref = useRef<HTMLDialogElement>(null),
    busyRef = useRef(false);
  const [storageKey] = useState(() => `cm-payment:${state.user!.id}`);
  const [attempt, setAttempt] = useState<Attempt | null>(() => {
    try {
      const a = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      return a &&
        /^[a-zA-Z0-9._-]{8,100}$/.test(a.key) &&
        Number.isSafeInteger(a.amount) &&
        a.amount >= 10000000 &&
        a.amount <= 100000000000 &&
        a.amount % 10000 === 0
        ? a
        : null;
    } catch {
      return null;
    }
  });
  const [amount, setAmount] = useState(
      attempt ? (attempt.amount / 1e6).toFixed(2) : "100",
    ),
    [payment, setPayment] = useState<PaymentOrder | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  function save(a: Attempt | null) {
    setAttempt(a);
    try {
      if (a) sessionStorage.setItem(storageKey, JSON.stringify(a));
      else sessionStorage.removeItem(storageKey);
    } catch {}
  }
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="recharge-title"
      onCancel={(e) => (busy ? e.preventDefault() : close())}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div className="dialog-content">
        <div className="dialog-header">
          <h2 id="recharge-title">{t("payment.recharge")}</h2>
          <LanguageSelect />
          <button
            className="icon-button"
            disabled={busy}
            aria-label={t("common.close")}
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busyRef.current) return;
            setError(null);
            if (!/^\d{1,6}(\.\d{1,2})?$/.test(amount)) {
              setError(
                new ApiError(400, "Invalid amount", "invalid_payment_amount"),
              );
              return;
            }
            const [whole, fraction = ""] = amount.split("."),
              micros =
                Number(whole) * 1e6 + Number(fraction.padEnd(2, "0")) * 10000;
            if (micros < 1e7 || micros > 1e11) {
              setError(
                new ApiError(400, "Invalid amount", "invalid_payment_amount"),
              );
              return;
            }
            const a = attempt || { key: crypto.randomUUID(), amount: micros };
            save(a);
            busyRef.current = true;
            setBusy(true);
            try {
              const result = await mutate<{ payment: PaymentOrder }>(
                "/api/payments",
                "POST",
                { amount: a.amount, locale },
                a.key,
              );
              setPayment(result.payment);
              save(null);
              window.dispatchEvent(new Event("cm-payments-changed"));
            } catch (e) {
              setError(e);
              if (e instanceof ApiError && e.status > 0 && e.status < 500)
                save(null);
            } finally {
              setBusy(false);
              busyRef.current = false;
            }
          }}
        >
          <div className="dialog-body form">
            <Note>
              {t(state.paymentsEnabled ? "payment.note" : "wallet.creditNote")}
            </Note>
            {!payment ? (
              <>
                <label>
                  {t("payment.amount")}
                  <input
                    name="rechargeAmount"
                    type="number"
                    min="10"
                    max="100000"
                    step="0.01"
                    required
                    value={amount}
                    disabled={busy || !!attempt}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <small>{t("payment.limits")}</small>
                {attempt && <Note>{t("payment.retryNote")}</Note>}
              </>
            ) : (
              <>
                <strong>{money(payment.amount)}</strong>
                <Badge>{t(`payment.${payment.status}`)}</Badge>
                <code>{payment.id}</code>
                {payment.checkoutUrl ? (
                  <a
                    className="button primary"
                    href={payment.checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("payment.goCheckout")}
                  </a>
                ) : (
                  <Note>{t("payment.checkWallet")}</Note>
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
              {t("common.close")}
            </button>
            {!payment && (
              <button
                className="button primary"
                type="submit"
                disabled={busy || !state.paymentsEnabled}
              >
                {t(
                  busy
                    ? "common.processing"
                    : attempt
                      ? "common.retry"
                      : "payment.create",
                )}
              </button>
            )}
          </div>
        </form>
      </div>
    </dialog>,
    document.body,
  );
}
export function PaymentOrders({ admin = false }: { admin?: boolean }) {
  const { refresh } = useApp(),
    { t, money, date, errorText } = useI18n(),
    [items, setItems] = useState<PaymentOrder[]>([]),
    [cursor, setCursor] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    seq = useRef(0),
    busyRef = useRef(false);
  const endpoint = admin ? "/api/admin/payments" : "/api/payments";
  async function load(more = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    const id = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const result = await request<{
        data: PaymentOrder[];
        nextCursor: number | null;
      }>(endpoint + (more && cursor ? "?before=" + cursor : ""));
      if (seq.current === id) {
        setItems((old) =>
          more
            ? [
                ...old,
                ...result.data.filter((p) => !old.some((o) => o.id === p.id)),
              ]
            : result.data,
        );
        setCursor(result.nextCursor);
      }
      if (seq.current === id) await refresh();
    } catch (e) {
      if (seq.current === id) setError(e);
    } finally {
      if (seq.current === id) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }
  useEffect(() => {
    void load();
    const reload = () => void load();
    addEventListener("focus", reload);
    addEventListener("cm-payments-changed", reload);
    return () => {
      seq.current++;
      busyRef.current = false;
      removeEventListener("focus", reload);
      removeEventListener("cm-payments-changed", reload);
    };
  }, [endpoint]);
  return (
    <Panel
      title={t("payment.orders")}
      action={
        <button className="button" disabled={busy} onClick={() => void load()}>
          {t("payment.refresh")}
        </button>
      }
    >
      {error !== null && (
        <p className="form-error" role="alert">
          {errorText(error)}
        </p>
      )}
      {items.length ? (
        <DataTable
          caption={t("payment.orders")}
          headers={[
            t("common.time"),
            admin ? t("auth.email") : "ID",
            t("common.amount"),
            t("common.status"),
            t("common.actions"),
          ]}
          rows={items.map((p) => [
            date(p.createdAt),
            <div>
              {admin && p.email}
              <code className="cell-sub">{p.id}</code>
            </div>,
            <div>
              {money(p.amount)}
              {p.reversed > 0 && (
                <small className="cell-sub">
                  {t("payment.reversed", { amount: money(p.reversed) })}
                </small>
              )}
            </div>,
            <Badge
              tone={p.review ? "amber" : p.status === "paid" ? "green" : "blue"}
            >
              {t(p.review ? "payment.review" : `payment.${p.status}`)}
            </Badge>,
            p.checkoutUrl ? (
              <a
                className="text-link"
                href={p.checkoutUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("payment.goCheckout")}
              </a>
            ) : (
              <span>—</span>
            ),
          ])}
        />
      ) : (
        <Empty
          title={t(busy ? "common.processing" : "payment.empty")}
          description={t("payment.note")}
        />
      )}
      {cursor && (
        <div className="panel-body">
          <button
            className="button"
            disabled={busy}
            onClick={() => void load(true)}
          >
            {t("cost.more")}
          </button>
        </div>
      )}
      <Note>{t("payment.checkWallet")}</Note>
    </Panel>
  );
}
