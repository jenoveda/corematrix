import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { createApplication } from "../server/app.ts";
import { digest, secret } from "../server/auth.ts";
import type { Deployment, Server, State } from "../src/domain.ts";
import { Infrastructure } from "../server/infrastructure.ts";
async function listen(s: HttpServer) {
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return (s.address() as { port: number }).port;
}
async function close(s: HttpServer) {
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("Timed out waiting for condition");
}
test("real HTTP managed deployment, fencing, allocation, draining and language preferences", async (t) => {
  const app = createApplication({ databasePath: ":memory:" }),
    infra = new Infrastructure(app.store);
  let healthModel = "wrong-model";
  const upstream = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/v1/models"
          ? { data: [{ id: healthModel }] }
          : {
              choices: [{ message: { content: "ok" } }],
              usage: { prompt_tokens: 2, completion_tokens: 1 },
            },
      ),
    );
  });
  const port = await listen(upstream),
    apiPort = await listen(app.server),
    origin = `http://127.0.0.1:${apiPort}`,
    s = app.store;
  t.after(async () => {
    infra.disposed = true;
    await close(app.server);
    await close(upstream);
    s.close();
  });
  const admin = s.createUser("Admin", "admin@infra.invalid", "unused", "admin"),
    user = s.createUser("User", "user@infra.invalid", "unused");
  const session = secret(),
    csrf = secret();
  s.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    digest(session),
    admin.id,
    csrf,
    Date.now() + 100000,
  );
  s.run("UPDATE users SET balance=1000000 WHERE id=?", admin.id);
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
    key?: string,
  ) {
    const res = await fetch(origin + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token
          ? { Authorization: "Bearer " + token }
          : { Cookie: "cm_session=" + session, "X-CSRF-Token": csrf }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: (await res.json()) as any };
  }
  await t.test(
    "preferences persist, enforce CSRF and whitelist without touching balances",
    async () => {
      for (const locale of ["zh-CN", "en-US", "ja-JP", "ko-KR"]) {
        assert.equal(
          (await call("/api/account/preferences", "PUT", { locale })).status,
          200,
        );
        assert.equal((await call("/api/state")).data.user.locale, locale);
      }
      assert.equal(
        (await call("/api/account/preferences", "PUT", { locale: "fr-FR" }))
          .status,
        400,
      );
      assert.equal(s.user(admin.id)?.balance, 1000000);
      assert.equal(s.user(user.id)?.locale, "zh-CN");
    },
  );
  const registration = await call("/api/admin/servers", "POST", {
    name: "GPU node",
    region: "Test",
    inferenceHost: "http://127.0.0.1",
    portStart: port,
    portEnd: port,
  });
  assert.equal(registration.status, 201);
  const node = registration.data.server as Server,
    token = registration.data.agentToken as string,
    instanceId = crypto.randomUUID();
  let sequence = 0,
    generation: number | null = null,
    containers: unknown[] = [];
  const heartbeat = () => ({
    instanceId,
    bootId: "boot",
    sequence: ++sequence,
    generation,
    capabilities: {
      dockerReady: true,
      runtimeImageDigest: "sha256:" + "a".repeat(64),
    },
    inventoryError: null,
    gpus: ["GPU-a", "GPU-b"].map((uuid, index) => ({
      uuid,
      index,
      name: "Test GPU",
      totalMemoryMiB: 24000,
      usedMemoryMiB: 0,
      utilizationPercent: null,
      temperatureC: null,
      externalBusy: false,
    })),
    containers,
  });
  async function beat() {
    const r = await call("/api/agent/heartbeat", "POST", heartbeat(), token);
    assert.equal(r.status, 200);
    generation = r.data.generation;
    return r;
  }
  const identity = () => ({ instanceId, generation });
  const model = {
    ...s.model("qwen2.5-7b"),
    id: "managed",
    upstreamModel: "managed",
    enabled: true,
    routingMode: "managed",
    contextTokens: 100,
    maxOutputTokens: 100,
    runtime: {
      artifact: "Example/model",
      revision: "abc123",
      dtype: "auto",
      maxModelLen: 200,
      minGpuMemoryMiB: 20000,
      tensorParallelSize: 1,
    },
  };
  assert.equal((await call("/api/admin/models", "POST", model)).status, 201);
  let first: Deployment, job: any;
  await t.test(
    "agent auth, heartbeat sequence, one-time token and atomic reservations",
    async () => {
      assert.equal(
        JSON.stringify((await call("/api/admin/servers")).data).includes(token),
        false,
      );
      assert.equal(
        JSON.stringify(s.all("SELECT * FROM servers")).includes(token),
        false,
      );
      assert.equal(
        (await call("/api/agent/heartbeat", "POST", heartbeat())).status,
        401,
      );
      await beat();
      const list = (await call("/api/admin/servers")).data.data;
      assert.equal(list[0].freeGpuCount, 2);
      const stale = heartbeat();
      await beat();
      assert.equal(
        (await call("/api/agent/heartbeat", "POST", stale, token)).status,
        409,
      );
      const takeover = {
        ...heartbeat(),
        instanceId: crypto.randomUUID(),
        generation: null,
      };
      assert.equal(
        (await call("/api/agent/heartbeat", "POST", takeover, token)).status,
        409,
      );
      const body = {
        serverId: node.id,
        modelId: "managed",
        gpuUuids: ["GPU-a"],
      };
      const results = await Promise.all([
        call(
          "/api/admin/deployments",
          "POST",
          body,
          undefined,
          "deploy-first-0001",
        ),
        call(
          "/api/admin/deployments",
          "POST",
          body,
          undefined,
          "deploy-second-0001",
        ),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
      first = results.find((r) => r.status === 202)!.data.deployment;
      const key =
        results[0].status === 202 ? "deploy-first-0001" : "deploy-second-0001";
      assert.equal(
        (await call("/api/admin/deployments", "POST", body, undefined, key))
          .data.deployment.id,
        first.id,
      );
      assert.equal(
        (
          await call(
            "/api/admin/deployments",
            "POST",
            { ...body, gpuUuids: ["GPU-b"] },
            undefined,
            key,
          )
        ).status,
        409,
      );
      assert.equal(
        (await call("/api/admin/models/managed", "DELETE")).status,
        409,
      );
      assert.equal(
        (await call("/api/admin/servers/" + node.id, "DELETE")).status,
        409,
      );
      assert.equal(
        (
          await call(
            "/v1/chat/completions",
            "POST",
            {
              model: "managed",
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 1,
            },
            undefined,
            "no-ready-0001",
          )
        ).status,
        503,
      );
    },
  );
  await t.test(
    "leases reject stale attempts and healthy report needs control-plane probe",
    async (sub) => {
      const claimed = await call(
        "/api/agent/jobs/claim",
        "POST",
        identity(),
        token,
      );
      job = claimed.data.job;
      assert.equal(job.kind, "start");
      await sub.test(
        "another valid node token cannot claim, renew or report the owner's job",
        async () => {
          const other = await call("/api/admin/servers", "POST", {
            name: "Other authorized node",
            region: "Test",
            inferenceHost: "http://127.0.0.1",
            portStart: port,
            portEnd: port,
          });
          assert.equal(other.status, 201);
          const otherToken = other.data.agentToken;
          // Match identity fields so that the deployment's node ownership is the decisive fence.
          const otherBeat = await call(
            "/api/agent/heartbeat",
            "POST",
            {
              ...heartbeat(),
              sequence: 1,
              generation: null,
              gpus: [
                {
                  uuid: "GPU-other",
                  index: 0,
                  name: "Other GPU",
                  totalMemoryMiB: 24000,
                  usedMemoryMiB: 0,
                  externalBusy: false,
                },
              ],
              containers: [],
            },
            otherToken,
          );
          assert.equal(otherBeat.status, 200);
          const before = {
            jobs: s.all("SELECT * FROM deployment_jobs"),
            deployments: s.all("SELECT * FROM deployments"),
            events: s.all("SELECT * FROM deployment_events"),
            allocations: s.all("SELECT * FROM gpu_allocations"),
          };
          const ownClaim = await call(
            "/api/agent/jobs/claim",
            "POST",
            identity(),
            otherToken,
          );
          assert.equal(ownClaim.status, 200);
          assert.deepEqual(ownClaim.data, { job: null });
          for (const action of ["renew", "report"]) {
            const rejected = await call(
              `/api/agent/jobs/${job.id}/${action}`,
              "POST",
              {
                ...identity(),
                attempt: job.attempt,
                leaseToken: job.leaseToken,
                event: "healthy",
                eventId: crypto.randomUUID(),
                message: "",
              },
              otherToken,
            );
            assert.equal(rejected.status, 403);
            assert.equal(rejected.data.error.code, "forbidden");
            assert.equal(
              JSON.stringify(rejected.data).includes(job.leaseToken),
              false,
            );
            assert.equal(JSON.stringify(rejected.data).includes("spec"), false);
          }
          assert.deepEqual(
            {
              jobs: s.all("SELECT * FROM deployment_jobs"),
              deployments: s.all("SELECT * FROM deployments"),
              events: s.all("SELECT * FROM deployment_events"),
              allocations: s.all("SELECT * FROM gpu_allocations"),
            },
            before,
          );
          assert.equal(
            (await call("/api/admin/servers/" + other.data.server.id, "DELETE"))
              .status,
            200,
          );
        },
      );
      const old = { ...job };
      s.run(
        "UPDATE deployment_jobs SET leaseExpires=? WHERE id=?",
        Date.now() - 1,
        job.id,
      );
      job = (await call("/api/agent/jobs/claim", "POST", identity(), token))
        .data.job;
      assert.equal(job.attempt, 2);
      const payload = (
        j: any,
        event: string,
        eventId = crypto.randomUUID(),
      ) => ({
        ...identity(),
        attempt: j.attempt,
        leaseToken: j.leaseToken,
        eventId,
        event,
        message: "",
      });
      assert.equal(
        (
          await call(
            "/api/agent/jobs/" + job.id + "/report",
            "POST",
            payload(old, "healthy"),
            token,
          )
        ).status,
        409,
      );
      containers = [
        {
          deploymentId: first.id,
          containerId: "container-a",
          state: "running",
          endpointPort: port,
        },
      ];
      await beat();
      const report = payload(job, "healthy");
      assert.equal(
        (
          await call(
            "/api/agent/jobs/" + job.id + "/report",
            "POST",
            report,
            token,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            "/api/agent/jobs/" + job.id + "/report",
            "POST",
            report,
            token,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            "/api/agent/jobs/" + job.id + "/report",
            "POST",
            { ...report, message: "different" },
            token,
          )
        ).status,
        409,
      );
      await until(
        () => infra.dep(first.id).lastError === "health_probe_failed",
      );
      assert.equal(infra.route("managed"), undefined);
      healthModel = "managed";
      await infra.probe(first.id, generation!);
      await until(() => infra.dep(first.id).phase === "ready");
      assert.equal(
        (await call("/api/state")).data.models.find(
          (m: any) => m.id === "managed",
        ).configured,
        true,
      );
      const result = await call(
        "/v1/chat/completions",
        "POST",
        {
          model: "managed",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        },
        undefined,
        "managed-bill-0001",
      );
      assert.equal(result.status, 200);
      assert.equal(
        s.get<{ deploymentId: string }>(
          "SELECT deploymentId FROM requests WHERE requestKey=?",
          "managed-bill-0001",
        )?.deploymentId,
        first.id,
      );
    },
  );
  await t.test(
    "stop drains requests and requires fresh absent-container inventory before release",
    async () => {
      s.run(
        "INSERT INTO requests(id,userId,requestKey,fingerprint,day,status,reserved,modelId,modelName,inputPrice,outputPrice,createdAt,deploymentId) VALUES('drain',?,'drain-request','x','2026-10-15','pending',0,'managed','Managed',1,1,'now',?)",
        admin.id,
        first.id,
      );
      assert.equal(
        (await call("/api/admin/deployments/" + first.id + "/stop", "POST"))
          .status,
        202,
      );
      assert.equal(infra.dep(first.id).phase, "draining");
      assert.equal(
        (await call("/api/agent/jobs/claim", "POST", identity(), token)).data
          .job,
        null,
      );
      s.run("UPDATE requests SET status='failed' WHERE id='drain'");
      infra.advanceStops();
      const stop = (
        await call("/api/agent/jobs/claim", "POST", identity(), token)
      ).data.job;
      assert.equal(stop.kind, "stop");
      const report = {
        ...identity(),
        attempt: stop.attempt,
        leaseToken: stop.leaseToken,
        eventId: crypto.randomUUID(),
        event: "stopped",
        message: "",
      };
      assert.equal(
        (
          await call(
            "/api/agent/jobs/" + stop.id + "/report",
            "POST",
            report,
            token,
          )
        ).status,
        409,
      );
      assert.equal(infra.server(infra.node(node.id)).allocatedGpuCount, 1);
      containers = [];
      await beat();
      assert.equal(
        (
          await call(
            "/api/agent/jobs/" + stop.id + "/report",
            "POST",
            report,
            token,
          )
        ).status,
        200,
      );
      assert.equal(infra.dep(first.id).phase, "stopped");
      assert.equal(infra.server(infra.node(node.id)).allocatedGpuCount, 0);
    },
  );
  await t.test(
    "offline and rotation preserve allocations; inventory errors preserve last GPU data",
    async () => {
      const create = await call(
        "/api/admin/deployments",
        "POST",
        { serverId: node.id, modelId: "managed", gpuUuids: ["GPU-b"] },
        undefined,
        "offline-deploy-01",
      );
      assert.equal(create.status, 202);
      const faulty = {
        ...heartbeat(),
        inventoryError: "nvidia_smi_failed",
        gpus: [],
      };
      assert.equal(
        (await call("/api/agent/heartbeat", "POST", faulty, token)).status,
        200,
      );
      assert.equal(infra.server(infra.node(node.id)).gpus.length, 2);
      assert.equal(infra.server(infra.node(node.id)).freeGpuCount, 0);
      s.run(
        "UPDATE servers SET lastHeartbeat=? WHERE id=?",
        Date.now() - 46000,
        node.id,
      );
      assert.equal(infra.server(infra.node(node.id)).status, "offline");
      assert.equal(infra.server(infra.node(node.id)).allocatedGpuCount, 1);
      const rotation = await call(
        "/api/admin/servers/" + node.id + "/token",
        "POST",
      );
      assert.equal(rotation.status, 200);
      assert.equal(
        (await call("/api/agent/heartbeat", "POST", heartbeat(), token)).status,
        401,
      );
      assert.equal(infra.server(infra.node(node.id)).allocatedGpuCount, 1);
    },
  );
});

test("rolling replacement keeps the old replica on failure, then drains it after success", async (t) => {
  const { Store } = await import("../server/store.ts"),
    s = new Store(":memory:"),
    infra = new Infrastructure(s),
    admin = s.createUser("A", "a@rolling.invalid", "unused", "admin");
  const upstream = createServer((_q, r) => {
    r.setHeader("content-type", "application/json");
    r.end(
      JSON.stringify({
        data: [{ id: "rolling" }],
        choices: [{ message: { content: "ok" } }],
      }),
    );
  });
  const port = await listen(upstream);
  t.after(async () => {
    infra.disposed = true;
    await close(upstream);
    s.close();
  });
  const template = {
    ...s.model("qwen2.5-7b")!,
    id: "rolling",
    gpus: 1,
    enabled: true,
    routingMode: "managed",
    runtime: {
      artifact: "Example/model",
      revision: "abc",
      dtype: "auto",
      maxModelLen: 40000,
      minGpuMemoryMiB: 20000,
      tensorParallelSize: 1,
    },
  };
  s.run(
    "INSERT INTO models(id,data) VALUES(?,?)",
    template.id,
    JSON.stringify(template),
  );
  const nodes = ["a", "b"].map((id) => {
    s.run(
      "INSERT INTO servers(id,data,tokenHash) VALUES(?,?,?)",
      id,
      JSON.stringify({
        name: id,
        region: "r",
        inferenceHost: "http://127.0.0.1",
        portStart: port,
        portEnd: port,
        schedulingEnabled: true,
        maintenance: false,
      }),
      id,
    );
    return id;
  });
  let seq = 0;
  const beat = (id: string, containers: unknown[] = []) =>
    infra.heartbeat(infra.node(id), {
      instanceId: id,
      bootId: "boot",
      sequence: ++seq,
      generation: infra.node(id).instanceId ? infra.node(id).generation : null,
      capabilities: {
        dockerReady: true,
        runtimeImageDigest: "sha256:" + "a".repeat(64),
      },
      inventoryError: null,
      gpus: [
        {
          uuid: "GPU-" + id,
          index: 0,
          name: "test",
          totalMemoryMiB: 24000,
          usedMemoryMiB: 0,
          utilizationPercent: 0,
          temperatureC: 0,
          externalBusy: false,
        },
      ],
      containers,
    });
  nodes.forEach((n) => beat(n));
  const identity = (id: string) => ({
    instanceId: id,
    generation: infra.node(id).generation,
  });
  function report(id: string, job: any, event: string) {
    return infra.report(
      infra.node(id),
      s.get<any>("SELECT * FROM deployment_jobs WHERE id=?", job.id),
      {
        ...identity(id),
        attempt: job.attempt,
        leaseToken: job.leaseToken,
        eventId: crypto.randomUUID(),
        event,
        message: event === "failed" ? "startup_failed" : "",
      },
    );
  }
  const old = infra.create(
    { serverId: "a", modelId: "rolling", gpuUuids: ["GPU-a"] },
    admin.id,
    "old-00001",
  );
  let job = infra.claim(infra.node("a"), identity("a")).job!;
  beat("a", [
    {
      deploymentId: old.id,
      containerId: "old",
      state: "running",
      endpointPort: port,
    },
  ]);
  report("a", job, "healthy");
  await until(() => infra.dep(old.id).phase === "ready");
  const failed = infra.create(
    {
      serverId: "b",
      modelId: "rolling",
      gpuUuids: ["GPU-b"],
      replaces: old.id,
    },
    admin.id,
    "failed-00001",
  );
  job = infra.claim(infra.node("b"), identity("b")).job!;
  report("b", job, "failed");
  assert.equal(infra.dep(old.id).phase, "ready");
  assert.equal(infra.server(infra.node("b")).allocatedGpuCount, 1);
  job = infra.claim(infra.node("b"), identity("b")).job!;
  beat("b");
  report("b", job, "stopped");
  assert.equal(infra.dep(failed.id).phase, "stopped");
  const next = infra.create(
    {
      serverId: "b",
      modelId: "rolling",
      gpuUuids: ["GPU-b"],
      replaces: old.id,
    },
    admin.id,
    "next-00001",
  );
  job = infra.claim(infra.node("b"), identity("b")).job!;
  beat("b", [
    {
      deploymentId: next.id,
      containerId: "new",
      state: "running",
      endpointPort: port,
    },
  ]);
  report("b", job, "healthy");
  await until(() => infra.dep(next.id).phase === "ready");
  assert.equal(infra.dep(old.id).phase, "draining");
  assert.equal(infra.route("rolling")?.id, next.id);
  assert.equal(infra.server(infra.node("a")).allocatedGpuCount, 1);
  infra.advanceStops();
  job = infra.claim(infra.node("a"), identity("a")).job!;
  assert.equal(job.kind, "stop");
  beat("a");
  report("a", job, "stopped");
  assert.equal(infra.server(infra.node("a")).allocatedGpuCount, 0);
  // A late successful probe cannot revive a deployment already requested to stop.
  infra.stop(next.id);
  await infra.probe(next.id, infra.node("b").generation);
  assert.notEqual(infra.dep(next.id).phase, "ready");
  assert.equal(infra.route("rolling"), undefined);
});
