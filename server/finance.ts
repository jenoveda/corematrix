import { randomUUID } from "node:crypto";
import { check, int, requestKey, text } from "./validation.ts";
import type { Store } from "./store.ts";
import type { Expense, FinancialReport } from "../src/domain.ts";
import { CLEANUP_MS } from "./reservations.ts";
import { procurementCosts, procurementAmount } from "./providers.ts";
export const expenseCategories = [
  "equipment",
  "electricity",
  "bandwidth",
  "storage",
  "operations",
  "upstream",
  "other",
] as const;
export function dateOnly(value: unknown, field = "day") {
  const d = text(value, field, 10);
  check(
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
      Number.isFinite(Date.parse(d + "T00:00:00Z")) &&
      new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d,
    "Invalid date",
    400,
    "invalid_date",
    { field },
  );
  return d;
}
export function recordExpense(
  s: Store,
  actorId: string,
  data: Record<string, unknown>,
) {
  const category = text(data.category, "category", 30),
    amount = int(data.amount, "amount", 1, 100_000_000_000_000),
    day = dateOnly(data.day),
    reason = text(data.reason, "reason", 500),
    reference = requestKey(data.reference, "reference"),
    serverId = data.serverId ? text(data.serverId, "serverId", 100) : null;
  check(
    expenseCategories.includes(category as (typeof expenseCategories)[number]),
    "Invalid cost category",
    400,
    "invalid_option",
    { field: "category" },
  );
  return s.transaction(() => {
    const old = s.get<Expense>(
      "SELECT * FROM expenses WHERE reference=?",
      reference,
    );
    if (old) {
      check(
        old.category === category &&
          old.amount === amount &&
          old.day === day &&
          old.reason === reason &&
          old.serverId === serverId,
        "Expense reference conflict",
        409,
        "idempotency_conflict",
      );
      return old;
    }
    const node = serverId
      ? s.get<{ data: string }>("SELECT data FROM servers WHERE id=?", serverId)
      : undefined;
    check(!serverId || node, "Server not found", 404, "not_found");
    const id = randomUUID();
    s.run(
      "INSERT INTO expenses(id,category,amount,day,reason,reference,serverId,serverName,actorId,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id,
      category,
      amount,
      day,
      reason,
      reference,
      serverId,
      node ? JSON.parse(node.data).name : null,
      actorId,
      new Date().toISOString(),
    );
    return s.get<Expense>("SELECT * FROM expenses WHERE id=?", id)!;
  });
}
export function voidExpense(
  s: Store,
  actorId: string,
  id: string,
  data: Record<string, unknown>,
) {
  return s.transaction(() => {
    const row = s.get<Expense>("SELECT * FROM expenses WHERE id=?", id),
      reason = text(data.reason, "reason", 500);
    check(row, "Expense not found", 404, "not_found");
    if (row.voidedAt) {
      check(
        row.voidReason === reason,
        "Void reason conflict",
        409,
        "idempotency_conflict",
      );
      return row;
    }
    s.run(
      "UPDATE expenses SET voidedAt=?,voidReason=?,voidActorId=? WHERE id=?",
      new Date().toISOString(),
      reason,
      actorId,
      id,
    );
    return s.get<Expense>("SELECT * FROM expenses WHERE id=?", id)!;
  });
}
export function financeReport(
  s: Store,
  params: URLSearchParams,
): FinancialReport {
  const from = dateOnly(params.get("from"), "from"),
    to = dateOnly(params.get("to"), "to");
  check(
    from <= to && Date.parse(to) - Date.parse(from) <= 365 * 86400000,
    "Invalid date range",
    400,
    "invalid_date_range",
  );
  const before = params.has("before")
    ? int(Number(params.get("before")), "cursor", 1, Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
  const revenues = s.get<{
    revenue: number;
    tokenRevenue: number;
    gpuRevenue: number;
    credits: number;
  }>(
    `SELECT COALESCE(SUM(CASE WHEN type='token' THEN amount ELSE 0 END),0) tokenRevenue,COALESCE(SUM(CASE WHEN type IN ('compute','compute_refund') THEN amount ELSE 0 END),0) gpuRevenue,COALESCE(SUM(CASE WHEN type IN ('token','compute','compute_refund') THEN amount ELSE 0 END),0) revenue,COALESCE(SUM(CASE WHEN type='recharge' THEN amount WHEN type='recharge_refund' THEN -amount ELSE 0 END),0) credits FROM ledger WHERE day BETWEEN ? AND ?`,
    from,
    to,
  )!;
  const costs = s.get<{ cost: number; count: number }>(
    "SELECT COALESCE(SUM(amount),0) cost,COUNT(*) count FROM expenses WHERE day BETWEEN ? AND ? AND voidedAt IS NULL",
    from,
    to,
  )!;
  const supplier=procurementCosts(s,from,to);
  costs.cost+=supplier.cost; costs.count+=supplier.count;
  const rows = s.all<Expense & { cursor: number }>(
      "SELECT rowid cursor,* FROM expenses WHERE day BETWEEN ? AND ? AND rowid<? ORDER BY rowid DESC LIMIT 51",
      from,
      to,
      before,
    ),
    hasMore = rows.length > 50,
    expenses = rows.slice(0, 50);
  const daily = s.all<FinancialReport["daily"][number]>(
    `SELECT day,SUM(revenue) revenue,SUM(cost) cost FROM (SELECT day,amount revenue,0 cost FROM ledger WHERE type IN ('token','compute','compute_refund') AND day BETWEEN ? AND ? UNION ALL SELECT day,0 revenue,amount cost FROM expenses WHERE day BETWEEN ? AND ? AND voidedAt IS NULL) GROUP BY day ORDER BY day`,
    from,
    to,
    from,
    to,
  );
  for(const row of supplier.daily){
    const existing=daily.find(d=>d.day===row.day);
    if(existing) existing.cost+=row.cost; else daily.push({...row,revenue:0});
  }
  daily.sort((a,b)=>a.day.localeCompare(b.day));
  const byCategory=s.all<FinancialReport["byCategory"][number]>("SELECT category,SUM(amount) amount FROM expenses WHERE day BETWEEN ? AND ? AND voidedAt IS NULL GROUP BY category ORDER BY amount DESC",from,to);
  if(supplier.count) byCategory.push({category:"provider",amount:supplier.cost});
  return {
    from,
    to,
    ...revenues,
    byModel: s.all(
      "SELECT modelName name,SUM(amount) revenue,SUM(inputTokens) inputTokens,SUM(outputTokens) outputTokens FROM requests WHERE status='succeeded' AND day BETWEEN ? AND ? GROUP BY modelId ORDER BY revenue DESC",
      from,
      to,
    ),
    cost: costs.cost,
    costRecorded: costs.count > 0,
    profit: costs.count ? revenues.revenue - costs.cost : null,
    daily,
    byCategory,
    expenses: expenses.map(({ cursor: _, ...r }) => r),
    nextCursor: hasMore ? expenses.at(-1)!.cursor : null,
  };
}
export function reconcile(s: Store) {
  const issues: {
    code: string;
    entityId: string;
    expected: number;
    actual: number;
  }[] = [];
  for (const u of s.all<{
    id: string;
    balance: number;
    paymentDebt: number;
    expected: number;
  }>(
    `SELECT u.id,u.balance,u.paymentDebt,COALESCE(SUM(CASE WHEN l.type='recharge' THEN l.amount ELSE -l.amount END),0) expected FROM users u LEFT JOIN ledger l ON l.userId=u.id GROUP BY u.id`,
  )) {
    if (u.balance - u.paymentDebt !== u.expected)
      issues.push({
        code: "balance_mismatch",
        entityId: u.id,
        expected: u.expected,
        actual: u.balance - u.paymentDebt,
      });
    const held = s.held(u.id);
    if (u.paymentDebt)
      issues.push({
        code: "payment_debt",
        entityId: u.id,
        expected: 0,
        actual: u.paymentDebt,
      });
    if (held < 0 || held > u.balance)
      issues.push({
        code: "invalid_hold",
        entityId: u.id,
        expected: u.balance,
        actual: held,
      });
  }
  for (const p of s.all<{
    id: string;
    credited: number;
    reversed: number;
    actualCredit: number;
    actualReverse: number;
    review: number;
  }>(
    `SELECT p.id,p.credited,p.reversed,p.review,COALESCE(SUM(CASE WHEN l.type='recharge' THEN l.amount ELSE 0 END),0) actualCredit,COALESCE(SUM(CASE WHEN l.type='recharge_refund' THEN l.amount ELSE 0 END),0) actualReverse FROM payment_orders p LEFT JOIN ledger l ON l.userId=p.userId AND CASE WHEN json_valid(l.metadata) THEN json_extract(l.metadata,'$.paymentId') END=p.id GROUP BY p.id`,
  )) {
    if (p.credited !== p.actualCredit)
      issues.push({
        code: "payment_ledger_mismatch",
        entityId: p.id,
        expected: p.credited,
        actual: p.actualCredit,
      });
    if (p.reversed !== p.actualReverse)
      issues.push({
        code: "payment_ledger_mismatch",
        entityId: p.id,
        expected: p.reversed,
        actual: p.actualReverse,
      });
    if (p.review)
      issues.push({
        code: "payment_review",
        entityId: p.id,
        expected: 0,
        actual: 1,
      });
  }
  for (const r of s.all<{ id: string; amount: number; actual: number }>(
    `SELECT r.id,r.amount,COALESCE(SUM(l.amount),0) actual FROM requests r LEFT JOIN ledger l ON l.requestId=r.id AND l.type='token' WHERE r.status='succeeded' GROUP BY r.id HAVING COUNT(l.id)!=1 OR SUM(l.amount)!=r.amount OR MAX(l.userId)!=r.userId`,
  ))
    issues.push({
      code: "token_ledger_mismatch",
      entityId: r.id,
      expected: r.amount,
      actual: r.actual,
    });
  for (const r of s.all<{
    id: string;
    charged: number;
    refunded: number;
    actualCharge: number;
    actualRefund: number;
  }>(
    `SELECT r.id,r.charged,r.refunded,COALESCE(SUM(CASE WHEN l.type='compute' THEN l.amount ELSE 0 END),0) actualCharge,COALESCE(SUM(CASE WHEN l.type='compute_refund' THEN -l.amount ELSE 0 END),0) actualRefund FROM rental_orders r LEFT JOIN ledger l ON CASE WHEN json_valid(l.metadata) THEN json_extract(l.metadata,'$.orderId') END=r.id AND l.type IN ('compute','compute_refund') GROUP BY r.id HAVING actualCharge!=r.charged OR actualRefund!=r.refunded`,
  )) {
    if (r.charged !== r.actualCharge)
      issues.push({
        code: "rental_ledger_mismatch",
        entityId: r.id,
        expected: r.charged,
        actual: r.actualCharge,
      });
    if (r.refunded !== r.actualRefund)
      issues.push({
        code: "rental_ledger_mismatch",
        entityId: r.id,
        expected: r.refunded,
        actual: r.actualRefund,
      });
  }
  for (const l of s.all<{ id: string; amount: number }>(
    `SELECT l.id,l.amount FROM ledger l LEFT JOIN requests r ON r.id=l.requestId LEFT JOIN rental_orders o ON o.id=CASE WHEN json_valid(l.metadata) THEN json_extract(l.metadata,'$.orderId') END WHERE (l.type='token' AND (r.id IS NULL OR r.status!='succeeded')) OR (l.type IN ('compute','compute_refund') AND (o.id IS NULL OR o.userId!=l.userId))`,
  ))
    issues.push({
      code: "orphan_ledger",
      entityId: l.id,
      expected: 0,
      actual: l.amount,
    });
  for (const l of s.all<{ id: string; amount: number }>(
    `SELECT l.id,l.amount FROM ledger l LEFT JOIN payment_orders p ON p.id=CASE WHEN json_valid(l.metadata) THEN json_extract(l.metadata,'$.paymentId') END WHERE (l.type='recharge_refund' OR (l.type='recharge' AND CASE WHEN json_valid(l.metadata) THEN json_extract(l.metadata,'$.provider') END='stripe')) AND (p.id IS NULL OR p.userId!=l.userId)`,
  ))
    issues.push({
      code: "orphan_ledger",
      entityId: l.id,
      expected: 0,
      actual: l.amount,
    });
  for (const d of s.all<{ id: string; actual: number }>(
    `SELECT d.id,COUNT(g.uuid) actual FROM deployments d JOIN gpu_allocations g ON g.deploymentId=d.id AND g.released=0 WHERE d.phase='stopped' GROUP BY d.id`,
  ))
    issues.push({
      code: "stopped_gpu_allocated",
      entityId: d.id,
      expected: 0,
      actual: d.actual,
    });
  for (const r of s.all<{ id: string; actual: number; expected: number }>(
    "SELECT id,reserved actual,CASE WHEN status='booked' THEN amount ELSE 0 END expected FROM rental_reservations WHERE reserved!=CASE WHEN status='booked' THEN amount ELSE 0 END",
  ))
    issues.push({
      code: "reservation_hold_mismatch",
      entityId: r.id,
      expected: r.expected,
      actual: r.actual,
    });
  for (const r of s.all<{ id: string }>(
    `SELECT r.id FROM rental_reservations r LEFT JOIN rental_orders o ON o.id=r.orderId WHERE (r.status='booked' AND r.orderId IS NOT NULL) OR (r.status IN ('starting','active','stopping') AND r.orderId IS NULL) OR (r.orderId IS NOT NULL AND (o.id IS NULL OR o.reservationId IS NOT r.id OR o.userId!=r.userId OR o.resource IS NOT r.resource OR o.cards!=r.cards OR o.hours!=r.hours OR o.hourlyPrice!=r.hourlyPrice OR o.scheduledStart IS NOT r.startsAt OR o.scheduledEnd IS NOT r.endsAt)) OR NOT json_valid(r.gpuUuids)`,
  ))
    issues.push({
      code: "reservation_order_mismatch",
      entityId: r.id,
      expected: 1,
      actual: 0,
    });
  for (const r of s.all<{ id: string }>(
    `SELECT DISTINCT a.id FROM rental_reservations a JOIN rental_reservations b ON a.id<b.id AND a.startsAt<b.endsAt+? AND b.startsAt<a.endsAt+? WHERE a.status IN ('booked','starting','active','stopping') AND b.status IN ('booked','starting','active','stopping') AND ((a.serverId=b.serverId AND a.port=b.port) OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(a.gpuUuids) THEN a.gpuUuids ELSE '[]' END) ga JOIN json_each(CASE WHEN json_valid(b.gpuUuids) THEN b.gpuUuids ELSE '[]' END) gb ON ga.value=gb.value))`,
    CLEANUP_MS,
    CLEANUP_MS,
  ))
    issues.push({
      code: "reservation_overlap",
      entityId: r.id,
      expected: 0,
      actual: 1,
    });
  for (const g of s.all<{ uuid: string; actual: number }>(
    "SELECT uuid,COUNT(*) actual FROM gpu_allocations WHERE released=0 GROUP BY uuid HAVING COUNT(*)>1",
  ))
    issues.push({
      code: "duplicate_gpu_allocation",
      entityId: g.uuid,
      expected: 1,
      actual: g.actual,
    });
  for(const usage of s.all<{deploymentId:string;startedAt:number;endedAt:number|null;amount:number|null;ratePerGpuHour:number;gpuCount:number}>("SELECT * FROM provider_usage WHERE endedAt IS NOT NULL")) {
    const expected=procurementAmount(usage,usage.endedAt!);
    if(usage.amount!==expected) issues.push({code:"provider_procurement_amount",entityId:usage.deploymentId,expected,actual:usage.amount??0});
    if(s.get("SELECT 1 FROM gpu_allocations WHERE deploymentId=? AND released=0",usage.deploymentId)) issues.push({code:"provider_procurement_cleanup",entityId:usage.deploymentId,expected:0,actual:1});
  }
  for(const row of s.all<{id:string;amount:number;actual:number}>("SELECT p.id,p.amount,COALESCE(SUM(u.amount),0) actual FROM provider_settlements p LEFT JOIN provider_usage u ON u.settlementId=p.id AND u.providerId=p.providerId GROUP BY p.id")) {
    if(row.amount!==row.actual) issues.push({code:"provider_settlement_amount",entityId:row.id,expected:row.amount,actual:row.actual});
  }
  return {
    checkedAt: new Date().toISOString(),
    healthy: issues.length === 0,
    issues,
  };
}
