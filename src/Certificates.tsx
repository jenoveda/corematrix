import { useEffect, useState } from "react";
import { useApp } from "./context";
import { useI18n } from "./i18n";
import { request } from "./api";
import { PageHeader, Panel, Note } from "./components";
import type { CertificateInfo, Portal } from "./domain";

export default function Certificates() {
  const { mutate, notify } = useApp(), { t, date, errorText } = useI18n();
  const [data, setData] = useState<CertificateInfo[]>([]), [available,setAvailable] = useState(false);
  const [busy,setBusy] = useState(false), [error,setError] = useState<unknown>(null);
  const [portal,setPortal] = useState<Portal>("user");
  async function load() {
    const result = await request<{available:boolean;data:CertificateInfo[]}>("/api/admin/certificates");
    setAvailable(result.available); setData(result.data);
  }
  useEffect(() => { load().catch(setError); }, []);
  return <>
    <PageHeader title={t("nav.certificates")} description={t("tls.note")} actions={<button className="button" disabled={busy} onClick={() => load().catch(setError)}>{t("common.refresh")}</button>} />
    <div className="grid grid-two">
      {data.map(info => <Panel key={info.portal} title={t(info.portal === "provider" ? "app.provider" : info.portal === "user" ? "app.user" : "app.admin")}>
        <div className="panel-body form">
          <strong>{t(info.configured ? "tls.enabled" : "tls.notConfigured")}</strong>
          {info.origin && <a className="text-link" href={info.origin} target="_blank" rel="noreferrer">{info.origin}</a>}
          {info.validTo && <p>{t("tls.validTo")}: {date(info.validTo)} {info.expired && t("tls.expired")}</p>}
          {info.issuer && <p>{t("tls.issuer")}: {info.issuer}</p>}
          {info.fingerprint && <p className="muted" style={{overflowWrap:"anywhere"}}>{t("tls.fingerprint")}: {info.fingerprint}</p>}
        </div>
      </Panel>)}
    </div>
    <Panel title={t("tls.upload")}>
      <form className="panel-body form" key={portal} onSubmit={async event => {
        event.preventDefault(); const form = event.currentTarget, fields = new FormData(form);
        const certificate = fields.get("certificate") as File, privateKey = fields.get("privateKey") as File;
        setBusy(true); setError(null);
        try {
          if (certificate.size > 32768 || privateKey.size > 16384) throw new Error(t("errors.invalid_certificate"));
          const result = await mutate<{data:CertificateInfo[]}>(`/api/admin/certificates/${portal}`,"PUT",{
            origin:fields.get("origin"),certificate:await certificate.text(),privateKey:await privateKey.text(),
          });
          setData(result.data); form.reset(); notify("tls.saved");
        } catch(e) { setError(e); } finally { setBusy(false); }
      }}>
        <label>{t("tls.platform")}<select value={portal} disabled={busy} onChange={event => {setPortal(event.target.value as Portal);setError(null);}}>
          <option value="user">{t("app.user")}</option><option value="admin">{t("app.admin")}</option><option value="provider">{t("app.provider")}</option>
        </select></label>
        <label>{t("tls.origin")}<input name="origin" type="url" required maxLength={300} placeholder={portal === "provider" ? "https://console.example.com:8444" : portal === "user" ? "https://console.example.com" : "https://console.example.com:8443"} disabled={busy} /></label>
        <label>{t("tls.certificate")}<input name="certificate" type="file" accept=".pem,.crt,.cer" required disabled={busy} /></label>
        <label>{t("tls.privateKey")}<input name="privateKey" type="file" accept=".pem,.key" required disabled={busy} /></label>
        <Note>{t("tls.bootstrap")}</Note>
        <button className="button primary" type="submit" disabled={busy || !available}>{t(busy ? "common.processing" : "tls.upload")}</button>
        {error !== null && <p className="form-error" role="alert">{errorText(error)}</p>}
      </form>
    </Panel>
  </>;
}
