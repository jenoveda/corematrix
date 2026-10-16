import { RentalBilling } from "./rental-billing.ts";
import { randomUUID, createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server, Deployment, Gpu, Model } from "../src/domain.ts";
import type { Store } from "./store.ts";
import { digest, secret } from "./auth.ts";
import { check, int, text, object, requestKey } from "./validation.ts";
import { providerAllowed, startProcurement, stopProcurement } from "./providers.ts";
import { nodeCredentials, runtimeCredential, NODE_INFERENCE_KEY, NODE_WORKSPACE_KEY } from "./node-credentials.ts";

type NodeRow = {
  id: string;
  data: string;
  tokenHash: string;
  credentialSeed: string|null;
  instanceId: string | null;
  bootId: string | null;
  generation: number;
  sequence: number;
  lastHeartbeat: number | null;
  inventoryError: string | null;
  capabilities: string;
  containers: string;
};
type DepRow = Omit<
  Deployment,
  "spec" | "allocated" | "createdAt" | "healthAt"
> & { spec: string; createdAt: number; healthAt: number | null };
type Job = {
  id: string;
  deploymentId: string;
  kind: "start" | "stop";
  status: string;
  attempt: number;
  generation: number;
  leaseHash: string;
  leaseExpires: number;
  claimedAt: number;
  createdAt: number;
};
type Helpers = {
  admin: (req: IncomingMessage) => { user: { id: string } };
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  send: (res: ServerResponse, status: number, data: unknown) => void;
};
async function healthJson(response: Response) {
  check(response.ok && response.body, "Health failed");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      check(size <= 65536, "Health response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const ONLINE = 45_000,
  LEASE = 60_000;
const iso = (n: number | null) => (n ? new Date(n).toISOString() : null);
export class Infrastructure {
  disposed = false;
  store: Store;
  billing: RentalBilling;
  probing = new Set<string>();
  constructor(store: Store) {
    this.store = store;
    this.billing = new RentalBilling(store);
  }
  node(id: string) {
    const n = this.store.get<NodeRow>(
      "SELECT * FROM servers WHERE id=? AND deleted=0",
      id,
    );
    check(n, "Node not found", 404, "not_found");
    return n;
  }
  dep(id: string) {
    const d = this.store.get<DepRow>(
      "SELECT * FROM deployments WHERE id=?",
      id,
    );
    check(d, "Deployment not found", 404, "not_found");
    return d;
  }
  online(n: NodeRow) {
    return !!n.lastHeartbeat && n.lastHeartbeat > Date.now() - ONLINE;
  }
  servers() {
    return this.store
      .all<NodeRow>("SELECT * FROM servers WHERE deleted=0 ORDER BY rowid DESC")
      .map((n) => this.server(n));
  }
  server(n: NodeRow): Server {
    const data = JSON.parse(n.data),
      caps = JSON.parse(n.capabilities),
      online = this.online(n),
      identityConflict = this.billing.reservations.gpuIdentityConflict(n.id);
    const requestedSchedulingEnabled = data.schedulingEnabled;
    data.schedulingEnabled = data.schedulingEnabled && providerAllowed(this.store,n.id);
    const gpus = this.store
      .all<{ data: string; missing: number; allocated: number }>(
        "SELECT g.data,g.missing,EXISTS(SELECT 1 FROM gpu_allocations a WHERE a.serverId=g.serverId AND a.uuid=g.uuid AND a.released=0) allocated FROM gpus g WHERE serverId=? ORDER BY rowid",
        n.id,
      )
      .map((g) => ({
        lastSeenAt: null,
        ...JSON.parse(g.data),
        missing: !!g.missing,
        allocated: !!g.allocated,
      })) as Gpu[];
    return {
      ...data,
      requestedSchedulingEnabled,
      workMode: data.workMode ?? "inference",
      rentalSalesEnabled: data.rentalSalesEnabled ?? false,
      hourlyPrice: data.hourlyPrice ?? 0,
      id: n.id,
      status: !data.schedulingEnabled
        ? "disabled"
        : online
          ? "online"
          : n.lastHeartbeat
            ? "offline"
            : "pending",
      lastHeartbeatAt: iso(n.lastHeartbeat),
      inventoryError:
        n.inventoryError ||
        (identityConflict ? "duplicate_gpu_identity" : null) ||
        ((data.workMode ?? "inference") === "inference"
          ? caps.inferenceError
          : caps.workspaceError) ||
        null,
      capabilities: {
        dockerReady: caps.dockerReady,
        runtimeImageDigest: caps.runtimeImageDigest,
        workspaceImageDigest: caps.workspaceImageDigest,
        inferenceReady: caps.inferenceReady ?? caps.dockerReady,
        workspaceReady: caps.workspaceReady,
        expirySupported: caps.expirySupported,
        renewalSupported: caps.renewalSupported,
        nodeScopedKeys: caps.nodeScopedKeys,
      },
      gpus,
      allocatedGpuCount: gpus.filter((g) => g.allocated).length,
      freeGpuCount:
        online &&
        data.schedulingEnabled &&
        !data.maintenance &&
        !n.inventoryError &&
        !identityConflict &&
        ((data.workMode ?? "inference") === "gpu-rental"
          ? caps.workspaceReady
          : (caps.inferenceReady ?? caps.dockerReady))
          ? gpus.filter((g) => !g.allocated && !g.missing && !g.externalBusy)
              .length
          : 0,
    };
  }
  deployments(serverId?: string) {
    return this.store
      .all<DepRow>(
        `SELECT * FROM deployments ${serverId ? "WHERE serverId=?" : ""} ORDER BY createdAt DESC`,
        ...(serverId ? [serverId] : []),
      )
      .map((d) => this.project(d));
  }
  project(d: DepRow): Deployment {
    const n = this.store.get<NodeRow>(
        "SELECT * FROM servers WHERE id=?",
        d.serverId,
      )!,
      {
        actorId: _a,
        requestKey: _k,
        fingerprint: _f,
        ...pub
      } = d as DepRow & {
        actorId: string;
        requestKey: string;
        fingerprint: string;
      };
    return {
      ...pub,
      spec: JSON.parse(d.spec),
      createdAt: new Date(d.createdAt).toISOString(),
      healthAt: iso(d.healthAt),
      phase:
        d.phase !== "stopped" &&
        (!this.online(n) ||
          (d.phase === "ready" &&
            (!d.healthAt || d.healthAt < Date.now() - ONLINE)))
          ? "unknown"
          : d.phase,
      allocated: !!this.store.get(
        "SELECT 1 FROM port_allocations WHERE deploymentId=? AND released=0",
        d.id,
      ),
    };
  }
  event(d: string, event: string, message = "") {
    this.store.run(
      "INSERT INTO deployment_events(deploymentId,event,message,time) VALUES(?,?,?,?)",
      d,
      event,
      message,
      Date.now(),
    );
  }
  job(d: string, kind: "start" | "stop") {
    this.store.run(
      "INSERT INTO deployment_jobs(id,deploymentId,kind,createdAt) VALUES(?,?,?,?)",
      randomUUID(),
      d,
      kind,
      Date.now(),
    );
  }
  route(modelId: string) {
    return this.store
      .all<DepRow>(
        "SELECT d.* FROM deployments d JOIN servers n ON n.id=d.serverId AND n.deleted=0 WHERE d.modelId=? AND d.phase='ready' AND d.desiredState='running' AND d.healthAt>? ORDER BY (SELECT COUNT(*) FROM requests r WHERE r.deploymentId=d.id AND r.status='pending'),d.id",
        modelId,
        Date.now() - ONLINE,
      )
      .find((d) => {
        const n = this.node(d.serverId);
        return (
          this.online(n) &&
          JSON.parse(n.data).schedulingEnabled &&
          providerAllowed(this.store,n.id) &&
          (JSON.parse(n.data).workMode ?? "inference") === "inference" &&
          !n.inventoryError &&
          !this.billing.reservations.gpuIdentityConflict(n.id)
        );
      });
  }
  endpoint(d: DepRow) {
    const n = this.node(d.serverId),
      url = new URL(JSON.parse(n.data).inferenceHost);
    url.port = String(JSON.parse(d.spec).endpointPort);
    return url.origin;
  }
  validateNode(data: Record<string, unknown>) {
    const host = text(data.inferenceHost, "inferenceHost", 200);
    let url: URL;
    try {
      url = new URL(host);
    } catch {
      check(false, "Invalid host", 400, "invalid_server_host", {
        field: "inferenceHost",
      });
    }
    const ip = url!.hostname.replace(/^\[|\]$/g, "");
    check(
      ["http:", "https:"].includes(url!.protocol) &&
        isIP(ip) &&
        !url!.port &&
        !url!.username &&
        !url!.password &&
        url!.pathname === "/" &&
        !url!.search &&
        !url!.hash &&
        !ip.includes("169.254.") &&
        !/^fe[89ab][0-9a-f]:/i.test(ip) &&
        ip !== "0.0.0.0" &&
        ip !== "::",
      "Use a controlled IP address without port or path",
      400,
      "invalid_server_host",
      { field: "inferenceHost" },
    );
    const portStart = int(data.portStart, "portStart", 1024, 65535),
      portEnd = int(
        data.portEnd,
        "portEnd",
        portStart,
        Math.min(65535, portStart + 31),
      );
    check(
      data.schedulingEnabled === undefined ||
        typeof data.schedulingEnabled === "boolean",
      "Invalid scheduling flag",
      400,
      "invalid_boolean",
      { field: "schedulingEnabled" },
    );
    check(
      data.maintenance === undefined || typeof data.maintenance === "boolean",
      "Invalid maintenance flag",
      400,
      "invalid_boolean",
      { field: "maintenance" },
    );
    const workMode = data.workMode ?? "inference";
    check(
      ["inference", "gpu-rental"].includes(String(workMode)),
      "Invalid work mode",
      400,
      "invalid_option",
      { field: "workMode" },
    );
    const rentalSalesEnabled = data.rentalSalesEnabled ?? false;
    check(
      typeof rentalSalesEnabled === "boolean",
      "Invalid sales flag",
      400,
      "invalid_boolean",
      { field: "rentalSalesEnabled" },
    );
    const hourlyPrice = int(
      data.hourlyPrice ?? 0,
      "hourlyPrice",
      0,
      10_000_000_000,
    );
    check(
      !rentalSalesEnabled || (workMode === "gpu-rental" && hourlyPrice > 0),
      "Invalid rental pricing",
      400,
      "invalid_rental_pricing",
      { field: "hourlyPrice" },
    );
    return {
      rentalSalesEnabled,
      hourlyPrice,
      workMode,
      name: text(data.name, "name", 80),
      region: text(data.region, "region", 80),
      inferenceHost: url!.origin,
      portStart,
      portEnd,
      schedulingEnabled: data.schedulingEnabled ?? true,
      maintenance: data.maintenance ?? false,
    };
  }
  busy(id: string) {
    return (
      this.billing.reservations.busy(id) ||
      !!this.store.get(
        "SELECT 1 FROM deployments WHERE serverId=? AND phase!='stopped'",
        id,
      )
    );
  }
  stop(id: string, retry = false) {
    this.store.transaction(() => this.stopReserved(id, retry));
    this.advanceStops();
  }
  stopReserved(id: string, retry = false) {
    const d = this.dep(id);
    if (d.phase === "stopped" || (d.desiredState === "stopped" && !retry))
      return;
    this.billing.stopRequested(id);
    this.store.run(
      "UPDATE deployments SET desiredState='stopped',phase='draining',healthAt=NULL WHERE id=?",
      id,
    );
    this.store.run(
      "UPDATE deployment_jobs SET status='cancelled' WHERE deploymentId=? AND kind='start' AND status IN ('queued','leased')",
      id,
    );
    if (retry)
      this.store.run(
        "UPDATE deployment_jobs SET status='cancelled' WHERE deploymentId=? AND kind='stop' AND status IN ('queued','leased')",
        id,
      );
    this.event(id, "draining");
  }
  advanceStops() {
    for (const d of this.store.all<DepRow>(
      "SELECT * FROM deployments WHERE desiredState='stopped' AND phase IN ('draining','stopping')",
    )) {
      if (
        this.store.get(
          "SELECT 1 FROM requests WHERE deploymentId=? AND status='pending'",
          d.id,
        )
      )
        continue;
      if (
        !this.store.get(
          "SELECT 1 FROM deployment_jobs WHERE deploymentId=? AND kind='stop' AND status IN ('queued','leased')",
          d.id,
        )
      ) {
        this.job(d.id, "stop");
        this.store.run(
          "UPDATE deployments SET phase='stopping' WHERE id=?",
          d.id,
        );
      }
    }
  }
  create(data: Record<string, unknown>, actorId: string, key: string) {
    return this.store.transaction(() =>
      this.createReserved(data, actorId, key),
    );
  }
  createReserved(
    data: Record<string, unknown>,
    actorId: string,
    key: string,
    planned?: { endAt: number; reservationId?: string; port?: number },
  ) {
    const fingerprint = digest(
        JSON.stringify({
          serverId: data.serverId,
          modelId: data.modelId,
          gpuUuids: data.gpuUuids,
          replaces: data.replaces ?? null,
          workloadType: data.workloadType ?? "inference",
          ownerEmail: data.ownerEmail ?? null,
          ...(planned ? { planned } : {}),
        }),
      ),
      previous = this.store.get<DepRow & { fingerprint: string }>(
        "SELECT * FROM deployments WHERE actorId=? AND requestKey=?",
        actorId,
        key,
      );
    if (previous) {
      check(
        previous.fingerprint === fingerprint,
        "Idempotency conflict",
        409,
        "idempotency_conflict",
      );
      return this.project(previous);
    }
    const rental = data.workloadType === "gpu-rental";
    const owner = rental
      ? this.store.get<{ id: string }>(
          "SELECT id FROM users WHERE email=?",
          text(data.ownerEmail, "ownerEmail", 254).toLowerCase(),
        )
      : undefined;
    check(!rental || owner, "User not found", 404, "not_found");
    const model: Model | undefined = rental
      ? {
          id: "__gpu-rental__",
          name: "GPU rental",
          tag: "",
          description: "",
          inputPrice: 0,
          outputPrice: 0,
          gpus: Array.isArray(data.gpuUuids) ? data.gpuUuids.length : 0,
          vram: 1,
          enabled: false,
          configured: false,
          contextTokens: 0,
          maxOutputTokens: 0,
          routingMode: "managed",
          runtime: {
            artifact: "",
            revision: "",
            dtype: "auto",
            maxModelLen: 0,
            minGpuMemoryMiB: 0,
            tensorParallelSize: 0,
          },
        }
      : this.store.model(text(data.modelId, "modelId", 100));
    check(
      model?.routingMode === "managed" && model.runtime,
      "Missing runtime",
      400,
      "model_runtime_missing",
    );
    const n = this.node(text(data.serverId, "serverId", 100)),
      node = this.server(n),
      caps = JSON.parse(n.capabilities);
    check(
      node.workMode === (rental ? "gpu-rental" : "inference"),
      "Node mode mismatch",
      409,
      "node_mode_mismatch",
    );
    check(
      !rental || caps.workspaceReady,
      "Workspace runtime unavailable",
      409,
      "workspace_not_ready",
    );
    check(
      rental || (caps.inferenceReady ?? caps.dockerReady),
      "Inference runtime unavailable",
      409,
      "model_runtime_missing",
    );
    const imageDigest = rental
      ? caps.workspaceImageDigest
      : caps.runtimeImageDigest;
    const apiKeyEnv = caps.nodeScopedKeys===true ? (rental?NODE_WORKSPACE_KEY:NODE_INFERENCE_KEY) : rental
      ? text(caps.workspaceKeyEnv, "workspace key name", 80)
      : model.apiKeyEnv || "";
    check(
      !rental ||
        (/^INFERENCE_[A-Z0-9_]+$/.test(apiKeyEnv) &&
          !!runtimeCredential(this.store,n.id,apiKeyEnv) &&
          runtimeCredential(this.store,n.id,apiKeyEnv)!.length >= 32),
      "Workspace key missing",
      400,
      "model_runtime_missing",
    );
    check(
      this.online(n) &&
        !n.inventoryError &&
        !this.billing.reservations.gpuIdentityConflict(n.id) &&
        caps.dockerReady,
      "Node offline",
      409,
      "server_offline",
    );
    check(
      node.schedulingEnabled && !node.maintenance,
      "Node unavailable",
      409,
      "server_not_schedulable",
    );
    check(
      /^sha256:[a-f0-9]{64}$/.test(imageDigest || ""),
      "Runtime image unverified",
      400,
      "model_runtime_missing",
    );
    check(
      !apiKeyEnv || runtimeCredential(this.store,n.id,apiKeyEnv),
      "Inference key missing",
      400,
      "model_runtime_missing",
    );
    check(
      Array.isArray(data.gpuUuids) &&
        data.gpuUuids.length >= 1 &&
        data.gpuUuids.length <= 64 &&
        data.gpuUuids.length === model.gpus &&
        new Set(data.gpuUuids).size === model.gpus,
      "GPU count invalid",
      409,
      "gpu_unavailable",
      { requiredCards: model.gpus, availableCards: node.freeGpuCount },
    );
    const selected = data.gpuUuids.map((uuid) =>
      node.gpus.find((g) => g.uuid === uuid),
    );
    check(
      selected.every((g) => g && !g.missing && !g.externalBusy && !g.allocated),
      "GPU unavailable",
      409,
      "gpu_unavailable",
    );
    check(
      selected.every(
        (g) => g!.totalMemoryMiB >= model.runtime!.minGpuMemoryMiB,
      ),
      "Insufficient GPU memory",
      409,
      "insufficient_gpu_memory",
      {
        requiredMiB: model.runtime!.minGpuMemoryMiB,
        availableMiB: Math.min(...selected.map((g) => g!.totalMemoryMiB)),
      },
    );
    check(
      new Set(selected.map((g) => g!.name)).size === 1,
      "Mixed GPU types",
      409,
      "gpu_unavailable",
    );
    this.billing.reservations.guard(
      n.id,
      data.gpuUuids,
      null,
      planned?.endAt,
      planned?.reservationId,
    );
    let port =
      planned?.port === undefined
        ? node.portStart
        : int(planned.port, "port", node.portStart, node.portEnd);
    const portBusy = (port: number) =>
      !!this.store.get(
        "SELECT 1 FROM port_allocations WHERE serverId=? AND port=? AND released=0",
        n.id,
        port,
      ) ||
      !this.billing.reservations.portAvailable(
        n.id,
        port,
        planned?.endAt,
        planned?.reservationId,
      );
    while (
      planned?.port === undefined &&
      port <= node.portEnd &&
      portBusy(port)
    )
      port++;
    check(
      port <= node.portEnd && !portBusy(port),
      "No free port",
      409,
      "port_exhausted",
    );
    check(!rental || !data.replaces, "Rental cannot replace a model", 400);
    const replaces = data.replaces
      ? text(data.replaces, "replaces", 100)
      : null;
    if (replaces) {
      const old = this.dep(replaces);
      check(
        old.phase === "ready" &&
          old.desiredState === "running" &&
          !this.store.get(
            "SELECT 1 FROM deployments WHERE replaces=? AND phase!='stopped'",
            replaces,
          ),
        "Replacement unavailable",
        409,
        "deployment_conflict",
      );
    }
    const id = randomUUID(),
      spec = {
        ...model.runtime,
        ...(rental ? { workloadType: "gpu-rental" } : {}),
        gpuUuids: data.gpuUuids,
        endpointPort: port,
        servedModelName: model.id,
        apiKeyEnv,
        imageDigest,
      };
    this.store.run(
      "INSERT INTO deployments(id,serverId,modelId,phase,spec,replaces,actorId,requestKey,fingerprint,createdAt) VALUES(?,?,?,'queued',?,?,?,?,?,?)",
      id,
      n.id,
      model.id,
      JSON.stringify(spec),
      replaces,
      actorId,
      key,
      fingerprint,
      Date.now(),
    );
    this.store.run(
      "UPDATE deployments SET workloadType=?,ownerId=? WHERE id=?",
      rental ? "gpu-rental" : "inference",
      owner?.id ?? null,
      id,
    );
    for (const uuid of data.gpuUuids)
      this.store.run(
        "INSERT INTO gpu_allocations(deploymentId,serverId,uuid) VALUES(?,?,?)",
        id,
        n.id,
        String(uuid),
      );
    this.store.run(
      "INSERT INTO port_allocations(deploymentId,serverId,port) VALUES(?,?,?)",
      id,
      n.id,
      port,
    );
    this.job(id, "start");
    this.event(id, "queued");
    return this.project(this.dep(id));
  }
  agent(req: IncomingMessage) {
    const token = req.headers.authorization?.match(
      /^Bearer (node_[a-zA-Z0-9_-]{43})$/,
    )?.[1];
    const n =
      token &&
      this.store.get<NodeRow>(
        "SELECT * FROM servers WHERE tokenHash=? AND deleted=0",
        digest(token),
      );
    check(n, "Invalid agent credentials", 401, "unauthorized");
    return n;
  }
  fence(n: NodeRow, data: Record<string, unknown>) {
    check(
      this.online(n) &&
        n.instanceId === data.instanceId &&
        n.generation === data.generation,
      "Agent generation mismatch",
      409,
      "deployment_conflict",
    );
  }
  heartbeat(n: NodeRow, data: Record<string, unknown>) {
    return this.store.transaction(() => {
      const instanceId = text(data.instanceId, "instance", 100),
        bootId = text(data.bootId, "boot", 100),
        sequence = int(data.sequence, "sequence", 0, Number.MAX_SAFE_INTEGER);
      let generation = n.generation;
      if (instanceId !== n.instanceId || bootId !== n.bootId) {
        check(
          !this.online(n),
          "Another agent is active",
          409,
          "deployment_conflict",
        );
        generation++;
        check(
          data.generation == null,
          "New instance must register",
          409,
          "deployment_conflict",
        );
      } else {
        check(
          data.generation === generation,
          "Stale generation",
          409,
          "deployment_conflict",
        );
        if (sequence === n.sequence)
          return {
            ok: true,
            generation,
            serverTime: new Date().toISOString(),
            heartbeatSeconds: 10,
            rentalDeadlines: this.billing.deadlines(n.id),
            ...(JSON.parse(n.capabilities).nodeScopedKeys && n.credentialSeed ? {credentials:nodeCredentials(n.credentialSeed)} : {}),
          };
        check(
          sequence > n.sequence,
          "Stale heartbeat",
          409,
          "deployment_conflict",
        );
      }
      const caps = object(data.capabilities),
        error =
          data.inventoryError == null
            ? null
            : text(data.inventoryError, "inventory error", 2000),
        containers = data.containers;
      if (caps.nodeScopedKeys===true) {
        caps.workspaceKeyEnv=NODE_WORKSPACE_KEY;
        if(!n.credentialSeed) this.store.run("UPDATE servers SET credentialSeed=? WHERE id=?",secret(),n.id);
      }
      check(typeof caps.dockerReady === "boolean", "Invalid Docker readiness");
      for (const flag of [
        "inferenceReady",
        "workspaceReady",
        "expirySupported",
        "renewalSupported",
        "nodeScopedKeys",
      ])
        check(
          caps[flag] === undefined || typeof caps[flag] === "boolean",
          "Invalid runtime readiness",
        );
      check(
        caps.workspaceReady !== true ||
          /^sha256:[a-f0-9]{64}$/.test(String(caps.workspaceImageDigest)),
        "Invalid workspace image",
      );
      check(
        caps.inferenceReady !== true ||
          /^sha256:[a-f0-9]{64}$/.test(String(caps.runtimeImageDigest)),
        "Invalid inference image",
      );
      check(
        typeof caps.runtimeImageDigest === "string" &&
          (!caps.dockerReady ||
            /^sha256:[a-f0-9]{64}$/.test(caps.runtimeImageDigest) ||
            /^sha256:[a-f0-9]{64}$/.test(String(caps.workspaceImageDigest))),
        "Invalid image digest",
      );
      check(
        Array.isArray(containers) && containers.length <= 256,
        "Invalid containers",
      );
      const inventory = containers.map((c) => {
        const x = object(c);
        return {
          deploymentId: text(x.deploymentId, "deployment", 100),
          containerId: text(x.containerId, "container", 100),
          state: text(x.state, "state", 30),
          endpointPort: int(x.endpointPort, "port", 1024, 65535),
        };
      });
      const unknown = inventory.some(
        (c) =>
          !this.store.get(
            "SELECT 1 FROM deployments WHERE id=? AND serverId=?",
            c.deploymentId,
            n.id,
          ),
      );
      if (!error) {
        check(
          Array.isArray(data.gpus) && data.gpus.length <= 64,
          "Invalid GPUs",
        );
        const uuids = new Set<string>();
        this.store.run("UPDATE gpus SET missing=1 WHERE serverId=?", n.id);
        for (const value of data.gpus) {
          const g = object(value),
            uuid = text(g.uuid, "UUID", 100);
          check(
            /^GPU-[a-zA-Z0-9-]+$/.test(uuid) && !uuids.has(uuid),
            "Invalid GPU UUID",
          );
          uuids.add(uuid);
          const metric = (key: string, max: number) =>
            g[key] == null ? null : int(g[key], key, 0, max);
          check(typeof g.externalBusy === "boolean", "Invalid GPU occupancy");
          const gpu = {
            lastSeenAt: new Date().toISOString(),
            uuid,
            index: int(g.index, "index", 0, 255),
            name: text(g.name, "GPU name", 200),
            totalMemoryMiB: int(g.totalMemoryMiB, "memory", 1, 10_000_000),
            usedMemoryMiB: metric("usedMemoryMiB", 10_000_000),
            utilizationPercent: metric("utilizationPercent", 100),
            temperatureC: metric("temperatureC", 200),
            externalBusy: g.externalBusy,
          };
          this.store.run(
            "INSERT INTO gpus(serverId,uuid,data,missing) VALUES(?,?,?,0) ON CONFLICT(serverId,uuid) DO UPDATE SET data=excluded.data,missing=0",
            n.id,
            uuid,
            JSON.stringify(gpu),
          );
        }
        const reviewed=this.store.get<{approved:number;reviewedGpuUuids:string}>("SELECT approved,reviewedGpuUuids FROM provider_nodes WHERE serverId=?",n.id);
        if(reviewed?.approved && reviewed.reviewedGpuUuids!==JSON.stringify([...uuids].sort()))
          this.store.run("UPDATE provider_nodes SET approved=0 WHERE serverId=?",n.id);
      }
      if (generation !== n.generation)
        this.store.run(
          "UPDATE rental_orders SET expiryAcknowledgedAt=NULL WHERE deploymentId IN (SELECT id FROM deployments WHERE serverId=?)",
          n.id,
        );
      if (generation !== n.generation)
        this.store.run(
          "UPDATE deployments SET healthAt=NULL WHERE serverId=?",
          n.id,
        );
      for (const d of this.store.all<DepRow>(
        "SELECT * FROM deployments WHERE serverId=? AND phase='ready'",
        n.id,
      )) {
        if (
          !inventory.some(
            (c) => c.deploymentId === d.id && c.state === "running",
          )
        ) {
          if (!error && this.billing.row(d.id)) {
            this.billing.stopRequested(d.id);
            this.store.run(
              "UPDATE deployments SET desiredState='stopped',phase='draining' WHERE id=?",
              d.id,
            );
          }
          this.store.run(
            "UPDATE deployments SET healthAt=NULL WHERE id=?",
            d.id,
          );
        }
      }
      this.store.run(
        "UPDATE servers SET instanceId=?,bootId=?,generation=?,sequence=?,lastHeartbeat=?,inventoryError=?,capabilities=?,containers=? WHERE id=?",
        instanceId,
        bootId,
        generation,
        sequence,
        Date.now(),
        error ||
          (unknown
            ? "Unknown platform container; reconcile before scheduling"
            : null),
        JSON.stringify(caps),
        JSON.stringify(inventory),
        n.id,
      );
      if (!error && !unknown && caps.expirySupported === true)
        this.billing.acknowledge(n.id, data.expiryAcks);
      return {
        ok: true,
        generation,
        serverTime: new Date().toISOString(),
        heartbeatSeconds: 10,
        rentalDeadlines: this.billing.deadlines(n.id),
        ...(caps.nodeScopedKeys===true ? {credentials:nodeCredentials(this.node(n.id).credentialSeed!)} : {}),
      };
    });
  }
  claim(n: NodeRow, data: Record<string, unknown>) {
    this.fence(n, data);
    return this.store.transaction(() => {
      const j = this.store.get<Job>(
        "SELECT j.* FROM deployment_jobs j JOIN deployments d ON d.id=j.deploymentId WHERE d.serverId=? AND (j.status='queued' OR (j.status='leased' AND j.leaseExpires<?)) ORDER BY CASE j.kind WHEN 'stop' THEN 0 ELSE 1 END,j.createdAt LIMIT 1",
        n.id,
        Date.now(),
      );
      if (!j) return { job: null };
      if (
        j.kind === "start" &&
        this.billing.reservations.gpuIdentityConflict(n.id)
      )
        return { job: null };
      const token = secret(),
        expires = Date.now() + LEASE;
      this.store.run(
        "UPDATE deployment_jobs SET status='leased',attempt=attempt+1,generation=?,leaseHash=?,leaseExpires=?,claimedAt=? WHERE id=?",
        n.generation,
        digest(token),
        expires,
        Date.now(),
        j.id,
      );
      if (j.kind === "start")
        this.store.run(
          "UPDATE deployments SET phase='starting' WHERE id=? AND desiredState='running'",
          j.deploymentId,
        );
      return {
        job: {
          id: j.id,
          deploymentId: j.deploymentId,
          kind: j.kind,
          attempt: j.attempt + 1,
          generation: n.generation,
          leaseToken: token,
          leaseExpiresAt: iso(expires),
          spec: JSON.parse(this.dep(j.deploymentId).spec),
        },
      };
    });
  }
  jobFence(n: NodeRow, j: Job, data: Record<string, unknown>) {
    this.fence(n, data);
    check(
      this.dep(j.deploymentId).serverId === n.id,
      "Forbidden",
      403,
      "forbidden",
    );
    check(
      j.generation === n.generation &&
        j.attempt === data.attempt &&
        typeof data.leaseToken === "string" &&
        j.leaseHash === digest(data.leaseToken),
      "Stale job",
      409,
      "deployment_conflict",
    );
  }
  report(n: NodeRow, j: Job, data: Record<string, unknown>) {
    this.jobFence(n, j, data);
    const eventId = text(data.eventId, "event ID", 100),
      event = text(data.event, "event", 30);
    check(
      ["starting", "healthy", "stopped", "failed"].includes(event),
      "Invalid event",
    );
    // Messages are fixed diagnostic codes; raw Docker output may contain credentials.
    const message = text(data.message ?? "", "message", 2000, true);
    check(/^[a-zA-Z0-9_. :/-]*$/.test(message), "Use a diagnostic code");
    const fingerprint = digest(JSON.stringify({ event, message })),
      previous = this.store.get<{ fingerprint: string }>(
        "SELECT fingerprint FROM deployment_events WHERE jobId=? AND attempt=? AND eventId=?",
        j.id,
        j.attempt,
        eventId,
      );
    if (previous) {
      check(
        previous.fingerprint === fingerprint,
        "Event conflict",
        409,
        "idempotency_conflict",
      );
      return { ok: true };
    }
    check(
      j.status === "leased" && j.leaseExpires > Date.now(),
      "Lease expired",
      409,
      "deployment_conflict",
    );
    this.store.transaction(() => {
      const d = this.dep(j.deploymentId);
      check(
        event === "failed" ||
          (j.kind === "start" &&
            ["starting", "healthy"].includes(event) &&
            d.desiredState === "running") ||
          (j.kind === "stop" &&
            event === "stopped" &&
            d.desiredState === "stopped"),
        "Invalid transition",
        409,
        "deployment_conflict",
      );
      if (event === "stopped") {
        const fresh = this.node(n.id);
        check(
          !!fresh.lastHeartbeat &&
            fresh.lastHeartbeat >= j.claimedAt &&
            !fresh.inventoryError &&
            !JSON.parse(fresh.containers).some(
              (c: { deploymentId: string }) => c.deploymentId === d.id,
            ) &&
            !this.store.get(
              "SELECT 1 FROM requests WHERE deploymentId=? AND status='pending'",
              d.id,
            ),
          "Stop not confirmed by inventory",
          409,
          "deployment_conflict",
        );
        this.store.run(
          "UPDATE gpu_allocations SET released=1 WHERE deploymentId=?",
          d.id,
        );
        this.billing.stopped(d.id);
        stopProcurement(this.store,d.id);
        this.store.run(
          "UPDATE port_allocations SET released=1 WHERE deploymentId=?",
          d.id,
        );
      }
      const phase =
        event === "healthy"
          ? "checking"
          : event === "stopped"
            ? "stopped"
            : event === "failed"
              ? "failed"
              : "starting";
      this.store.run(
        "UPDATE deployments SET phase=?,healthAt=NULL,lastError=? WHERE id=?",
        phase,
        event === "failed" ? message : null,
        d.id,
      );
      if (!["starting", "healthy"].includes(event))
        this.store.run(
          "UPDATE deployment_jobs SET status='done' WHERE id=?",
          j.id,
        );
      this.store.run(
        "INSERT INTO deployment_events(deploymentId,jobId,attempt,eventId,event,message,time,fingerprint) VALUES(?,?,?,?,?,?,?,?)",
        d.id,
        j.id,
        j.attempt,
        eventId,
        event,
        message,
        Date.now(),
        fingerprint,
      );
      if (event === "failed" && j.kind === "start") {
        this.billing.stopRequested(d.id);
        this.store.run(
          "UPDATE deployments SET desiredState='stopped',phase='draining' WHERE id=?",
          d.id,
        );
      }
    });
    if (event === "healthy") void this.probe(j.deploymentId, n.generation);
    this.advanceStops();
    return { ok: true };
  }
  async probe(id: string, generation: number) {
    if (this.disposed || this.probing.has(id)) return;
    this.probing.add(id);
    try {
      const d = this.dep(id),
        spec = JSON.parse(d.spec),
        base = this.endpoint(d),
        headers = {
          "Content-Type": "application/json",
          ...(spec.apiKeyEnv
            ? { Authorization: `Bearer ${runtimeCredential(this.store,d.serverId,spec.apiKeyEnv) || ""}` }
            : {}),
        };
      const node = this.node(d.serverId);
      check(
        this.online(node) &&
          !node.inventoryError &&
          !this.billing.reservations.gpuIdentityConflict(node.id) &&
          JSON.parse(node.containers).some(
            (c: {
              deploymentId: string;
              state: string;
              endpointPort: number;
            }) =>
              c.deploymentId === id &&
              c.state === "running" &&
              c.endpointPort === spec.endpointPort,
          ),
        "Container inventory not healthy",
      );
      const verifyingJob =
        d.phase === "checking"
          ? this.store.get<Job>(
              "SELECT * FROM deployment_jobs WHERE deploymentId=? AND kind='start' ORDER BY createdAt DESC LIMIT 1",
              id,
            )
          : undefined;
      if (d.workloadType === "gpu-rental") {
        const key = runtimeCredential(this.store,d.serverId,spec.apiKeyEnv);
        check(key, "Workspace key missing");
        const r = await fetch(
          base + `/api/compute/rentals/${id}/lab/api/status`,
          {
            headers: {
              Authorization:
                "token " +
                createHmac("sha256", key)
                  .update("corematrix-jupyter:" + id)
                  .digest("hex"),
            },
            redirect: "error",
            signal: AbortSignal.timeout(5000),
          },
        );
        check(
          typeof (await healthJson(r)).started === "string",
          "Invalid workspace health",
        );
      } else {
        const get = await fetch(base + "/v1/models", {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        check(get.ok, "Health failed");
        const list = (await healthJson(get)) as { data?: { id: string }[] };
        check(
          list.data?.some((m) => m.id === spec.servedModelName),
          "Model identity mismatch",
        );
        if (d.phase === "checking") {
          const r = await fetch(base + "/v1/chat/completions", {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: spec.servedModelName,
              messages: [{ role: "user", content: "Hello" }],
              max_tokens: 1,
              stream: false,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          });
          check(r.ok, "Inference health failed");
          const out = (await healthJson(r)) as {
            choices?: { message?: { content?: unknown } }[];
          };
          check(
            typeof out.choices?.[0]?.message?.content === "string",
            "Invalid inference",
          );
        }
      }
      if (this.disposed) return;
      this.store.transaction(() => {
        const current = this.dep(id),
          node = this.node(current.serverId);
        if (
          node.generation !== generation ||
          !this.online(node) ||
          !!node.inventoryError ||
          this.billing.reservations.gpuIdentityConflict(node.id) ||
          !JSON.parse(node.containers).some(
            (c: { deploymentId: string; state: string }) =>
              c.deploymentId === id && c.state === "running",
          ) ||
          current.desiredState !== "running" ||
          !["checking", "ready"].includes(current.phase)
        )
          return;
        if (current.phase === "checking") {
          const job =
            verifyingJob &&
            this.store.get<Job>(
              "SELECT * FROM deployment_jobs WHERE id=?",
              verifyingJob.id,
            );
          if (
            !job ||
            job.status !== "leased" ||
            job.generation !== generation ||
            job.attempt !== verifyingJob!.attempt ||
            job.leaseExpires <= Date.now()
          )
            return;
          this.store.run(
            "UPDATE deployment_jobs SET status='done' WHERE id=?",
            job.id,
          );
        }
        if (!this.billing.activate(id)) return;
        startProcurement(this.store,id);
        this.store.run(
          "UPDATE deployments SET phase='ready',healthAt=?,lastError=NULL WHERE id=?",
          Date.now(),
          id,
        );
        if (current.phase === "checking") {
          this.event(id, "ready");
          if (current.replaces) {
            this.store.run(
              "UPDATE deployments SET desiredState='stopped',phase='draining',healthAt=NULL WHERE id=? AND desiredState='running'",
              current.replaces,
            );
            this.event(current.replaces, "draining");
          }
        }
      });
    } catch {
      if (!this.disposed)
        this.store.run(
          "UPDATE deployments SET healthAt=NULL,lastError='health_probe_failed' WHERE id=? AND desiredState='running'",
          id,
        );
    } finally {
      this.probing.delete(id);
    }
  }
  tick() {
    if (this.disposed) return;
    this.billing.tick(this);
    this.advanceStops();
    for (const d of this.store.all<DepRow>(
      "SELECT * FROM deployments WHERE desiredState='running' AND phase IN ('checking','ready')",
    )) {
      const n = this.node(d.serverId);
      if (this.online(n)) void this.probe(d.id, n.generation);
    }
    // A start deadline never frees resources; cleanup must confirm container absence.
    for (const d of this.store.all<DepRow>(
      "SELECT * FROM deployments WHERE phase IN ('queued','starting','checking') AND desiredState='running' AND createdAt<?",
      Date.now() - 20 * 60_000,
    ))
      this.stop(d.id, true);
  }
  createNode(raw: Record<string, unknown>) {
    const data = this.validateNode(raw), id = randomUUID(), token = "node_" + secret();
    this.store.run("INSERT INTO servers(id,data,tokenHash,credentialSeed) VALUES(?,?,?,?)",id,JSON.stringify(data),digest(token),secret());
    return {server:this.server(this.node(id)),agentToken:token};
  }
  updateNode(id: string, raw: Record<string,unknown>) {
    const n=this.node(id), data=this.validateNode(raw), old=JSON.parse(n.data);
    check(!this.busy(id) || (old.inferenceHost===data.inferenceHost && old.portStart===data.portStart && old.portEnd===data.portEnd && (old.workMode??"inference")===data.workMode),"Node in use",409,"server_in_use");
    this.store.run("UPDATE servers SET data=? WHERE id=?",JSON.stringify(data),id);
    return {server:this.server(this.node(id))};
  }
  rotateNodeToken(id: string) {
    this.node(id);
    const token="node_"+secret();
    this.store.run("UPDATE rental_orders SET expiryAcknowledgedAt=NULL WHERE deploymentId IN (SELECT id FROM deployments WHERE serverId=?)",id);
    this.store.run("UPDATE servers SET tokenHash=?,instanceId=NULL,bootId=NULL,lastHeartbeat=NULL,generation=generation+1,sequence=-1 WHERE id=?",digest(token),id);
    return {agentToken:token};
  }
  deleteNode(id: string) {
    this.node(id); check(!this.busy(id),"Node in use",409,"server_in_use");
    this.store.run("UPDATE servers SET deleted=1 WHERE id=?",id); return {ok:true};
  }
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    h: Helpers,
  ) {
    if (path.startsWith("/api/agent/")) {
      check(method === "POST", "Method not allowed", 405);
      const n = this.agent(req),
        data = await h.body(req);
      let result: unknown;
      if (path === "/api/agent/heartbeat") result = this.heartbeat(n, data);
      else if (path === "/api/agent/jobs/claim") result = this.claim(n, data);
      else {
        const match = path.match(
          /^\/api\/agent\/jobs\/([a-f0-9-]+)\/(renew|report)$/,
        );
        check(match, "Not found", 404, "not_found");
        const j = this.store.get<Job>(
          "SELECT * FROM deployment_jobs WHERE id=?",
          match[1],
        );
        check(j, "Job not found", 404, "not_found");
        this.jobFence(n, j, data);
        if (match[2] === "renew") {
          check(
            j.status === "leased" && j.leaseExpires > Date.now(),
            "Lease expired",
            409,
            "deployment_conflict",
          );
          const expires = Date.now() + LEASE;
          this.store.run(
            "UPDATE deployment_jobs SET leaseExpires=? WHERE id=?",
            expires,
            j.id,
          );
          result = { leaseExpiresAt: iso(expires) };
        } else result = this.report(n, j, data);
      }
      h.send(res, 200, result);
      return true;
    }
    if (!/^\/api\/admin\/(servers|deployments|rentals)(\/|$)/.test(path))
      return false;
    const { user } = h.admin(req),
      parts = path.split("/").slice(3),
      kind = parts[0],
      id = parts[1],
      action = parts[2];
    let result: unknown,
      status = 200;
    if (kind === "servers") {
      if (!id && method === "GET") result = { data: this.servers() };
      else if (!id && method === "POST") {
        result = this.createNode(await h.body(req));
        status = 201;
      } else {
        const n = this.node(id);
        if (method === "GET")
          result = {
            server: this.server(n),
            deployments: this.deployments(id),
          };
        else if (method === "PUT") {
          result = this.updateNode(id,await h.body(req));
        } else if (method === "POST" && action === "token") {
          result = this.store.transaction(() => this.rotateNodeToken(id));
        } else {
          check(method === "DELETE" && !action, "Not found", 404, "not_found");
          result = this.deleteNode(id);
        }
      }
    } else {
      if (!id && method === "GET")
        result = {
          data: this.deployments(
            new URL(req.url!, "http://localhost").searchParams.get(
              "serverId",
            ) || undefined,
          ),
        };
      else if (!id && method === "POST") {
        result = {
          deployment: this.create(
            {
              ...(await h.body(req)),
              ...(kind === "rentals" ? { workloadType: "gpu-rental" } : {}),
            },
            user.id,
            requestKey(req.headers["idempotency-key"]),
          ),
        };
        status = 202;
      } else {
        const d = this.dep(id);
        if (method === "GET" && action === "events") {
          const url = new URL(req.url!, "http://localhost"),
            after = Number(url.searchParams.get("after") || 0),
            limit = Number(url.searchParams.get("limit") || 50);
          int(after, "cursor", 0, Number.MAX_SAFE_INTEGER);
          int(limit, "limit", 1, 200);
          const events = this.store.all<{
            id: number;
            event: string;
            message: string;
            time: number;
          }>(
            "SELECT id,event,message,time FROM deployment_events WHERE deploymentId=? AND id>? ORDER BY id LIMIT ?",
            d.id,
            after,
            limit,
          );
          result = {
            data: events.map((e) => ({ ...e, time: iso(e.time) })),
            nextCursor: events.at(-1)?.id ?? after,
          };
        } else if (method === "GET") result = { deployment: this.project(d) };
        else {
          check(
            method === "POST" && ["stop", "retry-cleanup"].includes(action),
            "Not found",
            404,
            "not_found",
          );
          this.stop(id, action === "retry-cleanup");
          result = { deployment: this.project(this.dep(id)) };
          status = 202;
        }
      }
    }
    h.send(res, status, result);
    return true;
  }
}
