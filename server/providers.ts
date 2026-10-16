import { randomUUID } from "node:crypto";
import { check, int, text } from "./validation.ts";
import type { Store } from "./store.ts";
import type { Infrastructure } from "./infrastructure.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderBilling } from "../src/domain.ts";

export function providerAllowed(store: Store, serverId: string) {
  const row=store.get<{approved:number;status:string;ratePerGpuHour:number|null;capabilities:string;credentialSeed:string|null}>(
    "SELECT n.approved,p.status,p.ratePerGpuHour,s.capabilities,s.credentialSeed FROM provider_nodes n JOIN providers p ON p.userId=n.providerId JOIN servers s ON s.id=n.serverId WHERE n.serverId=?",serverId);
  return !row || (row.approved===1 && row.status==="approved" && row.ratePerGpuHour!==null && JSON.parse(row.capabilities).nodeScopedKeys===true && !!row.credentialSeed);
}
type Usage = {deploymentId:string;providerId:string;ratePerGpuHour:number;gpuCount:number;resource:string;startedAt:number;endedAt:number|null;amount:number|null;settlementId:string|null};
export function procurementAmount(usage:Pick<Usage,"startedAt"|"ratePerGpuHour"|"gpuCount">, at:number) {
  const seconds=Math.max(0,Math.floor((at-usage.startedAt)/1000));
  const amount=BigInt(seconds)*BigInt(usage.ratePerGpuHour)*BigInt(usage.gpuCount)/3600n;
  check(amount<=BigInt(Number.MAX_SAFE_INTEGER),"Procurement amount exceeds safe range",500,"internal_error");
  return Number(amount);
}
export function startProcurement(store:Store,deploymentId:string) {
  if(store.get("SELECT 1 FROM provider_usage WHERE deploymentId=?",deploymentId)) return;
  const row=store.get<{providerId:string;ratePerGpuHour:number|null;spec:string;modelId:string|null;data:string}>("SELECT n.providerId,p.ratePerGpuHour,d.spec,d.modelId,s.data FROM deployments d JOIN provider_nodes n ON n.serverId=d.serverId JOIN providers p ON p.userId=n.providerId JOIN servers s ON s.id=d.serverId WHERE d.id=?",deploymentId);
  if(!row) return;
  check(row.ratePerGpuHour!==null,"Procurement price missing",409,"provider_unavailable");
  const spec=JSON.parse(row.spec), resource=row.modelId || JSON.parse(row.data).name+" · GPU";
  store.run("INSERT INTO provider_usage(deploymentId,providerId,ratePerGpuHour,gpuCount,resource,startedAt) VALUES(?,?,?,?,?,?)",deploymentId,row.providerId,row.ratePerGpuHour,spec.gpuUuids.length,resource,Date.now());
}
export function stopProcurement(store:Store,deploymentId:string) {
  const row=store.get<Usage>("SELECT * FROM provider_usage WHERE deploymentId=?",deploymentId);
  if(!row || row.endedAt!==null) return;
  const endedAt=Math.max(row.startedAt,Date.now());
  store.run("UPDATE provider_usage SET endedAt=?,amount=? WHERE deploymentId=? AND endedAt IS NULL",endedAt,procurementAmount(row,endedAt),deploymentId);
}
export function providerReport(store:Store,providerId:string,before=Number.MAX_SAFE_INTEGER):ProviderBilling {
  const now=Date.now(),all=store.all<Usage>("SELECT * FROM provider_usage WHERE providerId=?",providerId);
  const summary={gpuSeconds:0,earned:0,paid:0,available:0,pending:0};
  for(const row of all){
    const amount=row.amount??procurementAmount(row,now);
    summary.gpuSeconds+=Math.max(0,Math.floor(((row.endedAt??now)-row.startedAt)/1000))*row.gpuCount;
    summary.earned+=amount;
    if(row.settlementId) summary.paid+=amount;
    else if(row.endedAt!==null) summary.available+=amount;
    else summary.pending+=amount;
  }
  const rows=store.all<Usage & {cursor:number}>("SELECT rowid cursor,* FROM provider_usage WHERE providerId=? AND rowid<? ORDER BY rowid DESC LIMIT 51",providerId,before);
  return {summary,earnings:rows.slice(0,50).map(({cursor:_,...row})=>({...row,amount:row.amount??procurementAmount(row,now)})),nextCursor:rows.length>50?rows[49].cursor:null,
    settlements:store.all("SELECT id,amount,reference,reason,createdAt FROM provider_settlements WHERE providerId=? ORDER BY rowid DESC LIMIT 100",providerId)};
}
// Assign each micro-yuan once across Shanghai business days using cumulative interval costs.
export function procurementCosts(store:Store,from:string,to:string) {
  const begin=Date.parse(from+"T00:00:00+08:00"),end=Date.parse(to+"T00:00:00+08:00")+86400000,now=Date.now();
  const daily=new Map<string,number>();let count=0;
  for(const row of store.all<Usage>("SELECT * FROM provider_usage WHERE startedAt<? AND (endedAt IS NULL OR endedAt>?)",end,begin)) {
    const stop=Math.min(row.endedAt??now,end);if(stop<=begin) continue;count++;
    for(let at=Math.max(begin,Math.floor((row.startedAt+28800000)/86400000)*86400000-28800000);at<stop;at+=86400000){
      const day=new Date(at+28800000).toISOString().slice(0,10);
      const amount=procurementAmount(row,Math.min(at+86400000,stop))-procurementAmount(row,Math.max(at,row.startedAt));
      daily.set(day,(daily.get(day)??0)+amount);
    }
  }
  return {daily:[...daily].map(([day,cost])=>({day,cost})),cost:[...daily.values()].reduce((a,b)=>a+b,0),count};
}
export function settleProvider(store:Store,providerId:string,data:Record<string,unknown>,actorId:string) {
  const reference=text(data.reference,"reference",100),reason=text(data.reason,"reason",500),expected=int(data.amount,"amount",1,Number.MAX_SAFE_INTEGER);
  check(reference.length>=8,"Reference is too short");
  return store.transaction(()=>{
    const previous=store.get<{providerId:string;amount:number;reason:string}>("SELECT * FROM provider_settlements WHERE reference=?",reference);
    if(previous){check(previous.providerId===providerId && previous.amount===expected && previous.reason===reason,"Settlement reference conflict",409,"idempotency_conflict");return previous;}
    const amount=providerReport(store,providerId).summary.available;
    check(amount===expected && amount>0,"Settlement amount changed",409,"provider_settlement_changed");
    const id=randomUUID();
    store.run("INSERT INTO provider_settlements VALUES(?,?,?,?,?,?,?)",id,providerId,amount,reference,reason,actorId,new Date().toISOString());
    store.run("UPDATE provider_usage SET settlementId=? WHERE providerId=? AND settlementId IS NULL AND endedAt IS NOT NULL",id,providerId);
    return {id,providerId,amount,reference,reason};
  });
}
export function ownedServers(store: Store, infra: Infrastructure, providerId: string) {
  return store.all<{serverId:string}>("SELECT n.serverId FROM provider_nodes n JOIN servers s ON s.id=n.serverId WHERE n.providerId=? AND s.deleted=0 ORDER BY s.rowid DESC",providerId)
    .map(row => ({...infra.server(infra.node(row.serverId)),approved:!!store.get<{approved:number}>("SELECT approved FROM provider_nodes WHERE serverId=?",row.serverId)!.approved}));
}
type Helpers = {
  store: Store; infrastructure: Infrastructure;
  authenticate: (req:IncomingMessage) => {user:{id:string;role:string}};
  admin: (req:IncomingMessage) => {user:{id:string}};
  body: (req:IncomingMessage) => Promise<Record<string,unknown>>;
  send: (res:ServerResponse,status:number,data:unknown) => void;
};
export async function handleProviders(req:IncomingMessage,res:ServerResponse,path:string,method:string,h:Helpers) {
  if (!/^\/api\/(provider\/|admin\/(providers|provider-nodes)(\/|$))/.test(path)) return false;
  const {store,infrastructure:infra}=h;
  const before=int(Number(new URL(req.url || "/","http://localhost").searchParams.get("before") || Number.MAX_SAFE_INTEGER),"cursor",1,Number.MAX_SAFE_INTEGER);
  if (path.startsWith("/api/provider/")) {
    const {user}=h.authenticate(req); check(user.role==="provider","Supplier login required",403,"forbidden");
    if (method==="GET" && path==="/api/provider/profile") {
      h.send(res,200,{profile:store.get("SELECT userId,status,ratePerGpuHour,updatedAt FROM providers WHERE userId=?",user.id)});return true;
    }
    if (method==="GET" && path==="/api/provider/billing") {h.send(res,200,providerReport(store,user.id,before));return true;}
    const route=path.match(/^\/api\/provider\/servers(?:\/([a-f0-9-]+)(?:\/(token))?)?$/);
    check(route,"Not found",404,"not_found");
    const id=route[1];
    if (id) check(store.get("SELECT 1 FROM provider_nodes n JOIN servers s ON s.id=n.serverId WHERE n.serverId=? AND n.providerId=? AND s.deleted=0",id,user.id),"Not found",404,"not_found");
    if (method==="GET") {h.send(res,200,id?{server:infra.server(infra.node(id))}:{data:ownedServers(store,infra,user.id)});return true;}
    const data=(method==="POST" && !route[2]) || method==="PUT" ? await h.body(req) : {};
    const result=store.transaction(() => {
      if (!id && method==="POST") {
        const created=infra.createNode({...data,hourlyPrice:0,rentalSalesEnabled:false});
        store.run("INSERT INTO provider_nodes(serverId,providerId) VALUES(?,?)",created.server.id,user.id);
        return {...created,server:infra.server(infra.node(created.server.id))};
      }
      if (id && method==="PUT" && !route[2]) {
        const current=JSON.parse(infra.node(id).data);
        infra.updateNode(id,{...data,hourlyPrice:current.hourlyPrice??0,rentalSalesEnabled:current.rentalSalesEnabled??false});
        store.run("UPDATE provider_nodes SET approved=0 WHERE serverId=?",id);
        return {server:infra.server(infra.node(id))};
      }
      if (id && method==="POST" && route[2]==="token") return infra.rotateNodeToken(id);
      if (id && method==="DELETE" && !route[2]) return infra.deleteNode(id);
      check(false,"Not found",404,"not_found");
    });
    h.send(res,!id?201:200,result);return true;
  }
  if (!/^\/api\/admin\/(providers|provider-nodes)(\/|$)/.test(path)) return false;
  const actor=h.admin(req).user;
  if (method==="GET" && path==="/api/admin/providers") {
    const data=store.all<{userId:string}>("SELECT p.*,u.name,u.email FROM providers p JOIN users u ON u.id=p.userId ORDER BY p.rowid DESC")
      .map(profile=>({...profile,...providerReport(store,profile.userId),servers:ownedServers(store,infra,profile.userId)}));
    h.send(res,200,{data});return true;
  }
  const profilePath=path.match(/^\/api\/admin\/providers\/([a-f0-9-]+)(?:\/(settlements|billing))?$/);
  if(profilePath) {
    const id=profilePath[1];check(store.get("SELECT 1 FROM providers WHERE userId=?",id),"Not found",404,"not_found");
    if(method==="GET" && profilePath[2]==="billing") {h.send(res,200,providerReport(store,id,before));return true;}
    if(method==="POST" && profilePath[2]==="settlements") {h.send(res,200,settleProvider(store,id,await h.body(req),actor.id));return true;}
    check(method==="PUT" && !profilePath[2],"Not found",404,"not_found");
    const data=await h.body(req);check(["approved","suspended"].includes(String(data.status)),"Invalid supplier status");
    const rate=data.ratePerGpuHour==null && data.status==="suspended" ? store.get<{ratePerGpuHour:number|null}>("SELECT ratePerGpuHour FROM providers WHERE userId=?",id)!.ratePerGpuHour : int(data.ratePerGpuHour,"ratePerGpuHour",0,100000000000);
    store.run("UPDATE providers SET status=?,ratePerGpuHour=?,reviewedBy=?,updatedAt=? WHERE userId=?",String(data.status),rate,actor.id,new Date().toISOString(),id);
    h.send(res,200,{ok:true});return true;
  }
  const nodePath=path.match(/^\/api\/admin\/provider-nodes\/([a-f0-9-]+)\/approval$/);
  check(nodePath && method==="POST","Not found",404,"not_found");
  const data=await h.body(req);
  check(typeof data.approved==="boolean","Approval must be boolean");
  store.transaction(()=>{
    const node=store.get<{status:string;ratePerGpuHour:number|null}>("SELECT p.status,p.ratePerGpuHour FROM provider_nodes n JOIN providers p ON p.userId=n.providerId JOIN servers s ON s.id=n.serverId WHERE n.serverId=? AND s.deleted=0",nodePath[1]);
    check(node,"Not found",404,"not_found");
    check(!data.approved || (node.status==="approved" && node.ratePerGpuHour!==null),"Approve supplier and configure procurement price first",409,"provider_unavailable");
    const uuids=store.all<{uuid:string}>("SELECT uuid FROM gpus WHERE serverId=? AND missing=0 ORDER BY uuid",nodePath[1]).map(g=>g.uuid);
    check(!data.approved || JSON.parse(infra.node(nodePath[1]).capabilities).nodeScopedKeys===true,"Enable node-scoped credentials before approval",409,"provider_keys_required");
    check(!data.approved || (uuids.length>0 && infra.online(infra.node(nodePath[1])) && !infra.node(nodePath[1]).inventoryError && !infra.billing.reservations.gpuIdentityConflict(nodePath[1])),"Verify live GPU inventory before approval",409,"provider_inventory_unverified");
    store.run("UPDATE provider_nodes SET approved=?,reviewedGpuUuids=? WHERE serverId=?",data.approved?1:0,JSON.stringify(uuids),nodePath[1]);
  });
  h.send(res,200,{ok:true});return true;
}
