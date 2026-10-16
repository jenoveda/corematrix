import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createApplication } from "../server/app.ts";
import { secret, digest } from "../server/auth.ts";
import {
  recordExpense,
  voidExpense,
  financeReport,
  reconcile,
} from "../server/finance.ts";
import { Store } from "../server/store.ts";

test("cost API enforces admin/CSRF, immutable invoice idempotency and audited voiding", async (t) => {
  const app = createApplication({ databasePath: ":memory:" }),
    s = app.store,
    admin = s.createUser(
      "Admin",
      "finance-admin@tests.invalid",
      "unused",
      "admin",
    ),
    user = s.createUser("User", "finance-user@tests.invalid", "unused");
  const creds = new Map();
  for (const u of [admin, user]) {
    const token = secret(),
      csrf = secret();
    s.run(
      "INSERT INTO sessions VALUES(?,?,?,?)",
      digest(token),
      u.id,
      csrf,
      Date.now() + 100000,
    );
    creds.set(u.id, { Cookie: "cm_session=" + token, "X-CSRF-Token": csrf });
  }
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise<void>((r) => app.server.close(() => r()));
    s.close();
  });
  async function call(
    path: string,
    method = "GET",
    data?: unknown,
    who = admin.id,
    csrf = true,
  ) {
    const headers = { ...creds.get(who), "content-type": "application/json" };
    if (!csrf) delete headers["X-CSRF-Token"];
    const r = await fetch(
      `http://127.0.0.1:${(app.server.address() as any).port}` + path,
      { method, headers, ...(data ? { body: JSON.stringify(data) } : {}) },
    );
    return { status: r.status, data: (await r.json()) as any };
  }
  const body = {
    category: "electricity",
    day: "2026-10-15",
    amount: 1234567,
    reason: "Meter invoice",
    reference: "invoice-electricity-001",
    serverId: null,
  };
  for (const path of [
    "/api/admin/reports?from=2026-10-01&to=2026-10-31",
    "/api/admin/reconciliation",
  ])
    assert.equal((await call(path, "GET", undefined, user.id)).status, 403);
  assert.equal(
    (await call("/api/admin/costs", "POST", body, user.id)).status,
    403,
  );
  assert.equal(
    (await call("/api/admin/costs", "POST", body, admin.id, false)).status,
    403,
  );
  for (const patch of [
    { amount: -1 },
    { amount: 1.5 },
    { amount: 100000000000001 },
    { category: "gpu-percent" },
    { day: "2026-02-30" },
    { day: "bad-date" },
    { reason: "" },
    { reference: "short" },
    { serverId: "not-a-server" },
  ])
    assert.ok(
      [400, 404].includes(
        (await call("/api/admin/costs", "POST", { ...body, ...patch })).status,
      ),
    );
  const [a, b] = await Promise.all([
    call("/api/admin/costs", "POST", body),
    call("/api/admin/costs", "POST", body),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.data.expense.id, a.data.expense.id);
  assert.equal(s.all("SELECT * FROM expenses").length, 1);
  assert.equal(
    (await call("/api/admin/costs", "POST", { ...body, amount: 2 })).status,
    409,
  );
  const path = "/api/admin/costs/" + a.data.expense.id + "/void";
  assert.equal(
    (await call(path, "POST", { reason: "corrected" }, user.id)).status,
    403,
  );
  assert.equal(
    (await call(path, "POST", { reason: "corrected" }, admin.id, false)).status,
    403,
  );
  assert.equal((await call(path, "POST", { reason: "corrected" })).status, 200);
  assert.equal((await call(path, "POST", { reason: "corrected" })).status, 200);
  assert.equal((await call(path, "POST", { reason: "different" })).status, 409);
  const row = s.get<any>("SELECT * FROM expenses");
  assert.equal(row.amount, body.amount);
  assert.equal(row.voidActorId, admin.id);
  assert.equal(row.actorId, admin.id);
  assert.equal(row.voidReason, "corrected");
  assert.equal(s.all("SELECT * FROM ledger").length, 0);
  assert.equal(s.user(user.id)!.balance, 0);
  const report = await call("/api/admin/reports?from=2026-10-01&to=2026-10-31");
  assert.equal(report.status, 200);
  assert.equal(report.data.cost, 0);
  assert.equal(report.data.profit, null);
  assert.equal(report.data.expenses.length, 1);
  assert.ok(report.data.expenses[0].voidedAt);
  assert.equal(
    (await call("/api/admin/reports?from=2026-11-01&to=2026-10-01")).status,
    400,
  );
  assert.equal(
    (await call("/api/admin/reports?from=2024-01-01&to=2026-10-01")).status,
    400,
  );
  assert.equal((await call("/api/admin/reconciliation")).data.healthy, true);
});

test("period reports keep recharge out of revenue, include refunds and costs, and page every document once", () => {
  const s = new Store(":memory:");
  try {
    const u = s.createUser("A", "report@tests.invalid", "unused", "admin");
    for (const [type, amount, day] of [
      ["recharge", 100000000, "2026-10-01"],
      ["token", 10000000, "2026-10-02"],
      ["compute", 20000000, "2026-10-03"],
      ["compute_refund", -5000000, "2026-10-04"],
      ["token", 99000000, "2026-09-30"],
    ] as const)
      s.run(
        "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES(?,?,?,?,?,?,?,?)",
        randomUUID(),
        u.id,
        type,
        "Test",
        "",
        amount,
        day + "T00:00:00Z",
        day,
      );
    for (let i = 0; i < 55; i++)
      recordExpense(s, u.id, {
        category: i % 2 ? "electricity" : "equipment",
        amount: 1000000,
        day: "2026-10-02",
        reason: "Invoice " + i,
        reference: "invoice-" + i.toString().padStart(6, "0"),
      });
    for (const [id, day, amount] of [
      ["oct-token", "2026-10-02", 10000000],
      ["sep-token", "2026-09-30", 99000000],
    ] as const)
      s.run(
        "INSERT INTO requests(id,userId,requestKey,fingerprint,day,status,reserved,modelId,modelName,inputPrice,outputPrice,createdAt,amount,inputTokens,outputTokens) VALUES(?,?,?,'hash',?,'succeeded',0,'model','Historical name',1,1,'now',?,200,100)",
        id,
        u.id,
        id,
        day,
        amount,
      );
    const params = new URLSearchParams({
        from: "2026-10-01",
        to: "2026-10-31",
      }),
      r = financeReport(s, params);
    assert.equal(r.revenue, 25000000);
    assert.equal(r.tokenRevenue, 10000000);
    assert.equal(r.gpuRevenue, 15000000);
    assert.equal(r.credits, 100000000);
    assert.deepEqual(
      r.byModel.map((m) => ({ ...m })),
      [
        {
          name: "Historical name",
          revenue: 10000000,
          inputTokens: 200,
          outputTokens: 100,
        },
      ],
    );
    assert.equal(r.cost, 55000000);
    assert.equal(r.profit, -30000000);
    assert.equal(r.expenses.length, 50);
    assert.ok(r.nextCursor);
    assert.equal(
      r.daily.find((d) => d.day === "2026-10-04")!.revenue,
      -5000000,
    );
    assert.equal(r.daily.find((d) => d.day === "2026-10-02")!.cost, 55000000);
    params.set("before", String(r.nextCursor));
    const second = financeReport(s, params);
    assert.equal(second.expenses.length, 5);
    assert.equal(second.nextCursor, null);
    assert.equal(
      new Set([...r.expenses, ...second.expenses].map((e) => e.id)).size,
      55,
    );
    assert.equal(second.cost, r.cost);
    voidExpense(s, u.id, r.expenses[0].id, {
      reason: "Duplicate vendor invoice",
    });
    assert.equal(financeReport(s, params).cost, 54000000);
    assert.equal(financeReport(s, params).profit, -29000000);
  } finally {
    s.close();
  }
});

test("reconciliation detects inconsistencies without repairing money or releasing resources", () => {
  const s = new Store(":memory:");
  try {
    const u = s.createUser("A", "audit@tests.invalid", "unused");
    assert.equal(reconcile(s).healthy, true);
    s.run("UPDATE users SET balance=10000000 WHERE id=?", u.id);
    assert.ok(reconcile(s).issues.some((i) => i.code === "balance_mismatch"));
    s.run(
      "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES('credit',?,'recharge','manual','',10000000,'2026-10-15','2026-10-15')",
      u.id,
    );
    assert.equal(reconcile(s).healthy, true);
    s.run(
      "INSERT INTO requests(id,userId,requestKey,fingerprint,day,status,reserved,modelId,modelName,inputPrice,outputPrice,createdAt,amount) VALUES('r',?,'audit-request','hash','2026-10-15','succeeded',0,'model','Model',1,1,'now',1000)",
      u.id,
    );
    assert.ok(
      reconcile(s).issues.some((i) => i.code === "token_ledger_mismatch"),
    );
    s.run(
      "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day,requestId) VALUES('token',?,'token','Model','',1000,'now','2026-10-15','r')",
      u.id,
    );
    s.run("UPDATE users SET balance=balance-1000 WHERE id=?", u.id);
    assert.equal(reconcile(s).healthy, true);
    s.run("UPDATE requests SET status='failed',reserved=20000000 WHERE id='r'");
    assert.ok(reconcile(s).issues.some((i) => i.code === "orphan_ledger"));
    s.run("UPDATE requests SET status='pending' WHERE id='r'");
    assert.ok(reconcile(s).issues.some((i) => i.code === "invalid_hold"));
    const before = JSON.stringify(s.all("SELECT * FROM users"));
    reconcile(s);
    assert.equal(JSON.stringify(s.all("SELECT * FROM users")), before);
    assert.equal(s.all("SELECT * FROM ledger").length, 2);
  } finally {
    s.close();
  }
});

test("GPU audit compares charges and refunds separately and preserves stopped allocations", () => {
  const s = new Store(":memory:");
  try {
    const u = s.createUser("A", "gpu-audit@tests.invalid", "unused", "admin");
    s.run(
      "INSERT INTO servers(id,data,tokenHash) VALUES('n',?,?)",
      JSON.stringify({ name: "Original node" }),
      "node-audit",
    );
    const expense = recordExpense(s, u.id, {
      category: "equipment",
      day: "2026-10-15",
      amount: 5000000,
      reason: "Device lease",
      reference: "device-lease-001",
      serverId: "n",
    });
    s.run(
      "UPDATE servers SET data=? WHERE id='n'",
      JSON.stringify({ name: "Renamed node" }),
    );
    assert.equal(
      s.get<any>("SELECT * FROM expenses WHERE id=?", expense.id).serverName,
      "Original node",
    );
    s.run(
      "INSERT INTO deployments(id,serverId,modelId,phase,desiredState,spec,actorId,requestKey,fingerprint,createdAt,workloadType,ownerId) VALUES('d','n','__gpu-rental__','stopped','stopped','{}',?,'audit-deployment','hash',0,'gpu-rental',?)",
      u.id,
      u.id,
    );
    s.run(
      "INSERT INTO rental_orders(id,userId,deploymentId,offerId,resource,cards,hours,hourlyPrice,amount,reserved,status,createdAt,requestKey,fingerprint,charged,refunded) VALUES('o',?,'d','offer','GPU',1,1,100,100,0,'completed',0,'audit-order','hash',100,20)",
      u.id,
    );
    for (const [id, type, amount, metadata] of [
      ["c", "compute", 150, JSON.stringify({ orderId: "o" })],
      ["f", "compute_refund", -70, JSON.stringify({ orderId: "o" })],
      ["topup", "recharge", 1000, null],
    ] as const)
      s.run(
        "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day,metadata) VALUES(?,?,?,?,?,?,?,?,?)",
        id,
        u.id,
        type,
        "Test",
        "",
        amount,
        "now",
        "2026-10-15",
        metadata,
      );
    s.run("UPDATE users SET balance=920 WHERE id=?", u.id);
    const audit = reconcile(s);
    assert.equal(
      audit.issues.filter((i) => i.code === "rental_ledger_mismatch").length,
      2,
    );
    assert.equal(
      audit.issues.some((i) => i.code === "balance_mismatch"),
      false,
    );
    s.run("UPDATE ledger SET amount=100 WHERE id='c'");
    s.run("UPDATE ledger SET amount=-20 WHERE id='f'");
    assert.equal(reconcile(s).healthy, true);
    s.run(
      "INSERT INTO gpu_allocations(deploymentId,serverId,uuid) VALUES('d','n','GPU-test')",
    );
    assert.ok(
      reconcile(s).issues.some((i) => i.code === "stopped_gpu_allocated"),
    );
    assert.equal(
      s.get<any>("SELECT released FROM gpu_allocations").released,
      0,
    );
  } finally {
    s.close();
  }
});
