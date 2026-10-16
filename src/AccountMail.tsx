import { useEffect, useState } from "react";
import { useApp } from "./context";
import { useI18n } from "./i18n";
import { ApiError } from "./api";
import { Badge, Note, Panel } from "./components";
type MailLink = { purpose: "verify" | "reset"; token: string };
function readLink(): MailLink | null {
  if (!location.hash.startsWith("#/user/account?")) return null;
  const params = new URLSearchParams(location.hash.split("?")[1]),
    purpose = params.get("mail"),
    token = params.get("token");
  return (purpose === "verify" || purpose === "reset") && token
    ? { purpose, token }
    : null;
}
export function useMailLink() {
  const [link, setLink] = useState(readLink);
  useEffect(() => {
    const changed = () => setLink(readLink());
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    if (link)
      history.replaceState(
        null,
        "",
        location.pathname + location.search + "#/user/account",
      );
  }, [link]);
  return [link, () => setLink(null)] as const;
}
export function EmailStatus() {
  const { state, mutate } = useApp(),
    { t, errorText } = useI18n(),
    [busy, setBusy] = useState(false),
    [sent, setSent] = useState(false),
    [error, setError] = useState<unknown>(null);
  if (!state.user) return null;
  return (
    <>
      <Badge tone={state.user.emailVerifiedAt ? "green" : "amber"}>
        {t(state.user.emailVerifiedAt ? "mail.verified" : "mail.unverified")}
      </Badge>
      {!state.user.emailVerifiedAt && (
        <>
          <p className="muted">{t("mail.verificationNote")}</p>
          <button
            type="button"
            className="button"
            disabled={busy || !state.mailEnabled}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await mutate("/api/account/verification", "POST");
                setSent(true);
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t(busy ? "common.processing" : "mail.sendVerification")}
          </button>
          {sent && <p role="status">{t("mail.verificationSent")}</p>}
        </>
      )}
      {!state.mailEnabled && <Note>{t("mail.unavailable")}</Note>}
      {error !== null && (
        <p className="form-error" role="alert">
          {errorText(error)}
        </p>
      )}
    </>
  );
}
export function EmailLinkForm({
  link,
  close,
}: {
  link: MailLink;
  close: () => void;
}) {
  const { mutate } = useApp(),
    { t, errorText } = useI18n(),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState<unknown>(null);
  return (
    <Panel
      title={t(
        link.purpose === "verify" ? "mail.verifyTitle" : "mail.resetTitle",
      )}
    >
      {done ? (
        <div className="panel-body form">
          <p role="status">
            {t(
              link.purpose === "verify"
                ? "mail.verifiedDone"
                : "mail.resetDone",
            )}
          </p>
          <button className="button primary" onClick={close}>
            {t("mail.backAccount")}
          </button>
        </div>
      ) : (
        <form
          className="panel-body form"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            const f = new FormData(e.currentTarget);
            if (
              link.purpose === "reset" &&
              f.get("password") !== f.get("confirmation")
            ) {
              setError(
                new ApiError(400, "Passwords differ", "password_mismatch"),
              );
              return;
            }
            setBusy(true);
            try {
              await mutate(
                "/api/auth/" +
                  (link.purpose === "verify"
                    ? "verify-email"
                    : "reset-password"),
                "POST",
                {
                  token: link.token,
                  ...(link.purpose === "reset"
                    ? { password: f.get("password") }
                    : {}),
                },
              );
              setDone(true);
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Note>
            {t(
              link.purpose === "verify"
                ? "mail.verifyConfirm"
                : "mail.resetConfirm",
            )}
          </Note>
          {link.purpose === "reset" && (
            <>
              <label>
                {t("mail.newPassword")}
                <input
                  name="password"
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  disabled={busy}
                />
              </label>
              <label>
                {t("mail.confirmPassword")}
                <input
                  name="confirmation"
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  disabled={busy}
                />
              </label>
            </>
          )}
          {error !== null && (
            <p className="form-error" role="alert">
              {errorText(error)}
            </p>
          )}
          <div className="actions">
            <button className="button primary" disabled={busy} type="submit">
              {t(
                busy
                  ? "common.processing"
                  : link.purpose === "verify"
                    ? "mail.verifyTitle"
                    : "mail.resetTitle",
              )}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={close}
            >
              {t("mail.backAccount")}
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}
