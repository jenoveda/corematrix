import { useEffect, useRef, useState } from "react";
import { EmailLinkForm, useMailLink } from "./AccountMail";
import {
  Boxes,
  LayoutDashboard,
  Server,
  Workflow,
  Tags,
  ChartNoAxesCombined,
  Sparkles,
  Cpu,
  KeyRound,
  Wallet,
  CircleUserRound,
  Menu,
  X,
  ArrowUpRight,
  LogOut,
  Info,
  CheckCircle2,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppContext } from "./context";
import type { Dialog } from "./context";
import { emptyState } from "./domain";
import { request, ApiError } from "./api";
import type { State } from "./domain";
import AdminPages from "./pages/AdminPages";
import UserPages from "./pages/UserPages";
import Dialogs from "./Dialogs";
import LanguageSelect from "./LanguageSelect";
import { inputMessage } from "./i18n/errors";
import { useI18n } from "./i18n";
import type { Key, Locale } from "./i18n";
import { PageHeader } from "./components";

type Role = "admin" | "user";
const menus: Record<Role, { id: string; label: Key; icon: LucideIcon }[]> = {
  admin: [
    { id: "overview", label: "nav.overview", icon: LayoutDashboard },
    { id: "servers", label: "nav.servers", icon: Server },
    { id: "deployments", label: "nav.deployments", icon: Workflow },
    { id: "pricing", label: "nav.pricing", icon: Tags },
    { id: "reports", label: "nav.reports", icon: ChartNoAxesCombined },
    { id: "operations", label: "nav.operations", icon: TriangleAlert },
  ],
  user: [
    { id: "models", label: "nav.models", icon: Sparkles },
    { id: "compute", label: "nav.compute", icon: Cpu },
    { id: "keys", label: "nav.keys", icon: KeyRound },
    { id: "wallet", label: "nav.wallet", icon: Wallet },
    { id: "account", label: "nav.account", icon: CircleUserRound },
  ],
};
function route() {
  const [, scope, page] = location.hash.replace(/^#/, "").split("/");
  const role: Role = scope === "admin" ? "admin" : "user";
  return {
    role,
    page: page?.split("?")[0] || (role === "admin" ? "overview" : "models"),
  };
}
export default function App() {
  const { t, locale, setLocale, errorText, money } = useI18n();
  const [mailLink, clearMailLink] = useMailLink();
  const [state, setState] = useState<State>(emptyState);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState(route),
    [dialog, setDialog] = useState<Dialog | null>(null),
    [mobileMenu, setMobileMenu] = useState(false),
    [notice, setNotice] = useState<{
      text: Key | Error;
      error: boolean;
    } | null>(null),
    [connectionError, setConnectionError] = useState(false);
  const [languageSaving, setLanguageSaving] = useState(false);
  const refreshSequence = useRef(0);
  const contentRef = useRef<HTMLElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!location.hash) history.replaceState(null, "", "#/user/models");
    function changed() {
      setCurrent(route());
      refresh().catch(() => {});
      setMobileMenu(false);
      setDialog(null);
      setNotice(null);
      window.scrollTo({ top: 0 });
      contentRef.current?.focus();
    }
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  async function refresh() {
    const sequence = ++refreshSequence.current;
    try {
      const next = await request<State>("/api/state");
      if (sequence === refreshSequence.current) {
        setState(next);
        setConnectionError(false);
      }
    } catch (error) {
      if (sequence === refreshSequence.current) setConnectionError(true);
      throw error;
    }
  }
  useEffect(() => {
    refresh()
      .catch(() => {})
      .finally(() => setLoading(false));
    const focus = () => refresh().catch(() => {});
    addEventListener("focus", focus);
    return () => removeEventListener("focus", focus);
  }, []);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  function notify(text: Key | Error, error = false) {
    setNotice({ text, error });
  }
  async function mutate<T = unknown>(
    path: string,
    method: string,
    body?: unknown,
    requestId?: string,
  ): Promise<T> {
    let result: T;
    try {
      result = await request<T>(path, {
        method,
        body,
        requestId,
        csrf: state.csrfToken,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        refresh().catch(() => {});
      throw error;
    }
    try {
      await refresh();
    } catch {
      notify("app.refreshFailed", true);
    }
    return result;
  }
  async function logout() {
    try {
      await mutate("/api/auth/logout", "POST");
      location.hash = "#/user/account";
      notify("auth.loggedOut");
    } catch (e) {
      notify(e instanceof Error ? e : new Error(), true);
    }
  }
  function open(next: Dialog) {
    trigger.current = document.activeElement as HTMLElement;
    setDialog(next);
  }
  function close() {
    setDialog(null);
    requestAnimationFrame(
      () => trigger.current?.isConnected && trigger.current.focus(),
    );
  }
  useEffect(() => {
    if (state.user) setLocale(state.user.locale);
  }, [state.user?.id, state.user?.locale]);
  async function changeLocale(next: Locale) {
    setLocale(next);
    if (state.user) {
      setLanguageSaving(true);
      try {
        await mutate("/api/account/preferences", "PUT", { locale: next });
      } catch {
        notify("app.preferenceFailed", true);
      } finally {
        setLanguageSaving(false);
      }
    }
  }
  useEffect(() => {
    const invalid = (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (!input.validity) return;
      input.setCustomValidity("");
      input.setCustomValidity(inputMessage(locale, input));
    };
    for (const input of document.querySelectorAll<HTMLInputElement>(
      "input,textarea,select",
    )) {
      if (input.validity.customError) {
        input.setCustomValidity("");
        input.setCustomValidity(inputMessage(locale, input));
      }
    }
    const clear = (event: Event) =>
      (event.target as HTMLInputElement).setCustomValidity?.("");
    document.addEventListener("invalid", invalid, true);
    document.addEventListener("input", clear, true);
    return () => {
      document.removeEventListener("invalid", invalid, true);
      document.removeEventListener("input", clear, true);
    };
  }, [locale]);
  const selected = menus[current.role].find((m) => m.id === current.page),
    isAdmin = current.role === "admin";
  const validScope =
    !location.hash || /^#\/(admin|user)(\/[^/]+)?$/.test(location.hash);
  return (
    <AppContext.Provider
      value={{
        state,
        refresh,
        mutate,
        open,
        notify,
        changeLocale,
        languageSaving,
      }}
    >
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          contentRef.current?.focus();
        }}
      >
        {t("app.skip")}
      </a>
      <header className="topbar">
        <div className="brand-block">
          <button
            className="icon-button mobile-menu-button"
            onClick={() => setMobileMenu(!mobileMenu)}
            aria-label={mobileMenu ? t("app.closeMenu") : t("app.menu")}
            aria-expanded={mobileMenu}
            aria-controls="sidebar"
          >
            {mobileMenu ? <X size={21} /> : <Menu size={21} />}
          </button>
          <a
            className="brand"
            href={isAdmin ? "#/admin/overview" : "#/user/models"}
          >
            <span className="brand-logo">
              <Boxes size={23} />
            </span>
            <span>CoreMatrix</span>
          </a>
          {import.meta.env.DEV && (
            <span className="environment-badge">{t("app.dev")}</span>
          )}
        </div>
        <nav className="platform-switch" aria-label={t("app.user")}>
          <a href="#/user/models" aria-current={!isAdmin ? "true" : undefined}>
            {t("app.user")}
          </a>
          {state.user?.role === "admin" && (
            <a
              href="#/admin/overview"
              aria-current={isAdmin ? "true" : undefined}
            >
              {t("app.admin")}
            </a>
          )}
        </nav>
        <LanguageSelect />
        <a
          className="top-profile"
          href={isAdmin ? "#/admin/overview" : "#/user/account"}
        >
          <span className="avatar">
            {isAdmin ? "A" : state.user?.name.slice(0, 1) || "G"}
          </span>
          <span>{state.user?.name || t("app.guest")}</span>
        </a>
      </header>
      <div className="app-layout">
        <aside
          id="sidebar"
          className={`sidebar ${mobileMenu ? "is-open" : ""}`}
        >
          <div className="nav-label">
            {isAdmin ? t("app.management") : t("app.workspace")}
          </div>
          <nav aria-label={isAdmin ? t("app.admin") : t("app.user")}>
            {menus[current.role].map(({ id, label, icon: Icon }) => (
              <a
                key={id}
                href={`#/${current.role}/${id}`}
                className="nav-item"
                aria-current={current.page === id ? "page" : undefined}
              >
                <Icon size={18} />
                <span>{t(label)}</span>
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="demo-status">
              <span className="status-dot" />
              {state.user ? t("app.signedIn") : t("auth.needLogin")}
            </div>
            {state.user ? (
              <button className="reset-button" onClick={logout}>
                <LogOut size={14} />
                {t("auth.logout")}
              </button>
            ) : (
              <a className="reset-button" href="#/user/account">
                {t("auth.entry")}
              </a>
            )}
            <div className="workspace-card">
              <span className="avatar">
                {isAdmin ? "A" : state.user?.name.slice(0, 1) || "G"}
              </span>
              <div>
                <strong>{state.user?.name || t("app.guest")}</strong>
                <small>
                  {isAdmin ? t("app.management") : t("app.workspace")}
                </small>
              </div>
            </div>
          </div>
        </aside>
        {mobileMenu && (
          <button
            className="sidebar-backdrop"
            aria-label={t("app.closeMenu")}
            onClick={() => setMobileMenu(false)}
          />
        )}
        <main
          id="main-content"
          ref={contentRef}
          tabIndex={-1}
          className="main-content"
        >
          <div className="breadcrumb">
            <span>{isAdmin ? t("app.admin") : t("app.user")}</span>
            <span>/</span>
            <span>{selected ? t(selected.label) : t("app.notFound")}</span>
          </div>
          {connectionError && (
            <div className="storage-warning" role="alert">
              <Info size={16} />
              {t("app.connection")}
              <button
                className="text-link"
                onClick={() => refresh().catch(() => {})}
              >
                {t("common.retry")}
              </button>
            </div>
          )}
          {state.user && (state.paymentDebt > 0 || state.paymentReview) && (
            <div className="storage-warning" role="alert">
              {state.paymentReview
                ? t("payment.reviewNote")
                : t("payment.debtNote", { amount: money(state.paymentDebt) })}
            </div>
          )}
          {loading ? (
            <p className="muted">{t("app.loading")}</p>
          ) : mailLink ? (
            <EmailLinkForm
              key={mailLink.token}
              link={mailLink}
              close={clearMailLink}
            />
          ) : validScope && selected ? (
            isAdmin && state.user?.role !== "admin" ? (
              <>
                <PageHeader
                  title={state.user ? t("app.forbidden") : t("auth.needLogin")}
                  description={t("app.adminOnly")}
                />
                <a className="button primary" href="#/user/account">
                  {t("auth.login")}
                </a>
              </>
            ) : isAdmin ? (
              <AdminPages key={current.page} page={current.page} />
            ) : (
              <UserPages
                key={current.page + (state.user?.id || "guest")}
                page={current.page}
              />
            )
          ) : (
            <>
              <PageHeader
                title={t("app.notFound")}
                description={t("app.choosePage")}
              />
              <a
                href={isAdmin ? "#/admin/overview" : "#/user/models"}
                className="button primary"
              >
                {t("app.user")}
                <ArrowUpRight size={16} />
              </a>
            </>
          )}
          <footer className="app-footer">
            <span>CoreMatrix · {t("app.brand")}</span>
            <span>{t("app.data")}</span>
          </footer>
        </main>
      </div>
      {notice && (
        <div
          className={`toast ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.error ? (
            <TriangleAlert size={18} />
          ) : (
            <CheckCircle2 size={18} />
          )}
          <span>
            {notice.text instanceof Error
              ? errorText(notice.text)
              : t(notice.text)}
          </span>
          <button
            onClick={() => setNotice(null)}
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {dialog && <Dialogs dialog={dialog} close={close} />}
    </AppContext.Provider>
  );
}
