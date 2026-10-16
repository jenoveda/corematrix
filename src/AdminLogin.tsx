import { useState } from "react";
import { useApp } from "./context";
import { useI18n } from "./i18n";
import { PageHeader, Panel } from "./components";

export default function AdminLogin({portal="admin",allowRegister=false}:{portal?:"admin"|"provider";allowRegister?:boolean}) {
  const { mutate } = useApp(), { t, errorText } = useI18n();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const [register,setRegister]=useState(false);
  return <>
    <PageHeader title={t(portal==="admin"?"auth.adminRole":"app.provider") + " · " + t(register?"auth.register":"auth.login")} description={t(portal==="admin"?"auth.adminNote":"provider.note")} />
    <Panel title={t(register ? "auth.register" : "auth.login")}>
      <form className="panel-body form" onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true); setError(null);
        try {
          await mutate(`/api/auth/${register?"register":"login"}`, "POST", { email: form.get("email"), password: form.get("password"),...(register?{name:form.get("name")}: {}) });
          location.hash = `#/${portal}/overview`;
        } catch (e) { setError(e); } finally { setBusy(false); }
      }}>
        {allowRegister && <div className="actions"><button type="button" className="button" disabled={busy} aria-pressed={!register} onClick={()=>{setRegister(false);setError(null);}}>{t("auth.login")}</button><button type="button" className="button" disabled={busy} aria-pressed={register} onClick={()=>{setRegister(true);setError(null);}}>{t("auth.register")}</button></div>}
        {register && <label>{t("auth.team")}<input name="name" maxLength={40} required disabled={busy} autoComplete="organization" /></label>}
        <label>{t("auth.email")}<input name="email" type="email" maxLength={254} autoComplete="username" required disabled={busy} /></label>
        <label>{t("auth.password")}<input name="password" type="password" minLength={12} maxLength={128} autoComplete={register?"new-password":"current-password"} required disabled={busy} /></label>
        <button type="submit" className="button primary" disabled={busy}>{t(busy ? "common.processing" : register?"auth.registerSubmit":"auth.loginSubmit")}</button>
        {error !== null && <p className="form-error" role="alert">{errorText(error)}</p>}
      </form>
    </Panel>
  </>;
}
