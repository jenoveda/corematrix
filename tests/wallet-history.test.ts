import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createApplication } from "../server/app.ts";
import { digest, secret } from "../server/auth.ts";
import type { BillPage } from "../src/domain.ts";

async function fixture(t: any) {
  const app = createApplication({ databasePath: ":memory:" }),
    s = app.store;
  const owner = s.createUser("Owner", "history@tests.invalid", "unused"),
    other = s.createUser("Other", "other@tests.invalid", "unused"),
    admin = s.createUser("Admin", "admin@tests.invalid", "unused", "admin");
  const sessions = new Map<string, string>();
  for (const u of [owner, other, admin]) {
    const token = secret();
    sessions.set(u.id, token);
    s.run(
      "INSERT INTO sessions VALUES(?,?,?,?)",
      digest(token),
      u.id,
      secret(),
      Date.now() + 100000,
    );
  }
  const types = [
    "token",
    "recharge",
    "compute",
    "compute_refund",
    "recharge_refund",
  ];
  function insert(userId: string, i: number) {
    const id = randomUUID(),
      type = types[i % types.length];
    s.run(
      "INSERT INTO ledger(id,userId,type,resource,quantity,amount,inputPrice,outputPrice,time,day,metadata) VALUES(?,?,?,'History fixture','Original quantity',?,12345,67890,'2026-10-16T00:00:00.000Z','2026-10-16',?)",
      id,
      userId,
      type,
      type === "compute_refund" ? -33 : 123456,
      i % 2
        ? null
        : JSON.stringify({ inputTokens: i, reason: "Original note" }),
    );
    return id;
  }
  const owned: string[] = [];
  s.transaction(() => {
    for (let i = 0; i < 605; i++) {
      owned.push(insert(owner.id, i));
      insert(other.id, i);
      if (i % 20 === 0) insert(admin.id, i);
    }
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise<void>((r) => app.server.close(() => r()));
    await app.drain();
    s.close();
  });
  async function call(query = "", userId: string | null = owner.id) {
    const r = await fetch(
      `http://127.0.0.1:${(app.server.address() as any).port}/api/wallet/bills` +
        query,
      {
        headers: userId ? { Cookie: "cm_session=" + sessions.get(userId) } : {},
      },
    );
    return {
      status: r.status,
      body: (await r.json()) as BillPage & { error?: { code: string } },
    };
  }
  return { app, s, owner, other, admin, owned, insert, call };
}

test("wallet history pages beyond 500 with immutable quotes, stable cursors and insertions between pages", async (t) => {
  const f = await fixture(t),
    before = f.s.all("SELECT * FROM ledger"),
    balances = f.s.all("SELECT id,balance,passwordHash FROM users");
  let page = await f.call();
  assert.equal(page.status, 200);
  assert.equal(page.body.data.length, 50);
  assert.ok(
    page.body.data.some(
      (b) =>
        b.inputPrice === 12345 &&
        b.outputPrice === 67890 &&
        b.metadata?.reason === "Original note",
    ),
  );
  assert.ok(
    page.body.data.every(
      (b) => !Object.hasOwn(b, "cursor") && !Object.hasOwn(b, "userId"),
    ),
  );
  const ids = page.body.data.map((b) => b.id),
    firstCursor = page.body.nextCursor;
  const added = f.insert(f.owner.id, 606);
  while (page.body.nextCursor !== null) {
    page = await f.call("?before=" + page.body.nextCursor);
    assert.equal(page.status, 200);
    ids.push(...page.body.data.map((b) => b.id));
  }
  assert.deepEqual(ids, [...f.owned].reverse());
  assert.equal(new Set(ids).size, 605);
  assert.equal((await f.call()).body.data[0].id, added);
  assert.deepEqual(
    (await f.call("?before=" + firstCursor)).body.data.map((b) => b.id),
    ids.slice(50, 100),
  );
  assert.deepEqual(f.s.all("SELECT * FROM ledger WHERE id!=?", added), before);
  assert.deepEqual(
    f.s.all("SELECT id,balance,passwordHash FROM users"),
    balances,
  );
  assert.equal(f.s.snapshot(f.s.user(f.owner.id)).bills.length, 500);
});

test("wallet type queries cover all history, while authentication, foreign cursors and invalid input never expose another account", async (t) => {
  const f = await fixture(t),
    before = f.s.all("SELECT * FROM ledger"),
    balances = f.s.all("SELECT id,balance,passwordHash FROM users");
  for (const type of [
    "token",
    "recharge",
    "compute",
    "compute_refund",
    "recharge_refund",
  ]) {
    let cursor: number | null = null;
    const ids: string[] = [];
    do {
      const page = await f.call(
        "?type=" + type + (cursor ? "&before=" + cursor : ""),
      );
      assert.equal(page.status, 200);
      assert.ok(page.body.data.every((b) => b.type === type));
      ids.push(...page.body.data.map((b) => b.id));
      cursor = page.body.nextCursor;
    } while (cursor !== null);
    const expected = f.s
      .all<{ id: string }>(
        "SELECT id FROM ledger WHERE userId=? AND type=? ORDER BY rowid DESC",
        f.owner.id,
        type,
      )
      .map((b) => b.id);
    assert.deepEqual(ids, expected);
    assert.equal(ids.length, 121);
  }
  assert.equal((await f.call("", null)).status, 401);
  const apiKey = "cm_" + secret();
  f.s.run(
    "INSERT INTO api_keys VALUES(?,?,?)",
    digest(apiKey),
    f.owner.id,
    apiKey.slice(0, 10),
  );
  const apiKeyResponse = await fetch(
    `http://127.0.0.1:${(f.app.server.address() as any).port}/api/wallet/bills`,
    { headers: { Authorization: "Bearer " + apiKey } },
  );
  assert.equal(apiKeyResponse.status, 401);
  await apiKeyResponse.arrayBuffer();
  const otherPage = await f.call("", f.other.id),
    adminPage = await f.call("", f.admin.id);
  assert.ok(otherPage.body.data.every((b) => !f.owned.includes(b.id)));
  assert.ok(adminPage.body.data.every((b) => !f.owned.includes(b.id)));
  const forged = await f.call(
    "?userId=" + f.other.id + "&before=" + otherPage.body.nextCursor,
  );
  assert.ok(forged.body.data.every((b) => f.owned.includes(b.id)));
  for (const query of [
    "?type=invalid",
    "?type=token%27%20OR%201=1--",
    "?before=0",
    "?before=-1",
    "?before=1.5",
    "?before=9007199254740992",
    "?before=NaN",
    "?before=1%20OR%201=1",
    "?before=",
  ])
    assert.equal((await f.call(query)).status, 400, query);
  assert.equal((await f.call("?before=1")).body.nextCursor, null);
  assert.deepEqual((await f.call("?before=1")).body.data, []);
  assert.deepEqual(f.s.all("SELECT * FROM ledger"), before);
  assert.deepEqual(
    f.s.all("SELECT id,balance,passwordHash FROM users"),
    balances,
  );
});
