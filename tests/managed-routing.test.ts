import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createApplication } from "../server/app.ts";
import { Infrastructure } from "../server/infrastructure.ts";
import { digest, secret } from "../server/auth.ts";
import { reconcile } from "../server/finance.ts";
import { providerReport, startProcurement, stopProcurement, procurementCosts } from "../server/providers.ts";
import { NODE_INFERENCE_KEY, runtimeCredential } from "../server/node-credentials.ts";

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail("Timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture(t: any) {
  const peers = ["a", "b"].map((name) => {
    const calls: { text: string; res: ServerResponse; authorization:string }[] = [];
    const server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") {
        res.end(JSON.stringify({ data: [{ id: "routed-model" }] }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ text: body.messages[0].content, res, authorization:req.headers.authorization || "" });
    });
    return {
      name,
      calls,
      server,
      finish(text: string, ok = true) {
        const call = calls.find((c) => c.text === text)!;
        assert(call);
        if (ok)
          call.res.end(
            JSON.stringify({
              choices: [{ message: { content: name + ":" + text } }],
              usage: { prompt_tokens: 2, completion_tokens: 1 },
            }),
          );
        else {
          call.res.statusCode = 500;
          call.res.end("upstream failure");
        }
      },
    };
  });
  for (const p of peers) {
    p.server.listen(0, "127.0.0.1");
    await once(p.server, "listening");
  }
  const app = createApplication({ databasePath: ":memory:" }),
    s = app.store,
    infra = new Infrastructure(s);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    app.server.closeAllConnections();
    for (const p of peers)
      for (const c of p.calls) if (!c.res.writableEnded) c.res.end();
    await new Promise<void>((r) => app.server.close(() => r()));
    await app.drain();
    for (const p of peers) {
      p.server.closeAllConnections();
      await new Promise<void>((r) => p.server.close(() => r()));
    }
    s.close();
  });
  const user = s.createUser(
      "Buyer",
      "routing@tests.invalid",
      "unused",
      "admin",
    ),
    cookie = secret(),
    csrf = secret();
  s.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    digest(cookie),
    user.id,
    csrf,
    Date.now() + 100000,
  );
  s.run("UPDATE users SET balance=1000 WHERE id=?", user.id);
  s.run(
    "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES(?,?,'recharge','Test','Test',1000,?,?)",
    randomUUID(),
    user.id,
    new Date().toISOString(),
    "2026-10-16",
  );
  const model = {
    ...s.model("qwen2.5-7b")!,
    id: "routed-model",
    enabled: true,
    routingMode: "managed",
    gpus: 1,
    contextTokens: 4,
    maxOutputTokens: 4,
    inputPrice: 1000000,
    outputPrice: 1000000,
    apiKeyEnv: "",
    runtime: {
      artifact: "test/model",
      revision: "v1",
      dtype: "auto",
      maxModelLen: 8,
      minGpuMemoryMiB: 1,
      tensorParallelSize: 1,
    },
  };
  s.run(
    "INSERT INTO models(id,data) VALUES(?,?)",
    model.id,
    JSON.stringify(model),
  );
  const ids = peers.map((p, i) => {
    const id = `00000000-0000-4000-8000-00000000000${i + 1}`,
      port = (p.server.address() as any).port;
    s.run(
      "INSERT INTO servers(id,data,tokenHash,lastHeartbeat,capabilities) VALUES(?,?,?,?,?)",
      p.name,
      JSON.stringify({
        name: p.name,
        region: "Test",
        inferenceHost: "http://127.0.0.1",
        portStart: port,
        portEnd: port,
        schedulingEnabled: true,
        maintenance: false,
        workMode: "inference",
      }),
      digest(secret()),
      Date.now(),
      JSON.stringify({ dockerReady: true, inferenceReady: true }),
    );
    s.run(
      "INSERT INTO deployments(id,serverId,modelId,phase,spec,actorId,requestKey,fingerprint,createdAt,healthAt) VALUES(?,?,?,'ready',?,?,?,?,?,?)",
      id,
      p.name,
      model.id,
      JSON.stringify({
        gpuUuids: ["GPU-" + p.name],
        endpointPort: port,
        servedModelName: model.id,
        apiKeyEnv: "",
      }),
      user.id,
      randomUUID(),
      "test",
      Date.now(),
      Date.now() - (i === 0 ? 5000 : 0),
    );
    s.run("INSERT INTO port_allocations VALUES(?,?,?,0)", id, p.name, port);
    s.run(
      "INSERT INTO gpu_allocations VALUES(?,?,?,0)",
      id,
      p.name,
      "GPU-" + p.name,
    );
    return id;
  });
  function chat(text: string, key = randomUUID(), signal?: AbortSignal) {
    return fetch(
      `http://127.0.0.1:${(app.server.address() as any).port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Cookie: "cm_session=" + cookie,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: text }],
          max_tokens: 2,
        }),
        signal,
      },
    ).then(async (r) => ({ status: r.status, body: await r.json() }));
  }
  function pending(deploymentId: string, status = "pending") {
    s.run(
      "INSERT INTO requests(id,userId,requestKey,fingerprint,day,status,reserved,modelId,modelName,inputPrice,outputPrice,createdAt,deploymentId) VALUES(?,?,?,?,?,?,0,?,?,0,0,?,?)",
      randomUUID(),
      user.id,
      randomUUID(),
      "test",
      "2026-10-16",
      status,
      model.id,
      model.name,
      new Date().toISOString(),
      deploymentId,
    );
  }
  return { app, s, infra, user, model, peers, ids, chat, pending };
}

test("supplier Token routing uses its own key while GPU-time costs are independent of usage or failed requests",async t=>{
  const f=await fixture(t),provider=f.s.createUser("Supplier","supplier-token@tests.invalid","unused","provider"),seed=secret();
  f.s.run("UPDATE providers SET status='approved',ratePerGpuHour=3600000 WHERE userId=?",provider.id);
  f.s.run("UPDATE servers SET credentialSeed=?,capabilities=json_set(capabilities,'$.nodeScopedKeys',json('true')) WHERE id='a'",seed);
  f.s.run("UPDATE deployments SET spec=json_set(spec,'$.apiKeyEnv',?) WHERE id=?",NODE_INFERENCE_KEY,f.ids[0]);
  f.s.run("INSERT INTO provider_nodes(serverId,providerId,approved) VALUES('a',?,1)",provider.id);
  startProcurement(f.s,f.ids[0]);startProcurement(f.s,f.ids[0]);
  f.s.run("UPDATE provider_usage SET startedAt=?",Date.now()-3600000);
  assert(providerReport(f.s,provider.id).summary.pending>=3600000);
  const key=randomUUID(),pending=f.chat("supplier",key);
  await until(()=>f.peers[0].calls.some(c=>c.text==="supplier"));
  assert.equal(f.peers[0].calls[0].authorization,"Bearer "+runtimeCredential(f.s,"a",NODE_INFERENCE_KEY));
  f.s.run("UPDATE providers SET ratePerGpuHour=9000000 WHERE userId=?",provider.id);
  f.peers[0].finish("supplier");assert.equal((await pending).status,200);
  assert.equal((await f.chat("supplier",key)).status,200);
  const failed=f.chat("failed-supplier");await until(()=>f.peers[0].calls.some(c=>c.text==="failed-supplier"));f.peers[0].finish("failed-supplier",false);assert.equal((await failed).status,502);
  f.s.run("UPDATE gpu_allocations SET released=1 WHERE deploymentId=?",f.ids[0]);
  stopProcurement(f.s,f.ids[0]);stopProcurement(f.s,f.ids[0]);
  const report=providerReport(f.s,provider.id);
  assert.equal(report.earnings.length,1);assert.equal(report.earnings[0].ratePerGpuHour,3600000);
  assert(report.summary.available>=3600000);
  assert(!JSON.stringify(f.infra.server(f.infra.node("a"))).includes(seed));
  assert.equal(reconcile(f.s).healthy,true);
  f.s.run("UPDATE provider_usage SET startedAt=?,endedAt=?,amount=2000",Date.parse("2026-10-15T23:59:59+08:00"),Date.parse("2026-10-16T00:00:01+08:00"));
  const previous=procurementCosts(f.s,"2026-10-15","2026-10-15"),next=procurementCosts(f.s,"2026-10-16","2026-10-16");
  assert.equal(previous.cost,1000);assert.equal(next.cost,1000);
  assert.equal(procurementCosts(f.s,"2026-10-15","2026-10-16").cost,previous.cost+next.cost);
});

test("duplicate legacy physical claims quarantine inference routing and audit without releasing either claim", async (t) => {
  const f = await fixture(t);
  f.s.run("UPDATE gpu_allocations SET uuid='GPU-a' WHERE serverId='b'");
  const before = {
    balance: f.s.user(f.user.id)!.balance,
    allocations: f.s.all("SELECT * FROM gpu_allocations"),
  };
  assert.equal(f.infra.route(f.model.id), undefined);
  const result = await f.chat("duplicate-resource");
  assert.equal(result.status, 503);
  assert.equal(f.peers.flatMap((p) => p.calls).length, 0);
  assert.ok(
    reconcile(f.s).issues.some(
      (i) =>
        i.code === "duplicate_gpu_allocation" &&
        i.entityId === "GPU-a" &&
        i.actual === 2,
    ),
  );
  assert.deepEqual(
    {
      balance: f.s.user(f.user.id)!.balance,
      allocations: f.s.all("SELECT * FROM gpu_allocations"),
    },
    before,
  );
  f.s.run("UPDATE gpu_allocations SET released=1 WHERE serverId='b'");
  assert.equal(f.infra.route(f.model.id)!.id, f.ids[0]);
  assert.ok(
    !reconcile(f.s).issues.some((i) => i.code === "duplicate_gpu_allocation"),
  );
});

test("managed routing chooses fewest pending requests, then deployment ID, while preserving eligibility", async (t) => {
  const f = await fixture(t),
    { s, infra, ids, pending } = f;
  assert.equal(infra.route(f.model.id)?.id, ids[0]);
  pending(ids[0]);
  assert.equal(infra.route(f.model.id)?.id, ids[1]);
  pending(ids[1]);
  assert.equal(infra.route(f.model.id)?.id, ids[0]);
  pending(ids[1], "failed");
  assert.equal(infra.route(f.model.id)?.id, ids[0]);
  s.run(
    "UPDATE servers SET data=json_set(data,'$.maintenance',1) WHERE id='a'",
  );
  assert.equal(infra.route(f.model.id)?.id, ids[0]);
  for (const update of [
    "data=json_set(data,'$.schedulingEnabled',0)",
    "lastHeartbeat=0",
    "inventoryError='inventory_failed'",
    "data=json_set(data,'$.workMode','gpu-rental')",
    "deleted=1",
  ]) {
    const before = s.get<{
      data: string;
      lastHeartbeat: number;
      inventoryError: string | null;
      deleted: number;
    }>("SELECT * FROM servers WHERE id='a'")!;
    s.run("UPDATE servers SET " + update + " WHERE id='a'");
    assert.equal(infra.route(f.model.id)?.id, ids[1]);
    s.run(
      "UPDATE servers SET data=?,lastHeartbeat=?,inventoryError=?,deleted=? WHERE id='a'",
      before.data,
      before.lastHeartbeat,
      before.inventoryError,
      before.deleted,
    );
  }
  for (const update of [
    "healthAt=0",
    "phase='draining'",
    "desiredState='stopped'",
  ]) {
    s.run("UPDATE deployments SET " + update + " WHERE id=?", ids[0]);
    assert.equal(infra.route(f.model.id)?.id, ids[1]);
    s.run(
      "UPDATE deployments SET healthAt=?,phase='ready',desiredState='running' WHERE id=?",
      Date.now(),
      ids[0],
    );
  }
  s.run("UPDATE deployments SET healthAt=0");
  assert.equal(infra.route(f.model.id), undefined);
  assert(
    s
      .all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT id FROM deployments WHERE modelId=? AND phase='ready' AND desiredState='running' AND healthAt>?",
        f.model.id,
        Date.now() - 45000,
      )
      .some((r) => r.detail.includes("deployments_ready_model")),
  );
  assert(
    s
      .all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM requests WHERE deploymentId=? AND status='pending'",
        ids[0],
      )
      .some((r) => r.detail.includes("requests_pending_deployment")),
  );
});

test("concurrent managed HTTP requests spread by actual reservations and keep targets, prices and replay stable", async (t) => {
  const f = await fixture(t),
    { peers, s, ids, chat } = f,
    key = randomUUID();
  const first = chat("first", key);
  await until(() => peers[0].calls.length === 1);
  const second = chat("second");
  await until(() => peers[1].calls.length === 1);
  const third = chat("third");
  await until(() => peers[0].calls.length === 2);
  const duplicate = await chat("first", key);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "request_pending");
  assert.equal(peers.flatMap((p) => p.calls).length, 3);
  peers[1].finish("second");
  assert.equal((await second).status, 200);
  const fourth = chat("fourth");
  await until(() => peers[1].calls.length === 2);
  s.run(
    "UPDATE models SET data=json_set(data,'$.inputPrice',2000000,'$.outputPrice',3000000) WHERE id=?",
    f.model.id,
  );
  f.infra.stop(ids[1]);
  f.infra.advanceStops();
  assert.equal(
    s.get<{ phase: string }>(
      "SELECT phase FROM deployments WHERE id=?",
      ids[1],
    )!.phase,
    "draining",
  );
  const fifth = chat("fifth");
  await until(() => peers[0].calls.length === 3);
  peers[1].finish("fourth");
  assert.equal((await fourth).body.billing.amount, 3);
  f.infra.advanceStops();
  assert.equal(
    s.get<{ phase: string }>(
      "SELECT phase FROM deployments WHERE id=?",
      ids[1],
    )!.phase,
    "stopping",
  );
  for (const text of ["first", "third", "fifth"]) peers[0].finish(text);
  const [a, c, e] = await Promise.all([first, third, fifth]);
  assert.equal(a.body.choices[0].message.content, "a:first");
  assert.equal(c.body.billing.amount, 3);
  assert.equal(e.body.billing.amount, 7);
  const replay = await chat("first", key);
  assert.deepEqual(replay.body, a.body);
  assert.equal(peers.flatMap((p) => p.calls).length, 5);
  assert.deepEqual(
    s
      .all<{ deploymentId: string; count: number }>(
        "SELECT deploymentId,COUNT(*) count FROM requests WHERE status='succeeded' GROUP BY deploymentId ORDER BY deploymentId",
      )
      .map((r) => [r.deploymentId, r.count]),
    [
      [ids[0], 3],
      [ids[1], 2],
    ],
  );
  assert.equal(s.user(f.user.id)!.balance, 981);
  assert.equal(s.held(f.user.id), 0);
  assert.equal(
    s.get<{ count: number }>(
      "SELECT COUNT(*) count FROM ledger WHERE type='token'",
    )!.count,
    5,
  );
});

test("consumer disconnect remains in flight until settlement; upstream failure never silently retries another replica", async (t) => {
  const f = await fixture(t),
    { chat, peers, s, ids } = f,
    ctrl = new AbortController();
  const disconnected = chat("disconnected", randomUUID(), ctrl.signal).catch(
    () => null,
  );
  await until(() => peers[0].calls.length === 1);
  ctrl.abort();
  await disconnected;
  assert.equal(
    s.get<{ count: number }>(
      "SELECT COUNT(*) count FROM requests WHERE deploymentId=? AND status='pending'",
      ids[0],
    )!.count,
    1,
  );
  const other = chat("other");
  await until(() => peers[1].calls.length === 1);
  peers[1].finish("other");
  await other;
  peers[0].finish("disconnected");
  await until(
    () =>
      s.get<{ count: number }>(
        "SELECT COUNT(*) count FROM requests WHERE status='pending'",
      )!.count === 0,
  );
  const failure = chat("failure");
  await until(() => peers[0].calls.length === 2);
  peers[0].finish("failure", false);
  assert.equal((await failure).status, 502);
  assert.equal(peers[1].calls.length, 1);
  assert.equal(s.user(f.user.id)!.balance, 994);
  assert.equal(s.held(f.user.id), 0);
  assert.equal(f.infra.route(f.model.id)?.id, ids[0]);
});
