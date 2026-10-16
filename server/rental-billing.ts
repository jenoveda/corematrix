import { randomUUID } from "node:crypto";
import { digest } from "./auth.ts";
import { check, day, int, text } from "./validation.ts";
import type { Store } from "./store.ts";
import type { Infrastructure } from "./infrastructure.ts";
import type { Order, RentalOffer } from "../src/domain.ts";
import { Reservations, SETUP_MS } from "./reservations.ts";
import type { Window } from "./reservations.ts";

type Row = Omit<
  Order,
  | "createdAt"
  | "startedAt"
  | "expiresAt"
  | "closedAt"
  | "accessReady"
  | "confirmedExpiresAt"
  | "renewalPending"
  | "scheduledStart"
  | "scheduledEnd"
> & {
  userId: string;
  offerId: string;
  createdAt: number;
  startedAt: number | null;
  expiresAt: number | null;
  closedAt: number | null;
  stopRequestedAt: number | null;
  expiryAcknowledgedAt: number | null;
  requestKey: string;
  fingerprint: string;
  expiryRevision: number;
  confirmedExpiresAt: number | null;
  scheduledStart: number | null;
  scheduledEnd: number | null;
};
type Action = {
  id: string;
  userId: string;
  orderId: string;
  kind: "renew" | "cancel";
  hours: number;
  amount: number;
  status: "pending" | "succeeded" | "failed";
  revision: number;
  expiresAt: number | null;
  fingerprint: string;
};
const iso = (n: number | null) =>
  n === null ? null : new Date(n).toISOString();
export class RentalBilling {
  readonly store: Store;
  readonly reservations: Reservations;
  constructor(store: Store) {
    this.store = store;
    this.reservations = new Reservations(store);
  }
  row(deploymentId: string) {
    return this.store.get<Row>(
      "SELECT * FROM rental_orders WHERE deploymentId=?",
      deploymentId,
    );
  }
  project(r: Row): Order {
    return {
      id: r.id,
      reservationId: r.reservationId,
      scheduledStart: iso(r.scheduledStart),
      scheduledEnd: iso(r.scheduledEnd),
      deploymentId: r.deploymentId,
      resource: r.resource,
      cards: r.cards,
      hours: r.hours,
      hourlyPrice: r.hourlyPrice,
      amount: r.amount,
      reserved: r.reserved,
      charged: r.charged,
      refunded: r.refunded,
      status: r.status,
      createdAt: iso(r.createdAt)!,
      startedAt: iso(r.startedAt),
      expiresAt: iso(r.expiresAt),
      confirmedExpiresAt: iso(r.confirmedExpiresAt),
      renewalPending: this.pending(r.id),
      closedAt: iso(r.closedAt),
      accessReady:
        r.status === "active" &&
        r.expiresAt! > Date.now() &&
        r.confirmedExpiresAt! > Date.now() &&
        r.expiryAcknowledgedAt !== null,
    };
  }
  pending(orderId: string) {
    return !!this.store.get(
      "SELECT 1 FROM rental_actions WHERE orderId=? AND kind='renew' AND status='pending'",
      orderId,
    );
  }
  actionResult(a: Action, r: Row) {
    return {
      order: this.project(r),
      action: {
        id: a.id,
        kind: a.kind,
        hours: a.hours,
        amount: a.amount,
        status: a.status,
        expiresAt: iso(a.expiresAt),
      },
    };
  }
  act(
    infra: Infrastructure,
    userId: string,
    orderId: string,
    kind: "renew" | "cancel",
    key: string,
    data: Record<string, unknown>,
  ) {
    const result = this.store.transaction(() => {
      const r = this.store.get<Row>(
        "SELECT * FROM rental_orders WHERE id=?",
        orderId,
      );
      check(r, "Order not found", 404, "not_found");
      check(r.userId === userId, "Order access denied", 403, "forbidden");
      const hours = kind === "renew" ? int(data.hours, "hours", 1, 720) : 0,
        fingerprint = digest(JSON.stringify({ orderId, kind, hours })),
        previous = this.store.get<Action>(
          "SELECT * FROM rental_actions WHERE userId=? AND requestKey=?",
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
        return this.actionResult(previous, r);
      }
      const d = infra.dep(r.deploymentId),
        now = Date.now();
      check(
        r.closedAt === null &&
          d.desiredState === "running" &&
          (r.status === "active" ||
            (kind === "cancel" && r.status === "provisioning")),
        "Order is not running",
        409,
        "rental_not_active",
      );
      const id = randomUUID();
      let amount = 0,
        revision = r.expiryRevision,
        expiresAt = r.expiresAt;
      if (kind === "renew") {
        const n = infra.node(d.serverId),
          caps = JSON.parse(n.capabilities);
        check(
          !this.pending(r.id),
          "Renewal is pending",
          409,
          "renewal_pending",
        );
        check(
          r.expiryAcknowledgedAt !== null &&
            r.confirmedExpiresAt !== null &&
            Math.min(r.expiresAt!, r.confirmedExpiresAt) > now + 30000,
          "Too close to expiry",
          409,
          "renewal_too_late",
        );
        check(
          infra.online(n) &&
            !n.inventoryError &&
            !this.reservations.gpuIdentityConflict(n.id) &&
            caps.renewalSupported === true &&
            d.phase === "ready" &&
            d.healthAt! > now - 45000,
          "Renewal-capable node unavailable",
          409,
          "renewal_node_unavailable",
        );
        check(
          r.expiresAt! + hours * 3600000 <= now + 720 * 3600000,
          "Order duration limit",
          400,
          "renewal_limit",
        );
        const cost = BigInt(r.hourlyPrice) * BigInt(r.cards) * BigInt(hours);
        check(
          BigInt(r.amount) + cost <= BigInt(Number.MAX_SAFE_INTEGER),
          "Amount overflow",
        );
        if (r.reservationId) {
          const quote = this.store.get<{ amount: number }>(
            "SELECT amount FROM rental_reservations WHERE id=?",
            r.reservationId,
          )!;
          check(
            BigInt(quote.amount) + cost <= BigInt(Number.MAX_SAFE_INTEGER),
            "Amount overflow",
          );
        }
        amount = Number(cost);
        const user = this.store.user(userId)!;
        check(
          !this.store.paymentReview(userId) &&
            this.store.available(userId) >= amount &&
            user.paymentDebt === 0,
          "Insufficient balance",
          402,
          "insufficient_balance",
        );
        expiresAt = r.expiresAt! + hours * 3600000;
        const spec = JSON.parse(d.spec);
        this.reservations.guard(
          d.serverId,
          spec.gpuUuids,
          spec.endpointPort,
          expiresAt,
          r.reservationId ?? undefined,
        );
        revision++;
        this.store.run(
          "UPDATE users SET balance=balance-? WHERE id=?",
          amount,
          userId,
        );
        this.ledger(
          r,
          "compute",
          amount,
          {
            orderId: r.id,
            cards: r.cards,
            hours,
            hourlyPrice: r.hourlyPrice,
            renewal: true,
          },
          "rental:" + r.id + ":renew:" + id,
        );
        this.store.run(
          "UPDATE rental_orders SET hours=hours+?,amount=amount+?,charged=charged+?,expiresAt=?,expiryRevision=? WHERE id=?",
          hours,
          amount,
          amount,
          expiresAt,
          revision,
          r.id,
        );
        if (r.reservationId) {
          this.store.run(
            "UPDATE rental_orders SET scheduledEnd=? WHERE id=?",
            expiresAt,
            r.id,
          );
          this.store.run(
            "UPDATE rental_reservations SET endsAt=?,hours=hours+?,amount=amount+? WHERE id=?",
            expiresAt,
            hours,
            amount,
            r.reservationId,
          );
        }
      } else {
        if (r.reservationId)
          this.store.run(
            "UPDATE rental_reservations SET cancelActorId=COALESCE(cancelActorId,?) WHERE id=?",
            userId,
            r.reservationId,
          );
        infra.stopReserved(r.deploymentId);
      }
      this.store.run(
        "INSERT INTO rental_actions(id,userId,orderId,requestKey,fingerprint,kind,hours,amount,status,revision,expiresAt,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        userId,
        r.id,
        key,
        fingerprint,
        kind,
        hours,
        amount,
        kind === "renew" ? "pending" : "succeeded",
        revision,
        expiresAt,
        now,
      );
      return this.actionResult(
        this.store.get<Action>("SELECT * FROM rental_actions WHERE id=?", id)!,
        this.row(r.deploymentId)!,
      );
    });
    if (kind === "cancel") infra.advanceStops();
    return result;
  }
  orders(userId: string) {
    return this.store
      .all<Row>(
        "SELECT * FROM rental_orders WHERE userId=? ORDER BY createdAt DESC",
        userId,
      )
      .map((r) => this.project(r));
  }
  offers(
    infra: Infrastructure,
    controlHost: string,
    window: Window = {
      start: Date.now(),
      end: Date.now() + SETUP_MS + 3600000,
    },
  ) {
    const offers: RentalOffer[] = [];
    for (const n of infra.servers()) {
      const row = infra.node(n.id),
        caps = JSON.parse(row.capabilities),
        host = new URL(n.inferenceHost);
      if (
        n.workMode !== "gpu-rental" ||
        !n.rentalSalesEnabled ||
        n.hourlyPrice <= 0 ||
        n.status !== "online" ||
        !n.schedulingEnabled ||
        n.maintenance ||
        !caps.dockerReady ||
        caps.expirySupported !== true ||
        !caps.workspaceReady ||
        !/^sha256:[a-f0-9]{64}$/.test(caps.workspaceImageDigest || "") ||
        n.inventoryError ||
        host.hostname === controlHost ||
        (process.env.NODE_ENV === "production" && host.protocol !== "https:") ||
        !process.env[caps.workspaceKeyEnv] ||
        process.env[caps.workspaceKeyEnv]!.length < 32
      )
        continue;
      if (this.reservations.availablePort(n, window) === null) continue;
      const groups = new Map<string, typeof n.gpus>();
      for (const gpu of this.reservations.availableGpus(n, window)) {
        const key = JSON.stringify([gpu.name, gpu.totalMemoryMiB]);
        groups.set(key, [...(groups.get(key) || []), gpu]);
      }
      for (const [key, gpus] of groups)
        offers.push({
          id: n.id + "." + digest(key).slice(0, 16),
          name: n.name,
          region: n.region,
          gpuName: gpus[0].name,
          memoryMiB: gpus[0].totalMemoryMiB,
          availableCards: gpus.length,
          hourlyPrice: n.hourlyPrice,
        });
    }
    return offers;
  }
  purchase(
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
          10_000_000_000,
        ),
        fingerprint = digest(
          JSON.stringify({ offerId, cards, hours, expectedHourlyPrice }),
        );
      const previous = this.store.get<Row>(
        "SELECT * FROM rental_orders WHERE userId=? AND requestKey=?",
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
      const window = {
        start: Date.now(),
        end: Date.now() + SETUP_MS + hours * 3600000,
      };
      const offer = this.offers(infra, controlHost, window).find(
        (o) => o.id === offerId,
      );
      check(offer, "Offer unavailable", 409, "offer_unavailable");
      check(
        offer.hourlyPrice === expectedHourlyPrice,
        "Price changed",
        409,
        "rental_price_changed",
      );
      check(
        offer.availableCards >= cards,
        "GPU unavailable",
        409,
        "gpu_unavailable",
      );
      const amountBig =
        BigInt(offer.hourlyPrice) * BigInt(cards) * BigInt(hours);
      check(amountBig <= BigInt(Number.MAX_SAFE_INTEGER), "Amount overflow");
      const amount = Number(amountBig),
        user = this.store.user(userId)!;
      check(
        !this.store.paymentReview(userId) &&
          this.store.available(userId) >= amount &&
          user.paymentDebt === 0,
        "Insufficient balance",
        402,
        "insufficient_balance",
      );
      const serverId = offer.id.split(".")[0],
        node = infra.server(infra.node(serverId)),
        gpus = this.reservations
          .availableGpus(node, window)
          .filter(
            (g) =>
              !g.allocated &&
              !g.externalBusy &&
              !g.missing &&
              g.name === offer.gpuName &&
              g.totalMemoryMiB === offer.memoryMiB,
          )
          .slice(0, cards);
      const deployment = infra.createReserved(
          {
            serverId,
            ownerEmail: user.email,
            workloadType: "gpu-rental",
            gpuUuids: gpus.map((g) => g.uuid),
          },
          userId,
          "paid-" + randomUUID(),
          { endAt: window.end },
        ),
        id = randomUUID();
      this.store.run(
        "INSERT INTO rental_orders(id,userId,deploymentId,offerId,resource,cards,hours,hourlyPrice,amount,reserved,status,createdAt,requestKey,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,'provisioning',?,?,?)",
        id,
        userId,
        deployment.id,
        offerId,
        offer.gpuName,
        cards,
        hours,
        offer.hourlyPrice,
        amount,
        amount,
        Date.now(),
        key,
        fingerprint,
      );
      return this.project(this.row(deployment.id)!);
    });
  }
  activate(deploymentId: string) {
    const r = this.row(deploymentId);
    if (!r) return true;
    if (r.status === "active") return r.expiresAt! > Date.now();
    if (r.status !== "provisioning") return false;
    if (
      r.scheduledStart !== null &&
      Date.now() >= Math.min(r.scheduledStart + SETUP_MS, r.scheduledEnd!)
    )
      return false;
    if (r.startedAt !== null) return r.expiresAt! > Date.now();
    const now = Date.now(),
      expires = r.scheduledEnd ?? now + r.hours * 3600000;
    this.store.run(
      "UPDATE rental_orders SET startedAt=?,expiresAt=? WHERE id=? AND startedAt IS NULL",
      now,
      expires,
      r.id,
    );
    if (r.scheduledEnd !== null) {
      const seconds = Math.ceil((expires - now) / 1000),
        amount = Number(
          (BigInt(r.hourlyPrice) * BigInt(r.cards) * BigInt(seconds) + 3599n) /
            3600n,
        );
      this.store.run(
        "UPDATE rental_orders SET amount=? WHERE id=?",
        amount,
        r.id,
      );
    }
    return true;
  }
  charge(r: Row) {
    this.store.run(
      "UPDATE users SET balance=balance-? WHERE id=?",
      r.amount,
      r.userId,
    );
    this.ledger(r, "compute", r.amount, {
      cards: r.cards,
      hours: r.hours,
      hourlyPrice: r.hourlyPrice,
      ...(r.reservationId
        ? { chargedSeconds: Math.ceil((r.expiresAt! - r.startedAt!) / 1000) }
        : {}),
    });
    this.store.run(
      "UPDATE rental_orders SET status='active',charged=amount,reserved=0 WHERE id=? AND status='provisioning'",
      r.id,
    );
    if (r.reservationId)
      this.store.run(
        "UPDATE rental_reservations SET status='active' WHERE id=?",
        r.reservationId,
      );
  }

  ledger(
    r: Row,
    type: "compute" | "compute_refund",
    amount: number,
    metadata: Record<string, unknown>,
    reference = "rental:" + r.id + ":" + type,
  ) {
    this.store.run(
      "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day,reference,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)",
      randomUUID(),
      r.userId,
      type,
      r.resource,
      "",
      amount,
      new Date().toISOString(),
      day(),
      reference,
      JSON.stringify({ orderId: r.id, ...metadata }),
    );
  }
  stopRequested(deploymentId: string) {
    const r = this.row(deploymentId);
    if (!r) return;
    if (r.reservationId)
      this.store.run(
        "UPDATE rental_reservations SET status='stopping' WHERE id=? AND status IN ('starting','active')",
        r.reservationId,
      );
    const pending = this.pending(r.id);
    this.store.run(
      "UPDATE rental_actions SET status='failed' WHERE orderId=? AND kind='renew' AND status='pending'",
      r.id,
    );
    if (r.status === "provisioning")
      this.store.run(
        "UPDATE rental_orders SET status='failed',reserved=0,stopRequestedAt=? WHERE id=?",
        Date.now(),
        r.id,
      );
    else if (r.status === "active")
      this.store.run(
        "UPDATE rental_orders SET status='stopping',stopRequestedAt=? WHERE id=?",
        Math.min(
          Date.now(),
          r.expiresAt!,
          pending ? (r.confirmedExpiresAt ?? r.expiresAt!) : r.expiresAt!,
        ),
        r.id,
      );
  }
  stopped(deploymentId: string) {
    const r = this.row(deploymentId);
    if (!r || r.closedAt !== null) return;
    if (r.reservationId)
      this.store.run(
        "UPDATE rental_reservations SET status=CASE WHEN ?!=0 THEN 'completed' WHEN cancelActorId IS NOT NULL THEN 'canceled' ELSE 'failed' END,closedAt=?,errorCode=CASE WHEN ?=0 AND cancelActorId IS NULL THEN 'reservation_delivery_failed' ELSE NULL END WHERE id=?",
        r.charged,
        Date.now(),
        r.charged,
        r.reservationId,
      );
    if (r.charged) {
      const seconds = Math.max(
        0,
        Math.min(
          r.hours * 3600,
          Math.ceil(((r.stopRequestedAt ?? Date.now()) - r.startedAt!) / 1000),
        ),
      );
      const consumed = Number(
          (BigInt(r.hourlyPrice) * BigInt(r.cards) * BigInt(seconds) + 3599n) /
            3600n,
        ),
        refund = r.charged - consumed;
      if (refund > 0) {
        this.store.run(
          "UPDATE users SET balance=balance+? WHERE id=?",
          refund,
          r.userId,
        );
        this.ledger(r, "compute_refund", -refund, {
          cards: r.cards,
          hours: r.hours,
          hourlyPrice: r.hourlyPrice,
          chargedSeconds: seconds,
        });
      }
      this.store.run(
        "UPDATE rental_orders SET status='completed',refunded=?,closedAt=?,reserved=0 WHERE id=?",
        refund,
        Date.now(),
        r.id,
      );
    } else
      this.store.run(
        "UPDATE rental_orders SET status='failed',closedAt=?,reserved=0 WHERE id=?",
        Date.now(),
        r.id,
      );
  }
  canAccess(deploymentId: string) {
    const r = this.row(deploymentId);
    return (
      !r ||
      (r.status === "active" &&
        r.expiresAt! > Date.now() &&
        r.confirmedExpiresAt! > Date.now() &&
        r.expiryAcknowledgedAt !== null)
    );
  }
  deadlines(serverId: string) {
    return this.store
      .all<{
        deploymentId: string;
        expiresAt: number;
        stopRequestedAt: number | null;
        expiryRevision: number;
      }>(
        "SELECT o.deploymentId,o.expiresAt,o.stopRequestedAt,o.expiryRevision FROM rental_orders o JOIN deployments d ON d.id=o.deploymentId WHERE d.serverId=? AND o.expiresAt IS NOT NULL AND o.closedAt IS NULL",
        serverId,
      )
      .map((r) => ({
        deploymentId: r.deploymentId,
        revision: r.expiryRevision,
        expiresAt: iso(Math.min(r.expiresAt, r.stopRequestedAt ?? r.expiresAt)),
      }));
  }
  acknowledge(serverId: string, acks: unknown) {
    if (acks === undefined) return;
    check(
      Array.isArray(acks) && acks.length <= 256,
      "Invalid expiry acknowledgements",
    );
    for (const ack of acks) {
      check(
        ack &&
          typeof ack === "object" &&
          typeof ack.deploymentId === "string" &&
          typeof ack.expiresAt === "string" &&
          (ack.revision === undefined ||
            (Number.isSafeInteger(ack.revision) && ack.revision >= 0)),
        "Invalid expiry acknowledgement",
      );
      const r = this.row(ack.deploymentId);
      if (
        r &&
        r.expiresAt !== null &&
        (ack.revision ?? 0) === r.expiryRevision &&
        (r.expiryRevision === 0 ||
          JSON.parse(
            this.store.get<{ capabilities: string }>(
              "SELECT capabilities FROM servers WHERE id=?",
              serverId,
            )!.capabilities,
          ).renewalSupported === true) &&
        Date.parse(ack.expiresAt) === r.expiresAt &&
        this.store.get(
          "SELECT 1 FROM deployments WHERE id=? AND serverId=?",
          r.deploymentId,
          serverId,
        )
      ) {
        if (
          r.status === "provisioning" &&
          (r.scheduledStart === null ||
            Date.now() < r.scheduledStart + SETUP_MS) &&
          r.expiresAt > Date.now() &&
          this.store.get(
            "SELECT 1 FROM deployments WHERE id=? AND phase='ready' AND desiredState='running' AND healthAt>?",
            r.deploymentId,
            Date.now() - 45000,
          )
        )
          this.charge(r);
        this.store.run(
          "UPDATE rental_orders SET expiryAcknowledgedAt=?,confirmedExpiresAt=expiresAt WHERE id=? AND status IN ('provisioning','active') AND EXISTS(SELECT 1 FROM deployments WHERE id=deploymentId AND desiredState='running' AND phase='ready' AND healthAt>?)",
          Date.now(),
          r.id,
          Date.now() - 45000,
        );
        if (
          this.row(r.deploymentId)!.confirmedExpiresAt === r.expiresAt &&
          r.expiresAt > Date.now()
        )
          this.store.run(
            "UPDATE rental_actions SET status='succeeded' WHERE orderId=? AND revision=? AND kind='renew' AND status='pending'",
            r.id,
            r.expiryRevision,
          );
      }
    }
  }
  tick(infra: Infrastructure) {
    this.reservations.tick(infra);
    for (const r of this.store.all<{ deploymentId: string }>(
      "SELECT o.deploymentId FROM rental_orders o JOIN deployments d ON d.id=o.deploymentId WHERE o.status IN ('stopping','failed') AND o.closedAt IS NULL AND d.phase='failed' AND NOT EXISTS(SELECT 1 FROM deployment_jobs j WHERE j.deploymentId=d.id AND j.kind='stop' AND j.createdAt>?)",
      Date.now() - 60000,
    ))
      infra.stop(r.deploymentId, true);
    for (const r of this.store.all<Row>(
      "SELECT * FROM rental_orders o WHERE (status='active' AND (expiresAt<=? OR (confirmedExpiresAt<=? AND EXISTS(SELECT 1 FROM rental_actions a WHERE a.orderId=o.id AND a.kind='renew' AND a.status='pending')))) OR (status='provisioning' AND createdAt<=?)",
      Date.now(),
      Date.now(),
      Date.now() - 20 * 60000,
    ))
      infra.stop(r.deploymentId);
  }
}
