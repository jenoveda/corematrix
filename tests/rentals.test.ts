import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createApplication } from "../server/app.ts";
import { Infrastructure } from "../server/infrastructure.ts";
import { secret, digest } from "../server/auth.ts";
import { createHmac } from "node:crypto";
import type { Server as HttpServer } from "node:http";
async function listen(server: HttpServer) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function close(server: HttpServer) {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Timed out");
}
test("GPU rental mode shares allocations, owns private Jupyter access, and requires confirmed cleanup", async (t) => {
  const key = "workspace-master-test-" + secret();
  process.env.INFERENCE_JUPYTER_KEY = key;
  let receivedAuth = "";
  const lab = createServer((req, res) => {
    receivedAuth = String(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ started: "2026-01-01T00:00:00Z" }));
  });
  const port = await listen(lab),
    app = createApplication({
      databasePath: ":memory:",
      publicOrigin: "http://control.tests.invalid",
    }),
    apiPort = await listen(app.server),
    s = app.store,
    infra = new Infrastructure(s);
  t.after(async () => {
    infra.disposed = true;
    await close(app.server);
    await close(lab);
    s.close();
    delete process.env.INFERENCE_JUPYTER_KEY;
  });
  const admin = s.createUser(
      "Admin",
      "admin@rental.invalid",
      "unused",
      "admin",
    ),
    owner = s.createUser("Owner", "owner@rental.invalid", "unused"),
    other = s.createUser("Other", "other@rental.invalid", "unused");
  const credentials = new Map<string, { cookie: string; csrf: string }>();
  for (const user of [admin, owner, other]) {
    const token = secret(),
      csrf = secret();
    s.run(
      "INSERT INTO sessions VALUES(?,?,?,?)",
      digest(token),
      user.id,
      csrf,
      Date.now() + 100000,
    );
    credentials.set(user.id, { cookie: "cm_session=" + token, csrf });
  }
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    user = admin.id,
    token?: string,
    idempotency?: string,
  ) {
    const auth = credentials.get(user)!;
    const r = await fetch(`http://127.0.0.1:${apiPort}` + path, {
      method,
      headers: {
        ...(token
          ? { Authorization: "Bearer " + token }
          : { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf }),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: (await r.json()) as any };
  }
  const config = {
    name: "Rental node",
    region: "Test",
    inferenceHost: "http://127.0.0.1",
    portStart: port,
    portEnd: port,
    workMode: "gpu-rental",
  };
  const created = await call("/api/admin/servers", "POST", config);
  assert.equal(created.status, 201);
  const node = created.data.server.id,
    agentToken = created.data.agentToken;
  let sequence = 0,
    containers: unknown[] = [];
  const heartbeat = () => ({
    instanceId: "go-agent",
    bootId: "boot",
    sequence: ++sequence,
    generation: sequence === 1 ? null : 1,
    capabilities: {
      agentVersion: "2-go",
      dockerReady: true,
      inferenceReady: true,
      workspaceReady: true,
      runtimeImageDigest: "sha256:" + "a".repeat(64),
      workspaceImageDigest: "sha256:" + "b".repeat(64),
      workspaceKeyEnv: "INFERENCE_JUPYTER_KEY",
    },
    inventoryError: null,
    gpus: [
      {
        uuid: "GPU-rent",
        index: 0,
        name: "GPU",
        totalMemoryMiB: 24000,
        usedMemoryMiB: 0,
        utilizationPercent: null,
        temperatureC: null,
        externalBusy: false,
      },
    ],
    containers,
  });
  assert.equal(
    (
      await call(
        "/api/agent/heartbeat",
        "POST",
        heartbeat(),
        admin.id,
        agentToken,
      )
    ).status,
    200,
  );
  const model = {
    ...s.model("qwen2.5-7b")!,
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
  s.run("UPDATE models SET data=? WHERE id=?", JSON.stringify(model), model.id);
  assert.equal(
    (
      await call(
        "/api/admin/deployments",
        "POST",
        { serverId: node, modelId: model.id, gpuUuids: ["GPU-rent"] },
        admin.id,
        undefined,
        "wrong-mode-001",
      )
    ).data.error.code,
    "node_mode_mismatch",
  );
  assert.equal(
    (
      await call(
        "/api/admin/rentals",
        "POST",
        { serverId: node, ownerEmail: owner.email, gpuUuids: ["GPU-rent"] },
        owner.id,
        undefined,
        "user-denied-001",
      )
    ).status,
    403,
  );
  const body = {
      serverId: node,
      ownerEmail: owner.email,
      gpuUuids: ["GPU-rent"],
    },
    rental = await call(
      "/api/admin/rentals",
      "POST",
      body,
      admin.id,
      undefined,
      "rental-create-001",
    );
  assert.equal(rental.status, 202);
  const id = rental.data.deployment.id;
  assert.equal(
    (
      await call(
        "/api/admin/rentals",
        "POST",
        body,
        admin.id,
        undefined,
        "rental-create-001",
      )
    ).data.deployment.id,
    id,
  );
  assert.equal(
    (
      await call(
        "/api/admin/rentals",
        "POST",
        body,
        admin.id,
        undefined,
        "rental-duplicate",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/api/admin/servers/" + node, "PUT", {
        ...config,
        workMode: "inference",
      })
    ).status,
    409,
  );
  const job = (
    await call(
      "/api/agent/jobs/claim",
      "POST",
      { instanceId: "go-agent", generation: 1 },
      admin.id,
      agentToken,
    )
  ).data.job;
  assert.equal(job.spec.workloadType, "gpu-rental");
  assert.equal(job.spec.imageDigest, "sha256:" + "b".repeat(64));
  assert.equal(JSON.stringify(job).includes(key), false);
  containers = [
    {
      deploymentId: id,
      containerId: "rental-container",
      state: "running",
      endpointPort: port,
    },
  ];
  await call("/api/agent/heartbeat", "POST", heartbeat(), admin.id, agentToken);
  const report = (job: any, event: string) => ({
    instanceId: "go-agent",
    generation: 1,
    attempt: job.attempt,
    leaseToken: job.leaseToken,
    eventId: crypto.randomUUID(),
    event,
    message: "",
  });
  assert.equal(
    (
      await call(
        "/api/agent/jobs/" + job.id + "/report",
        "POST",
        report(job, "healthy"),
        admin.id,
        agentToken,
      )
    ).status,
    200,
  );
  await until(() => infra.dep(id).phase === "ready");
  assert.equal(
    receivedAuth,
    "token " +
      createHmac("sha256", key)
        .update("corematrix-jupyter:" + id)
        .digest("hex"),
  );
  const access = await call(
    `/api/compute/rentals/${id}/access`,
    "POST",
    undefined,
    owner.id,
  );
  assert.equal(access.status, 200);
  assert.equal(
    new URL(access.data.url).pathname,
    `/api/compute/rentals/${id}/lab/lab`,
  );
  assert.ok(new URL(access.data.url).searchParams.get("token"));
  assert.equal(
    (
      await call(
        `/api/compute/rentals/${id}/access`,
        "POST",
        undefined,
        other.id,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/api/compute/rentals/${id}/access`,
        "POST",
        undefined,
        admin.id,
      )
    ).status,
    403,
  );
  const ownerState = (await call("/api/state", "GET", undefined, owner.id))
      .data,
    otherState = (await call("/api/state", "GET", undefined, other.id)).data;
  assert.equal(ownerState.rentals.length, 1);
  assert.equal(otherState.rentals.length, 0);
  assert.equal(ownerState.servers.length, 0);
  assert.equal(JSON.stringify(ownerState).includes("imageDigest"), false);
  assert.equal(s.user(owner.id)?.balance, 0);
  assert.equal(s.all("SELECT * FROM ledger").length, 0);
  assert.equal(
    (await call("/api/admin/deployments/" + id + "/stop", "POST")).status,
    202,
  );
  const stop = (
    await call(
      "/api/agent/jobs/claim",
      "POST",
      { instanceId: "go-agent", generation: 1 },
      admin.id,
      agentToken,
    )
  ).data.job;
  assert.equal(
    (
      await call(
        "/api/agent/jobs/" + stop.id + "/report",
        "POST",
        report(stop, "stopped"),
        admin.id,
        agentToken,
      )
    ).status,
    409,
  );
  assert.equal(infra.server(infra.node(node)).allocatedGpuCount, 1);
  containers = [];
  await call("/api/agent/heartbeat", "POST", heartbeat(), admin.id, agentToken);
  assert.equal(
    (
      await call(
        "/api/agent/jobs/" + stop.id + "/report",
        "POST",
        report(stop, "stopped"),
        admin.id,
        agentToken,
      )
    ).status,
    200,
  );
  assert.equal(infra.server(infra.node(node)).allocatedGpuCount, 0);
  assert.equal(
    (
      await call("/api/admin/servers/" + node, "PUT", {
        ...config,
        workMode: "inference",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/api/admin/deployments",
        "POST",
        { serverId: node, modelId: model.id, gpuUuids: ["GPU-rent"] },
        admin.id,
        undefined,
        "after-switch-001",
      )
    ).status,
    202,
  );
});
