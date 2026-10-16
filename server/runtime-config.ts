import { isAbsolute } from "node:path";
import { check, int } from "./validation.ts";

function origin(value: string, https: boolean, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} requires a valid origin`);
  }
  check(
    url.href === url.origin + "/" &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" || (!https && url.protocol === "http:")),
    `${label} requires ${https ? "HTTPS" : "HTTP(S)"} and cannot contain credentials, paths, queries or fragments`,
  );
  return url.origin;
}
export function runtimeFromEnv(env: NodeJS.ProcessEnv) {
  const production = env.NODE_ENV === "production",
    databasePath = env.DATABASE_PATH || "data/corematrix.sqlite";
  check(
    !production ||
      (env.DATABASE_PATH &&
        isAbsolute(databasePath) &&
        databasePath !== ":memory:"),
    "Production requires an absolute DATABASE_PATH on persistent storage",
  );
  check(!production || env.PUBLIC_ORIGIN, "Production requires PUBLIC_ORIGIN");
  return {
    databasePath,
    publicOrigin: env.PUBLIC_ORIGIN
      ? origin(env.PUBLIC_ORIGIN, production, "PUBLIC_ORIGIN")
      : undefined,
    secureCookie: production,
    allowedOrigins: (env.INFERENCE_ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((value) => origin(value, false, "INFERENCE_ALLOWED_ORIGINS")),
    trustedProxyIps: (env.TRUSTED_PROXY_IPS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    port: int(Number(env.API_PORT || 3001), "API_PORT", 1, 65535),
  };
}
