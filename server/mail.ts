import nodemailer from "nodemailer";
import { check, email, int } from "./validation.ts";
import { translate } from "../src/i18n/messages.ts";
import type { Locale } from "../src/i18n/messages.ts";
import type { Store, UserRow } from "./store.ts";
import { digest, secret } from "./auth.ts";

export type AccountMail = {
  origin: string;
  send: (message: {
    to: string;
    subject: string;
    text: string;
  }) => Promise<void>;
};
export function smtpFromEnv(env: NodeJS.ProcessEnv): AccountMail | undefined {
  if (!env.SMTP_HOST) return;
  const origin = new URL(env.PUBLIC_ORIGIN || "");
  check(
    origin.href === origin.origin + "/" &&
      !origin.username &&
      !origin.password &&
      (origin.protocol === "https:" ||
        (env.NODE_ENV !== "production" &&
          origin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))),
    "SMTP requires a fixed PUBLIC_ORIGIN; production requires HTTPS",
  );
  const port = int(Number(env.SMTP_PORT || 465), "SMTP_PORT", 1, 65535);
  check(
    env.SMTP_SECURE === undefined ||
      ["true", "false"].includes(env.SMTP_SECURE),
    "SMTP_SECURE must be true or false",
  );
  check(env.SMTP_USER && env.SMTP_PASSWORD, "SMTP credentials required");
  const from = email(env.SMTP_FROM),
    secure =
      env.SMTP_SECURE === undefined ? port === 465 : env.SMTP_SECURE === "true";
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    origin: origin.origin,
    async send(message) {
      const result = await transport.sendMail({ ...message, from });
      check(
        result.accepted.length === 1 && !result.rejected.length,
        "SMTP rejected recipient",
        503,
        "mail_unavailable",
      );
    },
  };
}
export async function issueMail(
  store: Store,
  mail: AccountMail,
  user: UserRow,
  purpose: "verify" | "reset",
  locale: Locale,
) {
  const token = secret(),
    tokenHash = digest(token),
    now = Date.now(),
    link = new URL("/", mail.origin);
  link.hash = "/user/account?" + new URLSearchParams({ mail: purpose, token });
  store.run("DELETE FROM account_tokens WHERE expires<=?", now);
  store.run(
    "INSERT INTO account_tokens(tokenHash,userId,purpose,expires,createdAt) VALUES(?,?,?,?,?) ON CONFLICT(userId,purpose) DO UPDATE SET tokenHash=excluded.tokenHash,expires=excluded.expires,createdAt=excluded.createdAt",
    tokenHash,
    user.id,
    purpose,
    now + (purpose === "reset" ? 30 * 60000 : 86400000),
    now,
  );
  try {
    await mail.send({
      to: user.email,
      subject: translate(
        locale,
        purpose === "verify" ? "mail.verifySubject" : "mail.resetSubject",
      ),
      text: translate(
        locale,
        purpose === "verify" ? "mail.verifyBody" : "mail.resetBody",
        { url: link.href },
      ),
    });
  } catch {
    store.run("DELETE FROM account_tokens WHERE tokenHash=?", tokenHash);
    throw new Error("SMTP delivery failed");
  }
}
export function accountToken(
  store: Store,
  value: unknown,
  purpose: "verify" | "reset",
) {
  check(
    typeof value === "string" && /^[a-zA-Z0-9_-]{43}$/.test(value),
    "Invalid or expired link",
    400,
    "invalid_mail_token",
  );
  const row = store.get<{ userId: string; tokenHash: string }>(
    "SELECT userId,tokenHash FROM account_tokens WHERE tokenHash=? AND purpose=? AND expires>?",
    digest(value),
    purpose,
    Date.now(),
  );
  check(row, "Invalid or expired link", 400, "invalid_mail_token");
  return row;
}
