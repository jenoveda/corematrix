import { useEffect, useState } from "react";
import { useApp } from "./context";
import { useI18n } from "./i18n";
import { request } from "./api";
import { MICRO } from "./domain";
import type { ProviderAdmin, ProviderBilling, ProviderProfile } from "./domain";
import { DataTable, Empty, Note, PageHeader, Panel, Stat, Stats } from "./components";

function Billing({path}:{path:string}) {
  const {t,money,date,number,errorText}=useI18n();
  const [report,setReport]=useState<ProviderBilling|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  async function load(before?:number) {
    setBusy(true);setError(null);
    try {setReport(await request<ProviderBilling>(path+(before?`?before=${before}`:"")));} catch(e){setError(e);} finally {setBusy(false);}
  }
  useEffect(()=>{void load();},[path]);
  return <>
    {report && <Stats>
      <Stat label={t("provider.gpuHours")} value={number(report.summary.gpuSeconds/3600)} detail="" />
      <Stat label={t("provider.earned")} value={money(report.summary.earned)} detail="" />
      <Stat label={t("provider.available")} value={money(report.summary.available)} detail={t("provider.pendingAmount")+": "+money(report.summary.pending)} />
      <Stat label={t("provider.paid")} value={money(report.summary.paid)} detail="" />
    </Stats>}
    <Panel title={t("provider.entries")}>
      <div className="panel-body actions"><button className="button" disabled={busy} onClick={()=>load()}>{t("common.refresh")}</button>{report?.nextCursor && <button className="button" disabled={busy} onClick={()=>load(report.nextCursor!)}>{t("provider.more")}</button>}</div>
      {report?.earnings.length ? <DataTable caption={t("provider.entries")} headers={[t("common.time"),t("deployment.model"),t("gpu.total"),t("provider.procurementPrice"),t("provider.earned")]} rows={report.earnings.map(e=>[date(new Date(e.startedAt).toISOString())+(e.endedAt===null?" · "+t("provider.pendingAmount"):" → "+date(new Date(e.endedAt).toISOString())),e.resource,number(e.gpuCount),money(e.ratePerGpuHour),money(e.amount)])} /> : <Empty title={t(busy?"app.loading":"common.none")} description="" />}
    </Panel>
    <Panel title={t("provider.settlements")}>
      {report?.settlements.length ? <DataTable caption={t("provider.settlements")} headers={[t("common.time"),t("common.amount"),t("provider.reference"),t("provider.reason")]} rows={report.settlements.map(s=>[date(s.createdAt),money(s.amount),s.reference,s.reason])} /> : <Empty title={t("common.none")} description="" />}
      <Note>{t("provider.settleNote")}</Note>
    </Panel>
    {error!==null && <p className="form-error" role="alert">{errorText(error)}</p>}
  </>;
}
export default function ProviderPages({page}:{page:string}) {
  const {state,open,refresh,notify}=useApp(),{t,status,number,money}=useI18n();
  const [profile,setProfile]=useState<ProviderProfile|null>(null);
  useEffect(()=>{let active=true;request<{profile:ProviderProfile}>("/api/provider/profile").then(data=>{if(active)setProfile(data.profile);}).catch(e=>notify(e,true));return()=>{active=false;};},[state.user?.id,state.servers]);
  return <>
    <PageHeader title={t(page==="servers"?"nav.servers":page==="billing"?"provider.entries":"app.provider")} description={t("provider.note")} actions={<>
      <button className="button" onClick={()=>refresh().catch(e=>notify(e,true))}>{t("common.refresh")}</button>
      <button className="button primary" onClick={()=>open({type:"server"})}>{t("server.add")}</button>
    </>} />
    {profile && <Note>{t(`provider.${profile.status}`)} · {t("provider.procurementPrice")}: {profile.ratePerGpuHour===null?t("common.none"):money(profile.ratePerGpuHour)}</Note>}
    {page!=="billing" && <Panel title={t("nav.servers")}>
      {state.servers.length ? <DataTable caption={t("nav.servers")} headers={[t("common.name"),t("common.status"),t("gpu.total"),t("gpu.free"),t("common.actions")]} rows={state.servers.map(s=>[s.name,status(s.status),number(s.gpus.length),number(s.freeGpuCount),<div className="actions"><button className="text-link" onClick={()=>open({type:"server",serverId:s.id})}>{t("common.edit")}</button><button className="text-link" onClick={()=>open({type:"server-token",serverId:s.id})}>{t("server.rotate")}</button><button className="text-link" onClick={()=>open({type:"delete-server",serverId:s.id})}>{t("common.delete")}</button></div>])} /> : <Empty title={t("common.none")} description="" />}
    </Panel>}
    {page==="servers" && state.servers.map(s=><Panel key={s.id} title={s.name+" · GPU"}>
      <DataTable caption={s.name+" GPU"} headers={[t("common.name"),"UUID",t("gpu.memory"),t("common.status")]} rows={s.gpus.map(g=>[g.name,g.uuid,(g.usedMemoryMiB===null?t("common.unknown"):number(g.usedMemoryMiB))+" / "+number(g.totalMemoryMiB)+" MiB",t(g.allocated?"gpu.allocated":g.externalBusy?"gpu.external":"gpu.free")])} />
    </Panel>)}
    {page!=="servers" && <Billing key={state.user!.id} path="/api/provider/billing" />}
  </>;
}

export function AdminProviders() {
  const {mutate,notify}=useApp(),{t,money,number,errorText}=useI18n();
  const [providers,setProviders]=useState<ProviderAdmin[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  async function load(){setProviders((await request<{data:ProviderAdmin[]}>("/api/admin/providers")).data);}
  useEffect(()=>{load().catch(setError);},[]);
  async function update(path:string,method:string,body:unknown) {
    setBusy(true);setError(null);
    try {await mutate(path,method,body);await load();notify("provider.updated");} catch(e){setError(e);} finally {setBusy(false);}
  }
  return <>
    <PageHeader title={t("nav.providers")} description={t("provider.note")} actions={<button className="button" disabled={busy} onClick={()=>load().catch(setError)}>{t("common.refresh")}</button>} />
    {!providers.length && <Empty title={t("common.none")} description="" />}
    {providers.map(p=><Panel key={p.userId} title={p.name+" · "+p.email}>
      <div className="panel-body form">
        <strong>{t(`provider.${p.status}`)} · {t("provider.available")}: {money(p.summary.available)} · {t("provider.pendingAmount")}: {money(p.summary.pending)}</strong>
        <form className="form" key={p.updatedAt} onSubmit={event=>{
          event.preventDefault();const form=new FormData(event.currentTarget),rate=String(form.get("rate"));
          void update(`/api/admin/providers/${p.userId}`,"PUT",{status:form.get("status"),ratePerGpuHour:rate===""?null:Math.round(Number(rate)*MICRO)});
        }}>
          <label>{t("provider.procurementPrice")}<input name="rate" type="number" min="0" max="100000" step="0.000001" defaultValue={p.ratePerGpuHour===null?"":p.ratePerGpuHour/MICRO} disabled={busy} /></label>
          <label>{t("common.status")}<select name="status" defaultValue={p.status==="suspended"?"suspended":"approved"} disabled={busy}><option value="approved">{t("provider.approved")}</option><option value="suspended">{t("provider.suspended")}</option></select></label>
          <button className="button" disabled={busy}>{t("common.save")}</button>
        </form>
        <DataTable caption={t("nav.servers")} headers={[t("common.name"),t("gpu.total"),t("common.status"),t("common.actions")]} rows={p.servers.map(s=>[s.name,number(s.gpus.length),t(s.approved?"provider.approved":"provider.pending"),<button className="button" disabled={busy} onClick={()=>update(`/api/admin/provider-nodes/${s.id}/approval`,"POST",{approved:!s.approved})}>{t(s.approved?"provider.revokeNode":"provider.approveNode")}</button>])} />
        <form className="form" onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);void update(`/api/admin/providers/${p.userId}/settlements`,"POST",{amount:p.summary.available,reference:form.get("reference"),reason:form.get("reason")});}}>
          <Note>{t("provider.settleNote")}</Note>
          <label>{t("provider.reference")}<input name="reference" minLength={8} maxLength={100} required disabled={busy} /></label>
          <label>{t("provider.reason")}<input name="reason" maxLength={500} required disabled={busy} /></label>
          <button className="button primary" disabled={busy || p.summary.available<=0}>{t("provider.settle")}</button>
        </form>
        <Billing key={p.userId+":"+p.summary.paid} path={`/api/admin/providers/${p.userId}/billing`} />
      </div>
    </Panel>)}
    {error!==null && <p className="form-error" role="alert">{errorText(error)}</p>}
  </>;
}
