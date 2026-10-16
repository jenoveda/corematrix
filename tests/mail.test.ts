import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import nodemailer from "nodemailer";
import { createApplication } from "../server/app.ts";
import {
  digest,
  hashPassword,
  secret,
  verifyPassword,
} from "../server/auth.ts";
import { smtpFromEnv, issueMail } from "../server/mail.ts";
import { reconcile } from "../server/finance.ts";
import { locales, translate } from "../src/i18n/messages.ts";

async function fixture(t: any, enabled = true, fail = false) {
  const sent: { to: string; subject: string; text: string }[] = [];
  const app = createApplication({
    databasePath: ":memory:",
    mail: enabled
      ? {
          origin: "https://platform.tests.invalid",
          async send(m) {
            if (fail) throw Error("secret-provider-password");
            sent.push(m);
          },
        }
      : undefined,
  });
  const s = app.store,
    u = s.createUser(
      "Mail user",
      "mail@tests.invalid",
      await hashPassword("initial-password-123"),
    ),
    other = s.createUser("Other", "other@tests.invalid", "unused");
  s.run("UPDATE users SET balance=123456 WHERE id=?", u.id);
  s.run(
    "INSERT INTO ledger(id,userId,type,resource,quantity,amount,time,day) VALUES('funds',?,'recharge','Test funds','',123456,'now','2026-10-15')",
    u.id,
  );
  const sessionToken = secret(),
    csrf = secret(),
    otherToken = secret();
  s.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    digest(sessionToken),
    u.id,
    csrf,
    Date.now() + 3600000,
  );
  s.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    digest(otherToken),
    other.id,
    "other-csrf",
    Date.now() + 3600000,
  );
  const key = "cm_" + secret();
  s.run("INSERT INTO api_keys VALUES(?,?,?)", digest(key), u.id, "cm_test");
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
  async function request(
    path: string,
    data?: unknown,
    auth = false,
    headers: Record<string, string> = {},
  ) {
    const r = await fetch(origin + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(auth
          ? { Cookie: "cm_session=" + sessionToken, "X-CSRF-Token": csrf }
          : {}),
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return {
      status: r.status,
      body: await r.json(),
      cookie: r.headers.get("set-cookie"),
    };
  }
  t.after(async () => {
    await new Promise<void>((r) => app.server.close(() => r()));
    await app.drain();
    s.close();
  });
  function token(index = sent.length - 1) {
    const url = new URL(sent[index].text.match(/https?:\/\/\S+/)![0]);
    assert.equal(url.origin, "https://platform.tests.invalid");
    assert.equal(url.search, "");
    return new URLSearchParams(url.hash.split("?")[1]).get("token")!;
  }
  return { app, s, u, other, sent, request, token, key, sessionToken, csrf };
}

test("SMTP config fixes the link origin, requires TLS and credentials, and sends plain messages without file or URL access", async (t) => {
  assert.equal(smtpFromEnv({}), undefined);
  const env = {
    SMTP_HOST: "smtp.tests.invalid",
    SMTP_USER: "user",
    SMTP_PASSWORD: "unused-test-password",
    SMTP_FROM: "sender@tests.invalid",
    PUBLIC_ORIGIN: "https://platform.tests.invalid",
  };
  assert.throws(() =>
    smtpFromEnv({
      ...env,
      PUBLIC_ORIGIN: "http://remote.tests.invalid",
      NODE_ENV: "production",
    }),
  );
  assert.throws(() =>
    smtpFromEnv({
      ...env,
      PUBLIC_ORIGIN: "https://platform.tests.invalid/path",
    }),
  );
  assert.throws(() => smtpFromEnv({ ...env, SMTP_PASSWORD: "" }));
  assert.throws(() => smtpFromEnv({ ...env, SMTP_PORT: "bad" }));
  let options: any, message: any;
  t.mock.method(nodemailer, "createTransport", (value: any) => {
    options = value;
    return {
      async sendMail(m: any) {
        message = m;
        return { accepted: [m.to], rejected: [] };
      },
    } as any;
  });
  const mail = smtpFromEnv(env)!;
  assert.equal(options.secure, true);
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
  assert.equal(options.tls?.rejectUnauthorized, undefined);
  await mail.send({
    to: "buyer@tests.invalid",
    subject: "Subject",
    text: "Body",
  });
  assert.equal(message.from, "sender@tests.invalid");
  assert.equal(message.to, "buyer@tests.invalid");
  assert.equal(message.html, undefined);
  smtpFromEnv({ ...env, SMTP_PORT: "587", SMTP_SECURE: "false" });
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
});

test("verification requires session and CSRF; hashed one-time purpose-bound token verifies only its owner", async (t) => {
  const f = await fixture(t),
    { request, s, u, other } = f;
  assert.equal((await request("/api/account/verification", {})).status, 401);
  assert.equal(
    (
      await request("/api/account/verification", {}, true, {
        "X-CSRF-Token": "bad",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/account/verification", {}, true, {
        Origin: "https://evil.tests.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/account/verification", {}, true, {
        Host: "attacker.tests.invalid",
      })
    ).status,
    200,
  );
  const token = f.token();
  assert.equal(token.length, 43);
  assert.equal(f.sent[0].to, u.email);
  assert.equal(
    s.get<any>("SELECT tokenHash FROM account_tokens")!.tokenHash,
    digest(token),
  );
  assert.equal(JSON.stringify(s.snapshot(s.user(u.id))).includes(token), false);
  assert.equal(
    (
      await request("/api/auth/reset-password", {
        token,
        password: "new-password-1234",
      })
    ).body.error.code,
    "invalid_mail_token",
  );
  assert.equal(
    (await request("/api/auth/verify-email", { token })).status,
    200,
  );
  assert.ok(s.user(u.id)!.emailVerifiedAt);
  assert.equal(s.user(other.id)!.emailVerifiedAt, null);
  assert.equal(
    (await request("/api/auth/verify-email", { token })).status,
    400,
  );
  assert.equal(
    (await request("/api/account/verification", {}, true)).status,
    200,
  );
  assert.equal(f.sent.length, 1);
  assert.equal(s.user(u.id)!.balance, 123456);
  assert.equal(reconcile(s).healthy, true);
});

test("forgot password responds identically for unknown accounts and SMTP failure, rate-limits without leaking tokens", async (t) => {
  const f = await fixture(t),
    { request, s } = f;
  const known = await request("/api/auth/forgot-password", {
      email: f.u.email,
      locale: "ja-JP",
    }),
    unknown = await request("/api/auth/forgot-password", {
      email: "missing@tests.invalid",
      locale: "ja-JP",
    });
  assert.deepEqual(known, unknown);
  assert.equal(known.status, 200);
  await f.app.drain();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].subject, translate("ja-JP", "mail.resetSubject"));
  for (let i = 0; i < 2; i++) {
    assert.equal(
      (await request("/api/auth/forgot-password", { email: f.u.email })).status,
      200,
    );
    assert.equal(
      (
        await request("/api/auth/forgot-password", {
          email: "missing@tests.invalid",
        })
      ).status,
      200,
    );
  }
  assert.equal(
    (await request("/api/auth/forgot-password", { email: f.u.email })).status,
    429,
  );
  assert.equal(
    (
      await request("/api/auth/forgot-password", {
        email: "missing@tests.invalid",
      })
    ).status,
    429,
  );
  await f.app.drain();
  assert.equal(s.all("SELECT * FROM account_tokens").length, 1);
  const failed = await fixture(t, true, true);
  assert.equal(
    (
      await failed.request("/api/auth/forgot-password", {
        email: failed.u.email,
      })
    ).status,
    200,
  );
  await failed.app.drain();
  assert.equal(failed.s.all("SELECT * FROM account_tokens").length, 0);
  const bad = await failed.request("/api/account/verification", {}, true);
  assert.equal(bad.status, 503);
  assert.equal(bad.body.error.code, "mail_unavailable");
  assert.equal(JSON.stringify(bad).includes("secret-provider-password"), false);
});

test("reset changes password once, revokes only owner sessions and keys, and preserves money and verification", async (t) => {
  const f = await fixture(t),
    { request, s, u, other } = f;
  s.run(
    "UPDATE users SET emailVerifiedAt=? WHERE id=?",
    "2026-10-15T00:00:00Z",
    u.id,
  );
  await request("/api/auth/forgot-password", { email: u.email });
  await f.app.drain();
  const token = f.token();
  const result = await Promise.all([
    request("/api/auth/reset-password", {
      token,
      password: "changed-password-123",
    }),
    request("/api/auth/reset-password", {
      token,
      password: "changed-password-123",
    }),
  ]);
  assert.deepEqual(result.map((r) => r.status).sort(), [200, 400]);
  assert.equal(
    await verifyPassword("changed-password-123", s.user(u.id)!.passwordHash),
    true,
  );
  assert.equal(
    await verifyPassword("initial-password-123", s.user(u.id)!.passwordHash),
    false,
  );
  assert.equal(s.all("SELECT * FROM sessions WHERE userId=?", u.id).length, 0);
  assert.equal(s.all("SELECT * FROM api_keys WHERE userId=?", u.id).length, 0);
  assert.equal(
    s.all("SELECT * FROM account_tokens WHERE userId=?", u.id).length,
    0,
  );
  assert.equal(
    s.all("SELECT * FROM sessions WHERE userId=?", other.id).length,
    1,
  );
  assert.equal((await request("/api/state", undefined, true)).body.user, null);
  assert.equal(
    (
      await request("/v1/chat/completions", {}, false, {
        Authorization: "Bearer " + f.key,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/login", {
        email: u.email,
        password: "initial-password-123",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/login", {
        email: u.email,
        password: "changed-password-123",
      })
    ).status,
    200,
  );
  assert.equal(s.user(u.id)!.emailVerifiedAt, "2026-10-15T00:00:00Z");
  assert.equal(s.user(u.id)!.balance, 123456);
  assert.equal(reconcile(s).healthy, true);
});

test("replacement and expired links fail, invalid passwords do not consume a valid token, and disabled SMTP is honest", async (t) => {
  const f = await fixture(t),
    { request, s, u } = f;
  await request("/api/auth/forgot-password", { email: u.email });
  await f.app.drain();
  const old = f.token();
  await request("/api/auth/forgot-password", { email: u.email });
  await f.app.drain();
  const next = f.token();
  assert.notEqual(old, next);
  assert.equal(
    (
      await request("/api/auth/reset-password", {
        token: old,
        password: "changed-password-123",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/auth/reset-password", {
        token: next,
        password: "short",
      })
    ).body.error.code,
    "invalid_password",
  );
  assert.equal(s.all("SELECT * FROM account_tokens").length, 1);
  s.run("UPDATE account_tokens SET expires=?", Date.now() - 1);
  assert.equal(
    (
      await request("/api/auth/reset-password", {
        token: next,
        password: "changed-password-123",
      })
    ).body.error.code,
    "invalid_mail_token",
  );
  assert.equal(
    await verifyPassword("initial-password-123", s.user(u.id)!.passwordHash),
    true,
  );
  const disabled = await fixture(t, false);
  assert.equal((await disabled.request("/api/state")).body.mailEnabled, false);
  assert.equal(
    (
      await disabled.request("/api/auth/forgot-password", {
        email: disabled.u.email,
      })
    ).status,
    503,
  );
  assert.equal(
    (await disabled.request("/api/account/verification", {}, true)).status,
    503,
  );
});

test("all four localized emails keep a single fixed-origin secret link out of URL queries", async (t) => {
  const f = await fixture(t);
  for (const locale of locales)
    for (const purpose of ["verify", "reset"] as const) {
      await issueMail(
        f.s,
        {
          origin: "https://platform.tests.invalid",
          async send(m) {
            f.sent.push(m);
          },
        },
        f.u,
        purpose,
        locale,
      );
      assert.equal(
        f.sent.at(-1)!.subject,
        translate(
          locale,
          purpose === "verify" ? "mail.verifySubject" : "mail.resetSubject",
        ),
      );
      const token = f.token();
      assert.ok(f.sent.at(-1)!.text.includes(token));
      assert.equal(
        f.s.all(
          "SELECT * FROM account_tokens WHERE userId=? AND purpose=?",
          f.u.id,
          purpose,
        ).length,
        1,
      );
    }
});

test("SMTP work is bounded and graceful shutdown waits for outstanding mail", async (t) => {
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((r) => (release = r)),
    app = createApplication({
      databasePath: ":memory:",
      mail: {
        origin: "https://platform.tests.invalid",
        async send() {
          calls++;
          await gate;
        },
      },
    });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  try {
    for (let i = 0; i < 5; i++) {
      app.store.createUser(
        "Bounded",
        "bounded" + i + "@tests.invalid",
        "unused",
      );
      const res = await fetch(
        `http://127.0.0.1:${(app.server.address() as any).port}/api/auth/forgot-password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "bounded" + i + "@tests.invalid" }),
        },
      );
      assert.equal(res.status, 200);
      await res.json();
    }
    assert.equal(calls, 4);
    assert.equal(app.store.all("SELECT * FROM account_tokens").length, 4);
    let drained = false;
    const drain = app.drain().then(() => (drained = true));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(drained, false);
    release();
    await drain;
    assert.equal(drained, true);
  } finally {
    release();
    await new Promise<void>((r) => app.server.close(() => r()));
    await app.drain();
    app.store.close();
  }
});
