import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApplication } from "../server/app.ts";
import { clientIpResolver } from "../server/client-ip.ts";

const req = (peer: string | undefined, forwarded?: string | string[]) =>
  ({
    socket: { remoteAddress: peer },
    headers: {
      "x-forwarded-for": forwarded,
      "x-real-ip": "1.2.3.4",
      forwarded: 'for="1.2.3.4"',
    },
  }) as any;

test("forwarded headers are ignored unless the direct peer is explicitly trusted", () => {
  assert.equal(
    clientIpResolver()(req("127.0.0.1", "203.0.113.1")),
    "127.0.0.1",
  );
  const resolve = clientIpResolver(["10.0.0.1"]);
  assert.equal(resolve(req("10.0.0.2", "203.0.113.1")), "10.0.0.2");
  assert.equal(resolve(req(undefined, "203.0.113.1")), "unknown");
  assert.equal(resolve(req("10.0.0.1")), "10.0.0.1");
});

test("trusted chains stop at the first untrusted hop and cannot be spoofed by client prefixes", () => {
  const resolve = clientIpResolver(["127.0.0.1", "10.0.0.1"]);
  assert.equal(resolve(req("127.0.0.1", "203.0.113.1")), "203.0.113.1");
  assert.equal(
    resolve(req("127.0.0.1", "198.51.100.99, 203.0.113.1")),
    "203.0.113.1",
  );
  assert.equal(
    resolve(req("127.0.0.1", "198.51.100.99, 203.0.113.1, 10.0.0.1")),
    "203.0.113.1",
  );
  assert.equal(resolve(req("127.0.0.1", "127.0.0.1,10.0.0.1")), "127.0.0.1");
});

test("IPv6 and IPv4-mapped addresses share canonical trust and rate-limit identities", () => {
  const resolve = clientIpResolver(["::FFFF:7F00:0001", "2001:db8::1"]);
  assert.equal(resolve(req("::ffff:127.0.0.1", "203.0.113.1")), "203.0.113.1");
  assert.equal(resolve(req("127.0.0.1", "::ffff:cb00:7101")), "203.0.113.1");
  assert.equal(
    resolve(
      req("2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:DB8:0:1:0:0:0:2"),
    ),
    "2001:db8:0:1::2",
  );
});

test("invalid, excessive or ambiguous forwarding values fail back to the direct peer", () => {
  const resolve = clientIpResolver(["127.0.0.1"]);
  for (const header of [
    "",
    "unknown",
    "203.0.113.1:1234",
    "[2001:db8::2]",
    "fe80::1%en0",
    "203.0.113.1,",
    "fake,203.0.113.1",
    "1".repeat(1025),
    Array(9).fill("203.0.113.1").join(","),
    ["203.0.113.1", "203.0.113.2"],
  ])
    assert.equal(resolve(req("127.0.0.1", header)), "127.0.0.1");
  for (const address of [
    "proxy.example.com",
    "127.0.0.1/8",
    "*",
    "",
    "127.0.0.1:3001",
    "[::1]",
    "fe80::1%eth0",
  ])
    assert.throws(() => clientIpResolver([address]), /exact IPv4 or IPv6/);
  assert.throws(() => clientIpResolver(Array(33).fill("127.0.0.1")), /32/);
});

async function fixture(t: any, trusted = true) {
  const app = createApplication({
    databasePath: ":memory:",
    trustedProxyIps: trusted ? ["127.0.0.1"] : [],
    mail: { origin: "https://control.tests.invalid", send: async () => {} },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise<void>((r) => app.server.close(() => r()));
    await app.drain();
    app.store.close();
  });
  let n = 0;
  async function call(path: string, forwarded: string, origin?: string) {
    n++;
    const response = await fetch(
      "http://127.0.0.1:" + (app.server.address() as any).port + path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": forwarded,
          "X-Forwarded-Host": "attacker.tests.invalid",
          "X-Forwarded-Proto": "https",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({
          email: `missing${n}@tests.invalid`,
          password: "test-password-123",
          locale: "en-US",
        }),
      },
    );
    return { status: response.status, body: await response.json() };
  }
  return { app, call };
}

test("authentication limit separates proxied clients, blocks spoofed prefixes", async (t) => {
  const { call, app } = await fixture(t);
  for (let i = 0; i < 20; i++)
    assert.equal((await call("/api/auth/login", "203.0.113.1")).status, 401);
  assert.equal(
    (await call("/api/auth/login", "198.51.100.99,203.0.113.1")).status,
    429,
  );
  assert.equal((await call("/api/auth/login", "203.0.113.2")).status, 401);
  assert.equal((await call("/api/auth/login", "::ffff:cb00:7101")).status, 429);
  assert.equal(
    app.store.get<{ count: number }>(
      "SELECT count FROM rate_limits WHERE key='auth:203.0.113.1'",
    )!.count,
    20,
  );
});

test("SMTP public limit uses trusted client identity while forwarded host/protocol never change origin policy", async (t) => {
  const { call } = await fixture(t);
  for (let i = 0; i < 30; i++)
    assert.equal(
      (await call("/api/auth/forgot-password", "203.0.113.1")).status,
      200,
    );
  assert.equal(
    (await call("/api/auth/forgot-password", "198.51.100.99,203.0.113.1"))
      .status,
    429,
  );
  assert.equal(
    (await call("/api/auth/forgot-password", "203.0.113.2")).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/api/auth/forgot-password",
        "203.0.113.3",
        "https://attacker.tests.invalid",
      )
    ).body.error.code,
    "origin_rejected",
  );
});

test("without a trusted proxy configuration, rotating headers does not evade the direct-IP limit", async (t) => {
  const { call } = await fixture(t, false);
  for (let i = 0; i < 20; i++)
    assert.equal(
      (await call("/api/auth/login", "203.0.113." + (i + 1))).status,
      401,
    );
  assert.equal((await call("/api/auth/login", "203.0.113.200")).status, 429);
});
