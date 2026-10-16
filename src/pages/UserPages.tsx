import { useState, useEffect, useRef } from "react";
import {
  ArrowUpRight,
  KeyRound,
  Plus,
  Sparkles,
  Copy,
  ShieldCheck,
  LogOut,
} from "lucide-react";
import { useApp } from "../context";
import { useI18n } from "../i18n";
import { request, ApiError } from "../api";
import { EmailStatus } from "../AccountMail";
import { PaymentOrders } from "../Payments";
import { ReservationList } from "../Reservations";
import type { BillPage, RentalOffer } from "../domain";
import { MICRO, modelOnline } from "../domain";
import {
  Badge,
  DataTable,
  Empty,
  Note,
  PageHeader,
  Panel,
  Stat,
  Stats,
} from "../components";
function CreditInfo() {
  const { open, state } = useApp(),
    { t } = useI18n();
  return (
    <button
      className="button primary"
      onClick={() => open({ type: "recharge" })}
    >
      <Plus size={16} />
      {t(state.paymentsEnabled ? "payment.recharge" : "wallet.creditInfo")}
    </button>
  );
}
function Models() {
  const { state, open } = useApp(),
    { t, money } = useI18n();
  return (
    <>
      <PageHeader
        title={t("nav.models")}
        description={t("model.description")}
        actions={
          state.user ? (
            <CreditInfo />
          ) : (
            <a className="button primary" href="#/user/account">
              {t("auth.entry")}
            </a>
          )
        }
      />
      <Stats>
        <Stat
          label={t("wallet.balance")}
          value={money(state.balance)}
          detail={`${t("wallet.held")}: ${money(state.heldBalance)}`}
        />
        <Stat
          label={t("wallet.today")}
          value={money(state.tokenSpend)}
          detail="UTC+8"
        />
        <Stat
          label={t("model.available")}
          value={`${state.models.filter((m) => modelOnline(state, m.id)).length} / ${state.models.length}`}
          detail=""
        />
        <Stat label={t("model.unit")} value="CNY" detail="" />
      </Stats>
      {state.models.length ? (
        <div className="grid grid-three">
          {state.models.map((m) => (
            <section className="panel model-card" key={m.id}>
              <div className="row between">
                <span className="square-icon">
                  <Sparkles size={22} />
                </span>
                <Badge tone={modelOnline(state, m.id) ? "green" : "amber"}>
                  {t(
                    modelOnline(state, m.id)
                      ? "status.configured"
                      : "reports.unavailable",
                  )}
                </Badge>
              </div>
              <div>
                <h2>{m.name}</h2>
                <span className="model-tag">{m.tag}</span>
              </div>
              <p>{m.description}</p>
              <div className="model-prices">
                <div>
                  <span>{t("model.input")}</span>
                  <strong>{money(m.inputPrice)}</strong>
                </div>
                <div>
                  <span>{t("model.output")}</span>
                  <strong>{money(m.outputPrice)}</strong>
                </div>
              </div>
              <button
                className="button primary full-width"
                disabled={!modelOnline(state, m.id)}
                onClick={() =>
                  state.user
                    ? open({ type: "try", modelId: m.id })
                    : (location.hash = "#/user/account")
                }
              >
                {t("model.try")}
                <ArrowUpRight size={16} />
              </button>
            </section>
          ))}
        </div>
      ) : (
        <Panel title={t("nav.models")}>
          <Empty title={t("model.empty")} description={t("model.emptyHint")} />
        </Panel>
      )}
      <Note>{t("model.liveNote")}</Note>
    </>
  );
}
function Keys() {
  const { state, mutate, notify } = useApp(),
    { t, money, errorText } = useI18n(),
    [budget, setBudget] = useState(String(state.dailyBudget / MICRO)),
    [key, setKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const example = `POST /v1/chat/completions\nAuthorization: Bearer <your-api-key>\nContent-Type: application/json\nIdempotency-Key: <unique-request-id>\n\n${JSON.stringify({ model: state.models[0]?.id || "model-id", max_tokens: 1024, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Hello" }] }, null, 2)}`;
  async function changeKey() {
    setBusy(true);
    setError(null);
    try {
      if (state.hasKey) {
        await mutate("/api/keys", "DELETE");
        setKey("");
      } else {
        setKey((await mutate<{ key: string }>("/api/keys", "POST")).key);
      }
      notify("common.saved");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title={t("nav.keys")}
        description={t("key.note")}
        actions={
          <button
            className="button primary"
            disabled={busy}
            onClick={changeKey}
          >
            <KeyRound size={16} />
            {t(state.hasKey ? "key.revoke" : "key.create")}
          </button>
        }
      />
      {error !== null && (
        <p className="form-error" role="alert">
          {errorText(error)}
        </p>
      )}
      {key && (
        <Panel title={t("key.saveNow")}>
          <div className="panel-body">
            <code className="key-reveal">{key}</code>
            <p className="form-help">{t("key.once")}</p>
          </div>
        </Panel>
      )}
      <Panel title={t("key.credentials")}>
        {state.hasKey ? (
          <DataTable
            caption={t("key.credentials")}
            headers={[
              t("common.name"),
              t("key.credentials"),
              t("common.details"),
              t("wallet.budget"),
            ]}
            rows={[
              [
                state.user?.name,
                <code>{state.keyPrefix}••••••</code>,
                t("key.scope"),
                money(state.dailyBudget),
              ],
            ]}
          />
        ) : (
          <Empty title={t("key.empty")} description={t("key.note")} />
        )}
      </Panel>
      <div className="grid grid-two">
        <Panel
          title={t("key.example")}
          action={
            <button
              className="icon-button"
              aria-label={t("common.copy")}
              onClick={() =>
                navigator.clipboard
                  .writeText(example)
                  .then(() => notify("common.copied"))
                  .catch(() => notify("common.copyFailed", true))
              }
            >
              <Copy size={17} />
            </button>
          }
        >
          <div className="panel-body">
            <pre className="code-block">
              <code>{example}</code>
            </pre>
          </div>
        </Panel>
        <Panel title={t("key.protection")}>
          <form
            className="panel-body form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await mutate("/api/wallet/budget", "PUT", {
                  amount: Math.round(Number(budget) * MICRO),
                });
                notify("common.saved");
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              {t("key.limit")}
              <input
                type="number"
                min="1"
                max="100000"
                step="1"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                required
              />
            </label>
            <p className="form-help">{t("key.note")}</p>
            <div className="row between">
              <small>{t("wallet.today")}</small>
              <strong>{money(state.tokenSpend)}</strong>
            </div>
            <div className="meter">
              <span
                style={{
                  width: `${Math.min(100, (state.tokenSpend / state.dailyBudget) * 100)}%`,
                }}
              />
            </div>
            <button className="button" disabled={busy} type="submit">
              {t("common.save")}
            </button>
          </form>
        </Panel>
      </div>
    </>
  );
}
function WalletPage() {
  const { state } = useApp(),
    { t, money, date, number, errorText } = useI18n(),
    [filter, setFilter] = useState("all"),
    [page, setPage] = useState<
      (BillPage & { ownerId: string; filter: string }) | null
    >(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState<unknown>(null),
    seq = useRef(0),
    busyRef = useRef(false);
  const ownerId = state.user?.id;
  const current =
    page?.ownerId === ownerId && page?.filter === filter ? page : null;
  const bills = current?.data ?? [];
  async function load(more = false) {
    if (!ownerId || (more && (busyRef.current || !current?.nextCursor))) return;
    busyRef.current = true;
    const id = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ type: filter });
      if (more) params.set("before", String(current!.nextCursor));
      const result = await request<BillPage>("/api/wallet/bills?" + params);
      if (seq.current === id)
        setPage({
          ...result,
          ownerId,
          filter,
          data: more
            ? [
                ...bills,
                ...result.data.filter(
                  (b) => !bills.some((old) => old.id === b.id),
                ),
              ]
            : result.data,
        });
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
    if (ownerId) void load();
    else {
      setPage(null);
      setError(null);
      setBusy(false);
    }
    const reload = () => void load();
    addEventListener("focus", reload);
    return () => {
      seq.current++;
      busyRef.current = false;
      removeEventListener("focus", reload);
    };
  }, [ownerId, filter, state.bills[0]?.id]);
  return (
    <>
      <PageHeader
        title={t("nav.wallet")}
        description={t("wallet.note")}
        actions={<CreditInfo />}
      />
      <Stats>
        <Stat
          label={t("wallet.balance")}
          value={money(state.balance)}
          detail=""
        />
        <Stat
          label={t("wallet.held")}
          value={money(state.heldBalance)}
          detail=""
        />
        <Stat
          label={t("wallet.today")}
          value={money(state.tokenSpend)}
          detail="UTC+8"
        />
        <Stat
          label={t("wallet.budget")}
          value={money(state.dailyBudget)}
          detail=""
        />
      </Stats>
      <PaymentOrders />
      <Panel
        title={t("wallet.transactions")}
        action={
          <div className="actions">
            <label>
              <span className="sr-only">{t("wallet.all")}</span>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">{t("wallet.all")}</option>
                <option value="token">{t("wallet.token")}</option>
                <option value="recharge">{t("wallet.creditType")}</option>
                <option value="recharge_refund">
                  {t("payment.creditReversal")}
                </option>
                <option value="compute">{t("wallet.compute")}</option>
                <option value="compute_refund">
                  {t("wallet.computeRefund")}
                </option>
              </select>
            </label>
            <button
              className="button"
              disabled={busy}
              onClick={() => void load()}
            >
              {t("common.refresh")}
            </button>
          </div>
        }
      >
        {error !== null && (
          <p className="form-error" role="alert">
            {errorText(error)}
          </p>
        )}
        {busy && (
          <p className="panel-body" role="status">
            {t("app.loading")}
          </p>
        )}
        {bills.length ? (
          <DataTable
            caption={t("wallet.transactions")}
            headers={[
              t("common.time"),
              t("deployment.model"),
              t("wallet.quantity"),
              t("common.amount"),
            ]}
            rows={bills.map((b) => [
              date(b.time),
              <div>
                <strong>
                  {t(
                    b.type === "token"
                      ? "wallet.token"
                      : b.type === "compute"
                        ? b.metadata?.renewal
                          ? "wallet.computeRenewal"
                          : "wallet.compute"
                        : b.type === "recharge_refund"
                          ? b.metadata?.restored
                            ? "payment.refundRestored"
                            : b.metadata?.chargeback
                              ? "payment.chargeback"
                              : "payment.creditReversal"
                          : b.type === "compute_refund"
                            ? "wallet.computeRefund"
                            : "wallet.creditType",
                  )}
                </strong>
                <small className="cell-sub">
                  {b.metadata?.provider === "stripe"
                    ? t("payment.providerCredit")
                    : b.type === "recharge"
                      ? t("wallet.creditTitle")
                      : b.resource}
                </small>
              </div>,
              <div>
                {b.metadata?.paymentId ? (
                  <code>{b.metadata.paymentId}</code>
                ) : b.metadata?.orderId ? (
                  <>
                    {t("wallet.gpuUsage", {
                      cards: number(b.metadata.cards || 0),
                      hours: number(b.metadata.hours || 0),
                      price: money(b.metadata.hourlyPrice || 0),
                    })}
                    <small className="cell-sub">{b.metadata.orderId}</small>
                    {b.metadata.chargedSeconds !== undefined && (
                      <small className="cell-sub">
                        {t("rental.billedSeconds", {
                          seconds: number(b.metadata.chargedSeconds),
                        })}
                      </small>
                    )}
                  </>
                ) : b.metadata?.inputTokens !== undefined ? (
                  t("wallet.tokens", {
                    input: number(b.metadata.inputTokens),
                    output: number(b.metadata.outputTokens || 0),
                  })
                ) : (
                  b.metadata?.reason || (
                    <>
                      {b.quantity}
                      <small className="cell-sub">{t("common.original")}</small>
                    </>
                  )
                )}
                {b.metadata?.streamed && (
                  <small className="cell-sub">{t("chat.streaming")}</small>
                )}
                {b.type === "token" && (
                  <small className="cell-sub">
                    {t("wallet.historyPrices", {
                      input: money(b.inputPrice || 0),
                      output: money(b.outputPrice || 0),
                    })}
                  </small>
                )}
              </div>,
              <strong
                className={
                  b.type === "recharge" ||
                  b.type === "compute_refund" ||
                  b.amount < 0
                    ? "positive"
                    : ""
                }
              >
                {b.type === "recharge" ||
                b.type === "compute_refund" ||
                b.amount < 0
                  ? "+"
                  : "−"}
                {money(Math.abs(b.amount))}
              </strong>,
            ])}
          />
        ) : !busy && error === null ? (
          <Empty title={t("wallet.empty")} description={t("wallet.note")} />
        ) : null}
        {current?.nextCursor && (
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
        <Note>{t("wallet.paginationNote")}</Note>
      </Panel>
    </>
  );
}
function Account() {
  const { state, mutate, notify } = useApp(),
    { t, money, errorText, locale } = useI18n(),
    [mode, setMode] = useState<"login" | "register" | "forgot">("login"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  async function logout() {
    setBusy(true);
    try {
      await mutate("/api/auth/logout", "POST");
      notify("auth.loggedOut");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title={t("nav.account")}
        description={t("auth.securityNote")}
      />
      <div className="grid grid-two">
        <Panel
          title={
            state.user
              ? t("auth.profile")
              : t(
                  mode === "login"
                    ? "auth.login"
                    : mode === "forgot"
                      ? "mail.forgot"
                      : "auth.register",
                )
          }
        >
          {state.user ? (
            <div className="panel-body account-details">
              <div className="account-profile">
                <span className="avatar large">
                  {state.account.slice(0, 1)}
                </span>
                <div>
                  <h2>{state.account}</h2>
                  <Badge>
                    {t(
                      state.user.role === "admin"
                        ? "auth.adminRole"
                        : "auth.userRole",
                    )}
                  </Badge>
                </div>
              </div>
              <dl>
                <div>
                  <dt>{t("auth.email")}</dt>
                  <dd>{state.email}</dd>
                </div>
                <div>
                  <dt>{t("wallet.balance")}</dt>
                  <dd>{money(state.balance)}</dd>
                </div>
                <div>
                  <dt>{t("wallet.budget")}</dt>
                  <dd>{money(state.dailyBudget)}</dd>
                </div>
              </dl>
              <div className="actions">
                <a
                  className="button primary"
                  href={
                    state.user.role === "admin"
                      ? "#/admin/pricing"
                      : "#/user/models"
                  }
                >
                  {t("app.user")}
                  <ArrowUpRight size={16} />
                </a>
                <button className="button" disabled={busy} onClick={logout}>
                  <LogOut size={16} />
                  {t("auth.logout")}
                </button>
              </div>
            </div>
          ) : (
            <form
              key={mode}
              className="panel-body form"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                setBusy(true);
                setError(null);
                try {
                  await mutate(
                    `/api/auth/${mode === "forgot" ? "forgot-password" : mode}`,
                    "POST",
                    {
                      email: f.get("email"),
                      ...(mode === "forgot"
                        ? { locale }
                        : { password: f.get("password") }),
                      ...(mode === "register" ? { name: f.get("name") } : {}),
                    },
                  );
                  notify(
                    mode === "forgot" ? "mail.forgotSent" : "auth.success",
                  );
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="amount-options">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  aria-pressed={mode === "login"}
                  onClick={() => {
                    setMode("login");
                    setError(null);
                  }}
                >
                  {t("auth.login")}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  aria-pressed={mode === "register"}
                  onClick={() => {
                    setMode("register");
                    setError(null);
                  }}
                >
                  {t("auth.register")}
                </button>
              </div>
              {mode === "register" && (
                <label>
                  {t("auth.team")}
                  <input
                    name="name"
                    maxLength={40}
                    required
                    autoComplete="organization"
                  />
                </label>
              )}
              <label>
                {t("auth.email")}
                <input
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  autoComplete="email"
                />
              </label>
              {mode !== "forgot" && (
                <label>
                  {t("auth.password")}
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    maxLength={128}
                    placeholder={t("auth.passwordHint")}
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                  />
                </label>
              )}
              {mode === "forgot" && (
                <Note>
                  {t(
                    state.mailEnabled ? "mail.forgotNote" : "mail.unavailable",
                  )}
                </Note>
              )}
              <button
                className="button primary"
                disabled={busy || (mode === "forgot" && !state.mailEnabled)}
                type="submit"
              >
                {t(
                  busy
                    ? "common.processing"
                    : mode === "forgot"
                      ? "mail.sendReset"
                      : mode === "login"
                        ? "auth.loginSubmit"
                        : "auth.registerSubmit",
                )}
              </button>
              {mode === "login" && (
                <button
                  className="text-link"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setMode("forgot");
                    setError(null);
                  }}
                >
                  {t("mail.forgot")}
                </button>
              )}
            </form>
          )}
          {error !== null && (
            <p className="form-error" role="alert">
              {errorText(error)}
            </p>
          )}
        </Panel>
        <Panel title={t("auth.security")}>
          <div className="panel-body form">
            <span className="square-icon">
              <ShieldCheck size={22} />
            </span>
            <p className="muted">{t("auth.securityNote")}</p>
            <EmailStatus />
            <Note>{t("auth.adminNote")}</Note>
          </div>
        </Panel>
      </div>
    </>
  );
}
export default function UserPages({ page }: { page: string }) {
  const { state } = useApp(),
    { t } = useI18n();
  if (!state.user && page !== "models" && page !== "account")
    return (
      <>
        <PageHeader
          title={t("auth.needLogin")}
          description={t("auth.securityNote")}
        />
        <a className="button primary" href="#/user/account">
          {t("auth.entry")}
        </a>
      </>
    );
  if (page === "account") return <Account />;
  if (page === "keys") return <Keys />;
  if (page === "wallet") return <WalletPage />;
  if (page === "compute") return <Compute />;
  return <Models />;
}

type ComputeAttempt = {
  key: string;
  mode: "immediate" | "reservation";
  body: {
    offerId: string;
    cards: number;
    hours: number;
    expectedHourlyPrice: number;
    startsAt?: string;
  };
};
function readComputeAttempt(key: string): ComputeAttempt | null {
  try {
    const a = JSON.parse(sessionStorage.getItem(key) || "null"),
      b = a?.body;
    return a &&
      typeof a.key === "string" &&
      /^[a-zA-Z0-9._-]{8,100}$/.test(a.key) &&
      ["immediate", "reservation"].includes(a.mode) &&
      b &&
      typeof b.offerId === "string" &&
      b.offerId.length <= 160 &&
      Number.isInteger(b.cards) &&
      b.cards >= 1 &&
      b.cards <= 64 &&
      Number.isInteger(b.hours) &&
      b.hours >= 1 &&
      b.hours <= 720 &&
      Number.isSafeInteger(b.expectedHourlyPrice) &&
      b.expectedHourlyPrice > 0 &&
      b.expectedHourlyPrice <= 10000000000 &&
      (a.mode === "immediate" ||
        (typeof b.startsAt === "string" &&
          Number.isFinite(Date.parse(b.startsAt))))
      ? a
      : null;
  } catch {
    return null;
  }
}
const utc8Input = (time: number) =>
  new Date(time + 8 * 3600000).toISOString().slice(0, 16);

function Compute() {
  const { state, mutate, refresh, notify, open } = useApp(),
    { t, status, errorText, money, date, number } = useI18n();
  const storageKey = "cm-compute-purchase:" + state.user!.id;
  const [saved] = useState(() => readComputeAttempt(storageKey));
  const [offers, setOffers] = useState<RentalOffer[]>([]),
    [offerId, setOfferId] = useState(saved?.body.offerId || ""),
    [cards, setCards] = useState(saved?.body.cards || 1),
    [hours, setHours] = useState(saved?.body.hours || 1),
    [scheduled, setScheduled] = useState(saved?.mode === "reservation"),
    [startInput, setStartInput] = useState(() =>
      utc8Input(
        saved?.body.startsAt
          ? Date.parse(saved.body.startsAt)
          : Date.now() + 15 * 60000,
      ),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [uncertain, setUncertain] = useState(!!saved);
  const busyRef = useRef(false),
    offersSeq = useRef(0);
  const attempt = useRef<ComputeAttempt | null>(saved),
    offer = offers.find((o) => o.id === offerId);
  async function loadOffers() {
    const id = ++offersSeq.current,
      params = new URLSearchParams({ hours: String(hours) });
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
      setOffers([]);
      return;
    }
    if (scheduled) {
      const start = Date.parse(startInput + "+08:00");
      if (
        !Number.isFinite(start) ||
        start < Date.now() + 5 * 60000 ||
        start > Date.now() + 30 * 86400000
      ) {
        setOffers([]);
        return;
      }
      params.set("startsAt", new Date(start).toISOString());
    }
    const r = await request<{ data: RentalOffer[] }>(
      "/api/compute/offers?" + params,
    );
    if (offersSeq.current !== id) return;
    setOffers(r.data);
    setOfferId((old) =>
      uncertain
        ? old
        : r.data.some((o) => o.id === old)
          ? old
          : r.data[0]?.id || "",
    );
  }
  useEffect(() => {
    const first = setTimeout(() => loadOffers().catch(setError), 200);
    const timer = setInterval(() => {
      if (!document.hidden) {
        refresh().catch(() => {});
        loadOffers().catch(setError);
      }
    }, 10000);
    return () => {
      offersSeq.current++;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [hours, scheduled, startInput, uncertain]);
  async function purchase() {
    if (busyRef.current || (!offer && !uncertain)) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    if (!uncertain)
      attempt.current = {
        key: crypto.randomUUID(),
        mode: scheduled ? "reservation" : "immediate",
        body: {
          offerId,
          cards,
          hours,
          expectedHourlyPrice: offer!.hourlyPrice,
          ...(scheduled
            ? { startsAt: new Date(startInput + "+08:00").toISOString() }
            : {}),
        },
      };
    try {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(attempt.current));
      } catch {
        throw new ApiError(
          0,
          "Session storage required",
          "browser_storage_unavailable",
        );
      }
      const mode = attempt.current!.mode;
      await mutate(
        mode === "reservation"
          ? "/api/compute/reservations"
          : "/api/compute/orders",
        "POST",
        attempt.current!.body,
        attempt.current!.key,
      );
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
      setUncertain(false);
      attempt.current = null;
      notify(
        mode === "reservation"
          ? "reservation.bookedNotice"
          : "rental.purchased",
      );
      if (
        scheduled &&
        Date.parse(startInput + "+08:00") < Date.now() + 5 * 60000
      )
        setStartInput(utc8Input(Date.now() + 15 * 60000));
      else await loadOffers().catch(setError);
    } catch (e) {
      setError(e);
      const unknown =
        !(e instanceof ApiError) || e.status === 0 || e.status >= 500;
      setUncertain(unknown);
      if (!unknown) {
        attempt.current = null;
        try {
          sessionStorage.removeItem(storageKey);
        } catch {}
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function access(id: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    setBusy(true);
    setError(null);
    try {
      const r = await mutate<{ url: string }>(
        `/api/compute/rentals/${id}/access`,
        "POST",
      );
      if (tab) tab.location.href = r.url;
      else location.href = r.url;
    } catch (e) {
      tab?.close();
      setError(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const manual = state.rentals.filter(
    (r) => !state.orders.some((o) => o.deploymentId === r.id),
  );
  return (
    <>
      <PageHeader title={t("nav.compute")} description={t("compute.note")} />
      <Stats>
        <Stat
          label={t("wallet.balance")}
          value={money(state.balance)}
          detail=""
        />
        <Stat
          label={t("wallet.held")}
          value={money(state.heldBalance)}
          detail=""
        />
      </Stats>
      <Note>{t("rental.purchaseNote")}</Note>
      {error !== null && (
        <p className="form-error" role="alert">
          {errorText(error)}
        </p>
      )}
      <Panel title={t(scheduled ? "reservation.book" : "rental.buy")}>
        <form
          className="panel-body form"
          onSubmit={(e) => {
            e.preventDefault();
            void purchase();
          }}
        >
          <fieldset className="rental-fields" disabled={busy || uncertain}>
            <label className="checkbox-label">
              <input
                name="scheduled"
                type="checkbox"
                checked={scheduled}
                onChange={(e) => {
                  setScheduled(e.target.checked);
                  setError(null);
                }}
              />
              {t("reservation.mode")}
            </label>
            {scheduled && (
              <>
                <label>
                  {t("reservation.startsAt")}
                  <input
                    name="reservationStart"
                    type="datetime-local"
                    value={startInput}
                    required
                    min={utc8Input(Date.now() + 6 * 60000)}
                    max={utc8Input(Date.now() + 30 * 86400000)}
                    onChange={(e) => {
                      setStartInput(e.target.value);
                      setError(null);
                    }}
                  />
                </label>
                <Note>{t("reservation.note")}</Note>
              </>
            )}
            <div className="form-grid">
              <label>
                {t("rental.offer")}
                <select
                  name="offerId"
                  value={offerId}
                  required
                  onChange={(e) => {
                    setOfferId(e.target.value);
                    setCards(1);
                  }}
                >
                  <option value="">—</option>
                  {offers.map((o) => (
                    <option value={o.id} key={o.id}>
                      {o.name} · {o.region} · {o.gpuName} · {o.memoryMiB} MiB ·{" "}
                      {money(o.hourlyPrice)}/GPU·h
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("rental.cards")}
                <input
                  name="cards"
                  type="number"
                  required
                  min="1"
                  max={offer?.availableCards || 1}
                  value={cards}
                  onChange={(e) => setCards(Number(e.target.value))}
                />
              </label>
              <label>
                {t("rental.hours")}
                <input
                  name="hours"
                  type="number"
                  required
                  min="1"
                  max="720"
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                />
              </label>
            </div>
          </fieldset>
          {offer && (
            <p>
              {t("rental.quote", {
                available: number(offer.availableCards),
                price: money(offer.hourlyPrice),
                total: money(offer.hourlyPrice * cards * hours),
              })}
            </p>
          )}
          {!offers.length && <p>{t("rental.noOffers")}</p>}
          {uncertain && <Note>{t("rental.uncertain")}</Note>}
          <button
            className="button primary"
            disabled={busy || (!offer && !uncertain)}
            type="submit"
          >
            {t(
              busy
                ? "common.processing"
                : uncertain
                  ? "common.retry"
                  : scheduled
                    ? "reservation.book"
                    : "rental.buy",
            )}
          </button>
        </form>
      </Panel>
      <ReservationList />
      <Panel className="rental-orders" title={t("rental.orders")}>
        {state.orders.length ? (
          <DataTable
            caption={t("rental.orders")}
            headers={[
              "ID",
              t("rental.cards"),
              t("rental.totalHours"),
              t("common.amount"),
              t("common.status"),
              t("rental.expires"),
              t("common.actions"),
            ]}
            rows={state.orders.map((o) => [
              <div>
                <code>{o.id}</code>
                <small className="cell-sub">{o.resource}</small>
              </div>,
              number(o.cards),
              number(o.hours),
              <div>
                {money(o.amount)}
                <small className="cell-sub">
                  {t("rental.financial", {
                    held: money(o.reserved),
                    charged: money(o.charged),
                    refunded: money(o.refunded),
                  })}
                </small>
              </div>,
              o.renewalPending
                ? t("rental.renewPending")
                : t(`order.${o.status}`),
              <div>
                {date(o.renewalPending ? o.confirmedExpiresAt : o.expiresAt)}
                {o.renewalPending && (
                  <small className="cell-sub">
                    {t("rental.proposedExpiry", { expires: date(o.expiresAt) })}
                  </small>
                )}
                {o.startedAt && (
                  <small className="cell-sub">
                    {t("rental.started")}: {date(o.startedAt)}
                  </small>
                )}
                {o.scheduledStart && (
                  <small className="cell-sub">
                    {t("reservation.startsAt")}: {date(o.scheduledStart)}
                  </small>
                )}
              </div>,
              <div className="actions rental-order-actions">
                <button
                  className="button"
                  disabled={
                    busy ||
                    !o.accessReady ||
                    state.rentals.find((r) => r.id === o.deploymentId)
                      ?.phase !== "ready"
                  }
                  onClick={() => void access(o.deploymentId)}
                >
                  {t("rental.open")}
                </button>
                <button
                  className="button"
                  disabled={
                    busy ||
                    o.status !== "active" ||
                    o.renewalPending ||
                    Math.floor(
                      (Date.now() + 720 * 3600000 - Date.parse(o.expiresAt!)) /
                        3600000,
                    ) < 1 ||
                    !o.accessReady
                  }
                  onClick={() => open({ type: "rental-renew", orderId: o.id })}
                >
                  {t("rental.renew")}
                </button>
                <button
                  className="button"
                  disabled={
                    busy || !["active", "provisioning"].includes(o.status)
                  }
                  onClick={() => open({ type: "rental-cancel", orderId: o.id })}
                >
                  {t("rental.cancel")}
                </button>
              </div>,
            ])}
          />
        ) : (
          <Empty title={t("compute.pending")} description={t("compute.note")} />
        )}
      </Panel>
      {manual.length > 0 && (
        <Panel title={t("rental.manual")}>
          <DataTable
            caption={t("rental.manual")}
            headers={[
              "ID",
              t("gpu.total"),
              t("common.status"),
              t("common.actions"),
            ]}
            rows={manual.map((r) => [
              <code>{r.id}</code>,
              r.gpuCount,
              status(r.phase),
              <button
                className="button"
                disabled={busy || r.phase !== "ready"}
                onClick={() => void access(r.id)}
              >
                {t("rental.open")}
              </button>,
            ])}
          />
        </Panel>
      )}
    </>
  );
}
