import Stripe from "stripe";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { digest } from "./auth.ts";
import { check, day, HttpError, int, object } from "./validation.ts";
import type { Store, UserRow } from "./store.ts";
import { MICRO } from "../src/domain.ts";
import type { PaymentOrder } from "../src/domain.ts";
import { locales, translate } from "../src/i18n/messages.ts";
import type { Locale } from "../src/i18n/messages.ts";
export type StripeConfig = {
  client: Stripe;
  origin: string;
  webhookSecret: string;
  liveMode: boolean;
};
export function stripeFromEnv(
  env: NodeJS.ProcessEnv,
): StripeConfig | undefined {
  if (!env.STRIPE_SECRET_KEY) return;
  const mode = env.STRIPE_MODE || "test";
  check(
    ["test", "live"].includes(mode) &&
      new RegExp(`^(sk|rk)_${mode}_[a-zA-Z0-9]+$`).test(env.STRIPE_SECRET_KEY),
    "Stripe mode/key mismatch",
  );
  check(
    env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_"),
    "Stripe webhook secret required",
  );
  const url = new URL(env.PUBLIC_ORIGIN || "");
  check(
    url.href === url.origin + "/" &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (env.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))),
    "Stripe requires fixed PUBLIC_ORIGIN and production HTTPS",
  );
  return {
    client: new Stripe(env.STRIPE_SECRET_KEY, {
      timeout: 5000,
      maxNetworkRetries: 1,
    }),
    origin: url.origin,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET!,
    liveMode: mode === "live",
  };
}
type Row = {
  id: string;
  userId: string;
  requestKey: string;
  fingerprint: string;
  amount: number;
  currency: string;
  locale: Locale;
  state: "creating" | "open" | "paid" | "expired" | "failed";
  sessionId: string | null;
  paymentIntentId: string | null;
  chargeId: string | null;
  checkoutUrl: string | null;
  credited: number;
  refunded: number;
  lostAmount: number;
  reversed: number;
  review: number;
  disputeId: string | null;
  disputeStatus: string | null;
  reviewAt: number;
  createdAt: number;
  expiresAt: number;
  checkedAt: number | null;
};
const reference = (value: unknown): string | null =>
  typeof value === "string"
    ? value
    : value && typeof value === "object" && "id" in value
      ? String(value.id)
      : null;
export class Payments {
  store: Store;
  config?: StripeConfig;
  creating = new Map<string, Promise<PaymentOrder>>();
  processing = new Map<string, { fingerprint: string; task: Promise<void> }>();
  constructor(store: Store, config?: StripeConfig) {
    this.store = store;
    this.config = config;
  }
  row(id: string) {
    return this.store.get<Row>("SELECT * FROM payment_orders WHERE id=?", id);
  }
  project(r: Row, admin = false): PaymentOrder {
    const pendingRefund = !!this.store.get(
      "SELECT id FROM payment_refunds WHERE orderId=? AND status IN ('pending','requires_action') LIMIT 1",
      r.id,
    );
    return {
      id: r.id,
      amount: r.amount,
      credited: r.credited,
      reversed: r.reversed,
      review: !!r.review,
      status: r.credited
        ? pendingRefund
          ? "refund_pending"
          : r.reversed === r.amount
            ? "refunded"
            : r.reversed
              ? "partially_refunded"
              : "paid"
        : r.expiresAt <= Date.now() && r.state !== "failed"
          ? "expired"
          : r.state,
      createdAt: new Date(r.createdAt).toISOString(),
      expiresAt: new Date(r.expiresAt).toISOString(),
      checkedAt: r.checkedAt ? new Date(r.checkedAt).toISOString() : null,
      checkoutUrl:
        !admin && !r.credited && r.state === "open" && r.expiresAt > Date.now()
          ? r.checkoutUrl
          : null,
      ...(admin ? { email: this.store.user(r.userId)!.email } : {}),
    };
  }
  list(userId: string | null, before: unknown) {
    const cursor =
      before == null
        ? Number.MAX_SAFE_INTEGER
        : int(Number(before), "before", 1, Number.MAX_SAFE_INTEGER);
    const rows = this.store.all<Row & { cursor: number }>(
      `SELECT rowid cursor,* FROM payment_orders WHERE rowid<? ${userId ? "AND userId=?" : ""} ORDER BY rowid DESC LIMIT 51`,
      cursor,
      ...(userId ? [userId] : []),
    );
    const more = rows.length > 50;
    return {
      data: rows.slice(0, 50).map((r) => this.project(r, !userId)),
      nextCursor: more ? rows[49].cursor : null,
    };
  }
  async checkout(user: UserRow, key: string, data: Record<string, unknown>) {
    check(this.config, "Stripe is not configured", 503, "payment_unavailable");
    const amount = int(data.amount, "amount", 10 * MICRO, 100000 * MICRO),
      locale = data.locale ?? "zh-CN";
    check(
      amount % 10000 === 0,
      "CNY requires whole cents",
      400,
      "invalid_payment_amount",
      { field: "amount" },
    );
    check(
      locales.includes(locale as Locale),
      "Unsupported locale",
      400,
      "unsupported_locale",
      { field: "locale" },
    );
    const fingerprint = digest(JSON.stringify({ amount, currency: "cny" }));
    let row = this.store.get<Row>(
      "SELECT * FROM payment_orders WHERE userId=? AND requestKey=?",
      user.id,
      key,
    );
    if (row)
      check(
        row.fingerprint === fingerprint,
        "Payment request conflict",
        409,
        "idempotency_conflict",
      );
    else {
      this.store.limit(`payment:create:${user.id}`, 10, 60000);
      const id = randomUUID(),
        created = Date.now();
      this.store.run(
        "INSERT INTO payment_orders(id,userId,requestKey,fingerprint,amount,locale,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?,?)",
        id,
        user.id,
        key,
        fingerprint,
        amount,
        locale as Locale,
        created,
        created + 3600000,
      );
      row = this.row(id)!;
    }
    if (row.sessionId || row.credited || row.state !== "creating")
      return this.project(row);
    check(
      Date.now() - row.createdAt < 15 * 60000,
      "Checkout creation window elapsed; create a new payment",
      409,
      "payment_creation_expired",
    );
    const pending = this.creating.get(row.id);
    if (pending) return pending;
    check(
      this.creating.size < 8,
      "Payment service busy",
      503,
      "payment_unavailable",
    );
    const task = this.create(row, user.email);
    this.creating.set(row.id, task);
    try {
      return await task;
    } finally {
      this.creating.delete(row.id);
    }
  }
  private async create(r: Row, email: string) {
    const { client, origin } = this.config!,
      metadata = { cm_order: r.id, cm_user: r.userId };
    let session: Stripe.Checkout.Session;
    try {
      session = await client.checkout.sessions.create(
        {
          mode: "payment",
          allowed_payment_method_types: ["card"],
          adaptive_pricing: { enabled: false },
          ui_mode: "hosted_page",
          customer_email: email,
          client_reference_id: r.id,
          metadata,
          payment_intent_data: { metadata },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "cny",
                unit_amount: r.amount / 10000,
                product_data: {
                  name: translate(r.locale, "payment.providerCredit"),
                },
              },
            },
          ],
          locale: (
            {
              "zh-CN": "zh",
              "en-US": "en",
              "ja-JP": "ja",
              "ko-KR": "ko",
            } as const
          )[r.locale],
          expires_at: Math.floor(r.expiresAt / 1000),
          success_url: origin + "/#/user/wallet?payment=" + r.id,
          cancel_url: origin + "/#/user/wallet?payment=" + r.id,
        },
        { idempotencyKey: "cm_checkout_" + r.id },
      );
    } catch {
      throw new HttpError(
        503,
        "Unable to confirm Checkout creation; retry the same key",
        "payment_unknown",
      );
    }
    this.validateSession(r, session);
    const url = this.checkoutUrl(session);
    this.store.transaction(() => {
      const current = this.row(r.id)!;
      check(
        !current.sessionId || current.sessionId === session.id,
        "Session conflict",
        409,
        "payment_mismatch",
      );
      this.store.run(
        "UPDATE payment_orders SET sessionId=?,checkoutUrl=?,state=CASE WHEN credited>0 THEN 'paid' ELSE ? END WHERE id=?",
        session.id,
        url,
        session.status === "expired" ? "expired" : "open",
        r.id,
      );
    });
    return this.project(this.row(r.id)!);
  }
  private checkoutUrl(s: Stripe.Checkout.Session) {
    if (s.status !== "open" || !s.url) return null;
    const url = new URL(s.url);
    check(
      url.origin === "https://checkout.stripe.com" &&
        !url.username &&
        !url.password,
      "Invalid checkout URL",
      502,
      "payment_mismatch",
    );
    return url.href;
  }
  private validateSession(r: Row, s: Stripe.Checkout.Session) {
    check(
      /^cs_[a-zA-Z0-9_]+$/.test(s.id) &&
        (!r.sessionId || r.sessionId === s.id) &&
        s.livemode === this.config!.liveMode &&
        s.mode === "payment" &&
        s.client_reference_id === r.id &&
        s.metadata?.cm_order === r.id &&
        s.metadata?.cm_user === r.userId &&
        s.currency === "cny" &&
        s.amount_total === r.amount / 10000 &&
        s.amount_subtotal === s.amount_total &&
        s.expires_at === Math.floor(r.expiresAt / 1000),
      "Payment session mismatch",
      409,
      "payment_mismatch",
    );
  }
  async webhook(req: IncomingMessage) {
    check(this.config, "Stripe is not configured", 503, "payment_unavailable");
    check(
      req.headers["content-type"]?.split(";")[0] === "application/json",
      "JSON required",
      415,
    );
    check(
      Number(req.headers["content-length"] || 0) <= 262144,
      "Webhook too large",
      413,
    );
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
      size += part.length;
      check(size <= 262144, "Webhook too large", 413);
      parts.push(Buffer.from(part));
    }
    const raw = Buffer.concat(parts),
      signature = req.headers["stripe-signature"];
    let event: Stripe.Event;
    try {
      check(typeof signature === "string", "Missing signature");
      event = this.config.client.webhooks.constructEvent(
        raw,
        signature,
        this.config.webhookSecret,
      );
    } catch {
      throw new HttpError(
        400,
        "Invalid Stripe signature",
        "invalid_payment_signature",
      );
    }
    check(
      event.livemode === this.config.liveMode && !event.account,
      "Wrong Stripe account or mode",
      400,
      "payment_mismatch",
    );
    const fingerprint = digest(raw.toString("utf8"));
    if (this.seen(event.id, fingerprint)) return;
    const pending = this.processing.get(event.id);
    if (pending) {
      check(
        pending.fingerprint === fingerprint,
        "Event conflict",
        409,
        "idempotency_conflict",
      );
      return pending.task;
    }
    check(
      this.processing.size < 8,
      "Payment service busy",
      503,
      "payment_unavailable",
    );
    const task = this.processEvent(event, fingerprint);
    this.processing.set(event.id, { fingerprint, task });
    try {
      await task;
    } finally {
      this.processing.delete(event.id);
    }
  }
  private async processEvent(event: Stripe.Event, fingerprint: string) {
    const value = object(event.data.object),
      type = event.type;
    let row: Row | undefined,
      sessionId: string | null = null,
      dispute: Stripe.Dispute | undefined;
    if (
      [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "checkout.session.expired",
      ].includes(type)
    ) {
      row =
        this.store.get<Row>(
          "SELECT * FROM payment_orders WHERE sessionId=?",
          String(value.id),
        ) || this.row(String(object(value.metadata ?? {}).cm_order));
      sessionId = String(value.id);
    } else if (
      type === "charge.refunded" ||
      ["refund.created", "refund.updated", "refund.failed"].includes(type) ||
      type.startsWith("charge.dispute.")
    ) {
      const chargeId =
        type === "charge.refunded" ? String(value.id) : reference(value.charge);
      check(chargeId, "Charge required", 400, "payment_mismatch");
      row = this.store.get<Row>(
        "SELECT * FROM payment_orders WHERE chargeId=?",
        chargeId,
      );
      if (!row) {
        const charge = await this.remote(() =>
          this.config!.client.charges.retrieve(chargeId),
        );
        const piId = reference(charge.payment_intent);
        if (piId) {
          row = this.store.get<Row>(
            "SELECT * FROM payment_orders WHERE paymentIntentId=?",
            piId,
          );
          if (!row) {
            const pi = await this.remote(() =>
              this.config!.client.paymentIntents.retrieve(piId),
            );
            row = this.row(pi.metadata.cm_order || "");
          }
        }
      }
      if (row) {
        if (type.startsWith("charge.dispute."))
          dispute = await this.remote(() =>
            this.config!.client.disputes.retrieve(String(value.id)),
          );
        sessionId = row.sessionId;
        if (!sessionId) {
          const charge = await this.remote(() =>
            this.config!.client.charges.retrieve(chargeId),
          );
          const piId = reference(charge.payment_intent);
          check(piId, "Intent required", 409, "payment_mismatch");
          const list = await this.remote(() =>
            this.config!.client.checkout.sessions.list({
              payment_intent: piId,
              limit: 2,
            }),
          );
          check(
            list.data.length === 1 && !list.has_more,
            "Ambiguous Checkout",
            409,
            "payment_mismatch",
          );
          sessionId = list.data[0].id;
        }
      }
    }
    let session: Stripe.Checkout.Session | undefined;
    if (row && sessionId)
      session = await this.remote(() =>
        this.config!.client.checkout.sessions.retrieve(sessionId!, {
          expand: ["payment_intent.latest_charge"],
        }),
      );
    let refunds: Stripe.Refund[] = [];
    const pi = session?.payment_intent,
      charge = pi && typeof pi === "object" ? pi.latest_charge : null;
    if (
      row &&
      session?.payment_status === "paid" &&
      charge &&
      typeof charge === "object"
    ) {
      let after: string | undefined;
      // shortcut: 单笔最多核对 1,000 笔退款；超过后改用后台分页对账。
      while (true) {
        const page = await this.remote(() =>
          this.config!.client.refunds.list({
            charge: charge.id,
            limit: 100,
            ...(after ? { starting_after: after } : {}),
          }),
        );
        refunds.push(...page.data);
        check(
          refunds.length <= 1000,
          "Refund history requires manual reconciliation",
          503,
          "payment_unavailable",
        );
        if (!page.has_more) break;
        check(
          page.data.length > 0,
          "Invalid refund page",
          409,
          "payment_mismatch",
        );
        after = page.data.at(-1)!.id;
      }
    }
    this.store.transaction(() => {
      if (this.seen(event.id, fingerprint)) return;
      if (row && session) {
        row = this.row(row.id)!;
        this.settle(
          row,
          session,
          dispute,
          event.created,
          refunds,
          event.id,
          event.type,
        );
      }
      this.store.run(
        "INSERT INTO payment_events(id,type,fingerprint,orderId,receivedAt) VALUES(?,?,?,?,?)",
        event.id,
        type,
        fingerprint,
        row?.id ?? null,
        Date.now(),
      );
    });
  }
  private seen(id: string, fingerprint: string) {
    const old = this.store.get<{ fingerprint: string }>(
      "SELECT fingerprint FROM payment_events WHERE id=?",
      id,
    );
    if (old)
      check(
        old.fingerprint === fingerprint,
        "Event conflict",
        409,
        "idempotency_conflict",
      );
    return !!old;
  }
  private async remote<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw new HttpError(
        503,
        "Stripe reconciliation unavailable",
        "payment_unavailable",
      );
    }
  }
  private settle(
    r: Row,
    s: Stripe.Checkout.Session,
    dispute: Stripe.Dispute | undefined,
    eventTime: number,
    refunds: Stripe.Refund[],
    eventId: string,
    eventType: string,
  ) {
    this.validateSession(r, s);
    const paid = s.payment_status === "paid" && s.status === "complete";
    if (!paid) {
      check(!r.credited, "Paid session regressed", 409, "payment_mismatch");
      this.store.run(
        "UPDATE payment_orders SET sessionId=?,state=?,checkoutUrl=?,checkedAt=? WHERE id=?",
        s.id,
        r.state === "failed" ||
          eventType === "checkout.session.async_payment_failed"
          ? "failed"
          : s.status === "expired"
            ? "expired"
            : "open",
        this.checkoutUrl(s),
        Date.now(),
        r.id,
      );
      return;
    }
    const pi = s.payment_intent,
      charge = pi && typeof pi === "object" ? pi.latest_charge : null;
    check(
      pi && typeof pi === "object" && charge && typeof charge === "object",
      "Expanded charge required",
      409,
      "payment_mismatch",
    );
    check(
      pi.livemode === this.config!.liveMode &&
        pi.metadata?.cm_order === r.id &&
        pi.metadata.cm_user === r.userId &&
        pi.status === "succeeded" &&
        pi.currency === "cny" &&
        pi.amount === r.amount / 10000 &&
        pi.amount_received === r.amount / 10000 &&
        (!r.paymentIntentId || r.paymentIntentId === pi.id) &&
        (!r.chargeId || r.chargeId === charge.id) &&
        reference(charge.payment_intent) === pi.id &&
        charge.livemode === this.config!.liveMode &&
        charge.currency === "cny" &&
        charge.paid &&
        charge.captured &&
        charge.status === "succeeded" &&
        charge.amount === r.amount / 10000 &&
        charge.amount_captured === r.amount / 10000,
      "Paid charge mismatch",
      409,
      "payment_mismatch",
    );
    const reportedRefund =
      int(charge.amount_refunded, "refunded", 0, r.amount / 10000) * 10000;
    let listedRefunds = 0;
    const rank: Record<string, number> = {
      pending: 0,
      requires_action: 0,
      succeeded: 1,
      failed: 2,
      canceled: 2,
    };
    for (const refund of refunds) {
      check(
        reference(refund.charge) === charge.id &&
          refund.currency === "cny" &&
          typeof refund.status === "string" &&
          Object.hasOwn(rank, refund.status),
        "Refund mismatch",
        409,
        "payment_mismatch",
      );
      const amount =
        int(refund.amount, "refund amount", 1, r.amount / 10000) * 10000;
      listedRefunds += amount;
      const previous = this.store.get<{
        orderId: string;
        amount: number;
        status: string;
      }>("SELECT * FROM payment_refunds WHERE id=?", refund.id);
      check(
        !previous || (previous.orderId === r.id && previous.amount === amount),
        "Refund conflict",
        409,
        "payment_mismatch",
      );
      if (!previous)
        this.store.run(
          "INSERT INTO payment_refunds VALUES(?,?,?,?)",
          refund.id,
          r.id,
          amount,
          refund.status,
        );
      else if (rank[refund.status] >= rank[previous.status])
        this.store.run(
          "UPDATE payment_refunds SET status=? WHERE id=?",
          refund.status,
          refund.id,
        );
    }
    check(
      listedRefunds >= reportedRefund,
      "Incomplete refund history",
      409,
      "payment_mismatch",
    );
    const refunded = this.store.get<{ amount: number }>(
      "SELECT COALESCE(SUM(amount),0) amount FROM payment_refunds WHERE orderId=? AND status NOT IN ('failed','canceled')",
      r.id,
    )!.amount;
    check(
      refunded <= r.amount,
      "Refund amount overflow",
      409,
      "payment_mismatch",
    );
    let lostAmount = r.lostAmount,
      review = r.review,
      disputeId = r.disputeId,
      disputeStatus = r.disputeStatus,
      reviewAt = r.reviewAt;
    if (charge.disputed && !disputeId) review = 1;
    if (dispute) {
      check(
        reference(dispute.charge) === charge.id &&
          dispute.currency === "cny" &&
          (!disputeId || disputeId === dispute.id),
        "Dispute mismatch",
        409,
        "payment_mismatch",
      );
      const lost =
        dispute.status === "lost"
          ? int(dispute.amount, "disputed amount", 0, r.amount / 10000) * 10000
          : 0;
      const rank = (status: string | null) =>
        status === "won"
          ? 3
          : status === "lost"
            ? 2
            : status === "warning_closed" || status === "prevented"
              ? 1
              : 0;
      if (
        eventTime > reviewAt ||
        (eventTime === reviewAt && rank(dispute.status) >= rank(disputeStatus))
      ) {
        lostAmount =
          dispute.status === "lost"
            ? lost
            : dispute.status === "won"
              ? 0
              : lostAmount;
        disputeId = dispute.id;
        disputeStatus = dispute.status;
        review = ["won", "lost", "warning_closed", "prevented"].includes(
          dispute.status,
        )
          ? 0
          : 1;
        reviewAt = eventTime;
      }
    }
    const reversed = Math.min(r.amount, refunded + lostAmount),
      user = this.store.user(r.userId)!;
    check(
      BigInt(user.balance) +
        BigInt(r.credited ? 0 : r.amount) +
        BigInt(Math.max(0, r.reversed - reversed)) <=
        BigInt(Number.MAX_SAFE_INTEGER) &&
        BigInt(user.paymentDebt) + BigInt(reversed - r.reversed) <=
          BigInt(Number.MAX_SAFE_INTEGER),
      "Wallet overflow",
      409,
      "payment_mismatch",
    );
    if (!r.credited) {
      this.store.run(
        "UPDATE users SET balance=balance+? WHERE id=?",
        r.amount,
        r.userId,
      );
      this.ledger(r, "recharge", r.amount, "stripe:credit:" + s.id, false);
    }
    if (reversed !== r.reversed) {
      const delta = reversed - r.reversed;
      if (delta > 0)
        this.store.run(
          "UPDATE users SET paymentDebt=paymentDebt+? WHERE id=?",
          delta,
          r.userId,
        );
      else {
        const debt = Math.min(this.store.user(r.userId)!.paymentDebt, -delta);
        this.store.run(
          "UPDATE users SET paymentDebt=paymentDebt-?,balance=balance+? WHERE id=?",
          debt,
          -delta - debt,
          r.userId,
        );
      }
      this.ledger(
        r,
        "recharge_refund",
        reversed - r.reversed,
        "stripe:adjust:" + eventId,
        lostAmount > r.lostAmount,
      );
    }
    this.store.run(
      "UPDATE payment_orders SET sessionId=?,paymentIntentId=?,chargeId=?,state='paid',checkoutUrl=NULL,credited=amount,refunded=?,lostAmount=?,reversed=?,review=?,disputeId=?,disputeStatus=?,reviewAt=?,checkedAt=? WHERE id=?",
      s.id,
      pi.id,
      charge.id,
      refunded,
      lostAmount,
      reversed,
      review,
      disputeId,
      disputeStatus,
      reviewAt,
      Date.now(),
      r.id,
    );
  }
  private ledger(
    r: Row,
    type: "recharge" | "recharge_refund",
    amount: number,
    reference: string,
    chargeback: boolean,
  ) {
    this.store.run(
      "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day,reference,metadata) VALUES(?,?,?,'Stripe','',?,?,?,?,?)",
      randomUUID(),
      r.userId,
      type,
      amount,
      new Date().toISOString(),
      day(),
      reference,
      JSON.stringify({
        paymentId: r.id,
        provider: "stripe",
        ...(chargeback ? { chargeback: true } : {}),
        ...(amount < 0 ? { restored: true } : {}),
      }),
    );
  }
}
