import test from "node:test";
import assert from "node:assert/strict";
import { runtimeFromEnv } from "../server/runtime-config.ts";

test("development runtime defaults preserve the existing database and canonical origins", () => {
  assert.deepEqual(runtimeFromEnv({}), {
    databasePath: "data/corematrix.sqlite",
    publicOrigin: undefined,
    secureCookie: false,
    allowedOrigins: [],
    trustedProxyIps: [],
    port: 3001,
  });
  const config = runtimeFromEnv({
    PUBLIC_ORIGIN: "http://LOCALHOST:5173/",
    INFERENCE_ALLOWED_ORIGINS:
      "https://UPSTREAM.tests.invalid:443/, http://127.0.0.1:8000",
    TRUSTED_PROXY_IPS: "127.0.0.1, ::1",
    API_PORT: "3002",
  });
  assert.equal(config.publicOrigin, "http://localhost:5173");
  assert.deepEqual(config.allowedOrigins, [
    "https://upstream.tests.invalid",
    "http://127.0.0.1:8000",
  ]);
  assert.deepEqual(config.trustedProxyIps, ["127.0.0.1", "::1"]);
  assert.equal(config.port, 3002);
});

test("production fails before database creation without persistent storage and a fixed HTTPS origin", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_PATH: "/var/lib/corematrix/corematrix.sqlite",
    PUBLIC_ORIGIN: "https://console.tests.invalid",
  };
  assert.equal(runtimeFromEnv(base).secureCookie, true);
  for (const path of ["", "data/corematrix.sqlite", ":memory:"])
    assert.throws(
      () => runtimeFromEnv({ ...base, DATABASE_PATH: path }),
      /absolute DATABASE_PATH/,
    );
  for (const url of [
    "",
    "http://console.tests.invalid",
    "https://console.tests.invalid/path",
    "https://user:PRIVATE_SECRET@console.tests.invalid",
    "https://console.tests.invalid/?secret=PRIVATE_SECRET",
    "https://console.tests.invalid/#secret",
  ]) {
    assert.throws(
      () => runtimeFromEnv({ ...base, PUBLIC_ORIGIN: url }),
      (e) => {
        assert(e instanceof Error);
        assert(!e.message.includes("PRIVATE_SECRET"));
        return true;
      },
    );
  }
});

test("runtime port and external inference origins reject invalid configurations without exposing values", () => {
  for (const port of ["0", "65536", "1.5", "NaN"])
    assert.throws(() => runtimeFromEnv({ API_PORT: port }));
  for (const url of [
    "invalid",
    "file:///tmp/example",
    "https://upstream.tests.invalid/v1/chat/completions",
    "https://PRIVATE_SECRET@upstream.tests.invalid",
    "https://upstream.tests.invalid/?token=PRIVATE_SECRET",
  ]) {
    assert.throws(
      () => runtimeFromEnv({ INFERENCE_ALLOWED_ORIGINS: url }),
      (e) => {
        assert(e instanceof Error);
        assert(!e.message.includes("PRIVATE_SECRET"));
        return true;
      },
    );
  }
});
