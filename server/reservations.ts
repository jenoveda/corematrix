import { randomUUID } from "node:crypto";
import { digest } from "./auth.ts";
import { check, HttpError, int, text } from "./validation.ts";
import type { Store } from "./store.ts";
import type { Infrastructure } from "./infrastructure.ts";
import type { Reservation, Server } from "../src/domain.ts";
export const SETUP_MS = 20 * 60000,
  CLEANUP_MS = 5 * 60000;
export type Window = { start: number; end: number };
export function reservationTime(value: unknown) {
  const raw = text(value, "startsAt", 30),
    ms = Date.parse(raw);
  check(
    Number.isFinite(ms) &&
      (new Date(ms).toISOString() === raw ||
        new Date(ms).toISOString().replace(".000Z", "Z") === raw),
    "Use a valid UTC ISO timestamp",
    400,
    "reservation_time_invalid",
  );
  return ms;
}
export function reservationWindow(startsAt: unknown, hours: number): Window {
  const start = reservationTime(startsAt),
    now = Date.now();
  check(
    start >= now + 5 * 60000 && start <= now + 30 * 86400000,
    "Reservation must start in 5 minutes to 30 days",
    400,
    "reservation_time_invalid",
  );
  return { start, end: start + hours * 3600000 };
}
type Row = {
  id: string;
  userId: string;
  serverId: string;
  serverName: string;
  offerId: string;
  resource: string;
  memoryMiB: number;
  cards: number;
  hours: number;
  hourlyPrice: number;
  amount: number;
  reserved: number;
  status: Reservation["status"];
  gpuUuids: string;
  port: number;
  startsAt: number;
  endsAt: number;
  createdAt: number;
  closedAt: number | null;
  errorCode: string | null;
  cancelActorId: string | null;
  cancelReason: string | null;
  requestKey: string;
  fingerprint: string;
  orderId: string | null;
};
export class Reservations {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  row(id: string) {
    return this.store.get<Row>(
      "SELECT * FROM rental_reservations WHERE id=?",
      id,
    );
  }
  project(r: Row, admin = false): Reservation {
    return {
      id: r.id,
      serverName: r.serverName,
      resource: r.resource,
      memoryMiB: r.memoryMiB,
      cards: r.cards,
      hours: r.hours,
      hourlyPrice: r.hourlyPrice,
      amount: r.amount,
      reserved: r.reserved,
      status: r.status,
      startsAt: new Date(r.startsAt).toISOString(),
      endsAt: new Date(r.endsAt).toISOString(),
      createdAt: new Date(r.createdAt).toISOString(),
      closedAt: r.closedAt === null ? null : new Date(r.closedAt).toISOString(),
      errorCode: r.errorCode,
      cancelReason: r.cancelReason,
      orderId: r.orderId,
      ...(admin
        ? {
            email: this.store.user(r.userId)!.email,
            serverId: r.serverId,
            gpuUuids: JSON.parse(r.gpuUuids) as string[],
            port: r.port,
          }
        : {}),
    };
  }
  list(userId: string | null) {
    return this.store
      .all<Row>(
        `SELECT * FROM rental_reservations ${userId ? "WHERE userId=?" : ""} ORDER BY createdAt DESC`,
        ...(userId ? [userId] : []),
      )
      .map((r) => this.project(r, !userId));
  }
  busy(serverId: string) {
    return !!this.store.get(
      "SELECT 1 FROM rental_reservations WHERE serverId=? AND status='booked' LIMIT 1",
      serverId,
    );
  }
  gpuIdentityConflict(serverId: string) {
    // Heartbeat age cannot release a physical GPU; idle old registrations must be decommissioned.
    return !!this.store.get(
      `SELECT 1 FROM (SELECT uuid FROM gpus WHERE serverId=? AND missing=0 UNION SELECT uuid FROM gpu_allocations WHERE serverId=? AND released=0) own
       WHERE EXISTS(SELECT 1 FROM gpus g JOIN servers s ON s.id=g.serverId AND s.deleted=0 LEFT JOIN provider_nodes pn ON pn.serverId=g.serverId WHERE g.uuid=own.uuid AND g.serverId!=? AND g.missing=0 AND (pn.serverId IS NULL OR pn.approved=1))
          OR EXISTS(SELECT 1 FROM gpu_allocations a WHERE a.uuid=own.uuid AND a.serverId!=? AND a.released=0) LIMIT 1`,
      serverId,
      serverId,
      serverId,
      serverId,
    );
  }
  private slots(window: Window, exclude?: string) {
    return this.store.all<Row>(
      "SELECT * FROM rental_reservations WHERE status IN ('booked','starting','active','stopping') AND startsAt<? AND endsAt+?>? AND id!=?",
      window.end + CLEANUP_MS,
      CLEANUP_MS,
      window.start,
      exclude || "",
    );
  }
  private physicalEnd(deploymentId: string) {
    const d = this.store.get<{ phase: string; desiredState: string }>(
      "SELECT phase,desiredState FROM deployments WHERE id=?",
      deploymentId,
    )!;
    if (
      d.desiredState !== "running" ||
      !["queued", "starting", "checking", "ready"].includes(d.phase)
    )
      return Number.POSITIVE_INFINITY;
    const r = this.store.get<{
      closedAt: number | null;
      expiresAt: number | null;
      createdAt: number;
      hours: number;
      scheduledEnd: number | null;
    }>("SELECT * FROM rental_orders WHERE deploymentId=?", deploymentId);
    if (!r || r.closedAt !== null) return Number.POSITIVE_INFINITY;
    return (
      (r.scheduledEnd ??
        r.expiresAt ??
        r.createdAt + SETUP_MS + r.hours * 3600000) + CLEANUP_MS
    );
  }
  availableGpus(node: Server, window: Window, exclude?: string) {
    if (this.gpuIdentityConflict(node.id)) return [];
    const slots = this.slots(window, exclude),
      allocated = this.store.all<{ uuid: string; deploymentId: string }>(
        "SELECT uuid,deploymentId FROM gpu_allocations WHERE released=0 AND uuid IN (SELECT uuid FROM gpus WHERE serverId=?)",
        node.id,
      );
    return node.gpus.filter(
      (g) =>
        !g.missing &&
        !g.externalBusy &&
        !slots.some((r) =>
          (JSON.parse(r.gpuUuids) as string[]).includes(g.uuid),
        ) &&
        !allocated.some(
          (a) =>
            a.uuid === g.uuid &&
            this.physicalEnd(a.deploymentId) > window.start,
        ),
    );
  }
  availablePort(node: Server, window: Window, exclude?: string) {
    const slots = this.slots(window, exclude).filter(
        (r) => r.serverId === node.id,
      ),
      allocated = this.store.all<{ port: number; deploymentId: string }>(
        "SELECT port,deploymentId FROM port_allocations WHERE serverId=? AND released=0",
        node.id,
      );
    for (let port = node.portStart; port <= node.portEnd; port++)
      if (
        !slots.some((r) => r.port === port) &&
        !allocated.some(
          (a) =>
            a.port === port && this.physicalEnd(a.deploymentId) > window.start,
        )
      )
        return port;
    return null;
  }
  guard(
    serverId: string,
    gpus: unknown[],
    port: number | null,
    end = Number.MAX_SAFE_INTEGER - CLEANUP_MS,
    exclude?: string,
  ) {
    const slots = this.slots({ start: Date.now(), end }, exclude);
    check(
      !slots.some(
        (r) =>
          (JSON.parse(r.gpuUuids) as string[]).some((g) => gpus.includes(g)) ||
          (r.serverId === serverId && port !== null && r.port === port),
      ),
      "Resources promised to another reservation",
      409,
      "reservation_conflict",
    );
  }
  portAvailable(
    serverId: string,
    port: number,
    end = Number.MAX_SAFE_INTEGER - CLEANUP_MS,
    exclude?: string,
  ) {
    return !this.slots({ start: Date.now(), end }, exclude).some(
      (r) => r.serverId === serverId && r.port === port,
    );
  }
  book(
    infra: Infrastructure,
    userId: string,
    key: string,
    data: Record<string, unknown>,
    controlHost: string,
  ) {
    return this.store.transaction(() => {
      const offerId = text(data.offerId, "offerId", 160),
        cards = int(data.cards, "cards", 1, 64),
        hours = int(data.hours, "hours", 1, 720),
        expectedHourlyPrice = int(
          data.expectedHourlyPrice,
          "expectedHourlyPrice",
          1,
          10000000000,
        ),
        start = reservationTime(data.startsAt),
        fingerprint = digest(
          JSON.stringify({ offerId, cards, hours, expectedHourlyPrice, start }),
        );
      const previous = this.store.get<Row>(
        "SELECT * FROM rental_reservations WHERE userId=? AND requestKey=?",
        userId,
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
      const window = reservationWindow(data.startsAt, hours),
        offer = infra.billing
          .offers(infra, controlHost, window)
          .find((o) => o.id === offerId);
      check(offer, "Offer unavailable", 409, "offer_unavailable");
      check(
        offer.hourlyPrice === expectedHourlyPrice,
        "Price changed",
        409,
        "rental_price_changed",
      );
      check(
        offer.availableCards >= cards,
        "Reservation unavailable",
        409,
        "reservation_conflict",
      );
      const cost = BigInt(offer.hourlyPrice) * BigInt(cards) * BigInt(hours);
      check(cost <= BigInt(Number.MAX_SAFE_INTEGER), "Amount overflow");
      const amount = Number(cost),
        user = this.store.user(userId)!;
      check(
        !this.store.paymentReview(userId) &&
          user.paymentDebt === 0 &&
          this.store.available(userId) >= amount,
        "Insufficient balance",
        402,
        "insufficient_balance",
      );
      const node = infra.server(infra.node(offerId.split(".")[0])),
        gpuUuids = this.availableGpus(node, window)
          .filter(
            (g) =>
              g.name === offer.gpuName && g.totalMemoryMiB === offer.memoryMiB,
          )
          .slice(0, cards)
          .map((g) => g.uuid),
        port = this.availablePort(node, window);
      check(
        gpuUuids.length === cards && port !== null,
        "Reservation unavailable",
        409,
        "reservation_conflict",
      );
      const id = randomUUID();
      this.store.run(
        "INSERT INTO rental_reservations(id,userId,serverId,serverName,offerId,resource,memoryMiB,cards,hours,hourlyPrice,amount,reserved,status,gpuUuids,port,startsAt,endsAt,createdAt,requestKey,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'booked',?,?,?,?,?,?,?)",
        id,
        userId,
        node.id,
        node.name,
        offerId,
        offer.gpuName,
        offer.memoryMiB,
        cards,
        hours,
        offer.hourlyPrice,
        amount,
        amount,
        JSON.stringify(gpuUuids),
        port,
        window.start,
        window.end,
        Date.now(),
        key,
        fingerprint,
      );
      return this.project(this.row(id)!);
    });
  }
  cancel(
    infra: Infrastructure,
    id: string,
    actorId: string,
    admin: boolean,
    reason?: unknown,
  ) {
    const result = this.store.transaction(() => {
      const r = this.row(id);
      check(
        r && (admin || r.userId === actorId),
        "Reservation not found",
        404,
        "not_found",
      );
      if (["completed", "canceled", "failed"].includes(r.status))
        return this.project(r, admin);
      const cancelReason = admin ? text(reason, "reason", 200) : null;
      this.store.run(
        "UPDATE rental_reservations SET cancelActorId=COALESCE(cancelActorId,?),cancelReason=COALESCE(cancelReason,?) WHERE id=?",
        actorId,
        cancelReason,
        id,
      );
      if (r.status === "booked")
        this.store.run(
          "UPDATE rental_reservations SET status='canceled',reserved=0,closedAt=?,errorCode=NULL WHERE id=?",
          Date.now(),
          id,
        );
      else {
        const order = this.store.get<{ deploymentId: string }>(
          "SELECT deploymentId FROM rental_orders WHERE id=?",
          r.orderId!,
        );
        check(order, "Order missing", 409, "rental_not_active");
        infra.stopReserved(order.deploymentId);
      }
      return this.project(this.row(id)!, admin);
    });
    infra.advanceStops();
    return result;
  }
  tick(infra: Infrastructure) {
    const now = Date.now();
    for (const r of this.store.all<Row>(
      "SELECT * FROM rental_reservations WHERE status='booked' AND startsAt<=? ORDER BY startsAt,createdAt",
      now,
    )) {
      if (now >= Math.min(r.startsAt + SETUP_MS, r.endsAt)) {
        this.store.transaction(() =>
          this.store.run(
            "UPDATE rental_reservations SET status='failed',reserved=0,closedAt=?,errorCode='reservation_delivery_failed' WHERE id=? AND status='booked'",
            now,
            r.id,
          ),
        );
        continue;
      }
      const user = this.store.user(r.userId)!;
      if (user.paymentDebt || this.store.paymentReview(r.userId)) {
        this.store.transaction(() =>
          this.store.run(
            "UPDATE rental_reservations SET status='failed',reserved=0,closedAt=?,errorCode='reservation_payment_blocked' WHERE id=? AND status='booked'",
            now,
            r.id,
          ),
        );
        continue;
      }
      try {
        this.store.transaction(() => {
          const current = this.row(r.id)!;
          if (current.status !== "booked") return;
          const node = infra.server(infra.node(r.serverId)),
            promised = JSON.parse(r.gpuUuids) as string[];
          check(
            promised.every((uuid) =>
              node.gpus.some(
                (g) =>
                  g.uuid === uuid &&
                  !g.missing &&
                  g.name === r.resource &&
                  g.totalMemoryMiB === r.memoryMiB,
              ),
            ),
            "Promised GPU changed",
            409,
            "reservation_resource_changed",
          );
          const deployment = infra.createReserved(
            {
              serverId: r.serverId,
              ownerEmail: user.email,
              workloadType: "gpu-rental",
              gpuUuids: JSON.parse(r.gpuUuids),
            },
            r.userId,
            "reservation:" + r.id,
            { endAt: r.endsAt, reservationId: r.id, port: r.port },
          );
          const id = randomUUID();
          this.store.run(
            "INSERT INTO rental_orders(id,userId,deploymentId,offerId,resource,cards,hours,hourlyPrice,amount,reserved,status,createdAt,requestKey,fingerprint,reservationId,scheduledStart,scheduledEnd) VALUES(?,?,?,?,?,?,?,?,?,?,'provisioning',?,?,?,?,?,?)",
            id,
            r.userId,
            deployment.id,
            r.offerId,
            r.resource,
            r.cards,
            r.hours,
            r.hourlyPrice,
            r.amount,
            r.amount,
            now,
            "reservation:" + r.id,
            r.fingerprint,
            r.id,
            r.startsAt,
            r.endsAt,
          );
          this.store.run(
            "UPDATE rental_reservations SET status='starting',reserved=0,orderId=?,errorCode=NULL WHERE id=?",
            id,
            r.id,
          );
        });
      } catch (e) {
        this.store.run(
          "UPDATE rental_reservations SET errorCode=? WHERE id=? AND status='booked'",
          e instanceof HttpError ? e.code : "internal_error",
          r.id,
        );
        if (!(e instanceof HttpError))
          console.error("Reservation dispatch failed");
      }
    }
    for (const r of this.store.all<{ deploymentId: string }>(
      "SELECT o.deploymentId FROM rental_orders o WHERE o.reservationId IS NOT NULL AND o.status='provisioning' AND o.scheduledStart+?<=?",
      SETUP_MS,
      now,
    ))
      infra.stop(r.deploymentId);
  }
}
