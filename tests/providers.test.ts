import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApplication } from "../server/app.ts";
import { Infrastructure } from "../server/infrastructure.ts";
import { digest, secret } from "../server/auth.ts";
import { providerAllowed } from "../server/providers.ts";
import { runtimeCredential, NODE_INFERENCE_KEY, NODE_WORKSPACE_KEY } from "../server/node-credentials.ts";

test("supplier ownership, platform-only pricing, inventory approval and per-node credentials",async t=>{
  const app=createApplication({databasePath:":memory:"}),s=app.store,infra=new Infrastructure(s);
  app.server.listen(0,"127.0.0.1");await once(app.server,"listening");
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(r=>app.server.close(()=>r()));await app.drain();s.close();});
  const supplier=s.createUser("Supplier","supplier@test.invalid","unused","provider"),other=s.createUser("Other","other@test.invalid","unused","provider"),admin=s.createUser("Admin","admin@test.invalid","unused","admin");
  const headers=new Map<string,Record<string,string>>();
  for(const u of [supplier,other,admin]){const token=secret(),csrf=secret();s.run("INSERT INTO sessions VALUES(?,?,?,?)",digest(token),u.id,csrf,Date.now()+60000);headers.set(u.id,{Cookie:"cm_session="+token,"X-CSRF-Token":csrf,"Content-Type":"application/json"});}
  async function call(path:string,method="GET",body?:unknown,user=supplier.id){const r=await fetch(`http://127.0.0.1:${(app.server.address() as any).port}`+path,{method,headers:headers.get(user),...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json()};}
  const config={name:"Supplier GPU",region:"Test",inferenceHost:"http://127.0.0.1",portStart:8000,portEnd:8031,workMode:"gpu-rental",hourlyPrice:9000000,rentalSalesEnabled:true};
  const created=await call("/api/provider/servers","POST",{...config,providerId:other.id,approved:true});
  assert.equal(created.status,201);const id=created.data.server.id;
  assert.equal(created.data.server.hourlyPrice,0);assert.equal(created.data.server.rentalSalesEnabled,false);assert.equal(created.data.server.schedulingEnabled,false);
  assert.equal((await call(`/api/provider/servers/${id}`,"GET",undefined,other.id)).status,404);
  assert.equal((await call(`/api/provider/servers/${id}/token`,"POST",{},other.id)).status,404);
  assert.equal((await call("/api/provider/servers","GET",undefined,other.id)).data.data.length,0);
  assert.equal((await call("/api/provider/profile")).data.profile.status,"pending");
  assert.equal((await call(`/api/admin/providers/${supplier.id}`,"PUT",{status:"approved",ratePerGpuHour:1800000},admin.id)).status,200);
  const live=infra.createNode({...config,name:"Self-owned"});
  let sequence=0;
  function beat(nodeId:string,uuid:string,scoped:boolean,seq:number){return infra.heartbeat(infra.node(nodeId),{instanceId:"go-test",bootId:"boot",sequence:seq,generation:seq===1?null:1,capabilities:{agentVersion:"5-go",dockerReady:true,workspaceReady:true,workspaceImageDigest:"sha256:"+"b".repeat(64),runtimeImageDigest:"",nodeScopedKeys:scoped},gpus:[{uuid,index:0,name:"GPU",totalMemoryMiB:24000,usedMemoryMiB:0,externalBusy:false}],containers:[],inventoryError:null}) as any;}
  beat(live.server.id,"GPU-owned",true,1);
  beat(id,"GPU-owned",false,++sequence);
  assert.equal(infra.billing.reservations.gpuIdentityConflict(live.server.id),false);
  assert.equal((await call(`/api/admin/provider-nodes/${id}/approval`,"POST",{approved:true},admin.id)).data.error.code,"provider_keys_required");
  const keys=beat(id,"GPU-owned",true,++sequence).credentials;
  assert.equal((await call(`/api/admin/provider-nodes/${id}/approval`,"POST",{approved:true},admin.id)).status,409);
  beat(id,"GPU-supplier",true,++sequence);
  assert.equal((await call(`/api/admin/provider-nodes/${id}/approval`,"POST",{approved:true},admin.id)).status,200);
  assert(providerAllowed(s,id));
  assert.equal(runtimeCredential(s,id,NODE_INFERENCE_KEY),keys.inference);
  assert.equal(runtimeCredential(s,id,NODE_WORKSPACE_KEY),keys.workspace);
  assert.notEqual(keys.inference,keys.workspace);
  assert.notEqual(keys.inference,runtimeCredential(s,live.server.id,NODE_INFERENCE_KEY));
  const shown=JSON.stringify((await call("/api/provider/servers")).data);
  assert(!shown.includes(keys.inference) && !shown.includes(keys.workspace) && !shown.includes("credentialSeed"));
  beat(id,"GPU-owned",true,++sequence);
  assert.equal(providerAllowed(s,id),false);
  assert.equal(infra.billing.reservations.gpuIdentityConflict(live.server.id),false);
  const rotated=await call(`/api/provider/servers/${id}/token`,"POST");assert.equal(rotated.status,200);
  assert.equal(runtimeCredential(s,id,NODE_INFERENCE_KEY),keys.inference);
  await call(`/api/provider/servers/${id}`,"PUT",config);
  const stored=JSON.parse(infra.node(id).data);assert.equal(stored.hourlyPrice,0);assert.equal(stored.rentalSalesEnabled,false);
});
