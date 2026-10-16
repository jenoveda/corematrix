import { createApplication } from "./app.ts";
import { smtpFromEnv } from "./mail.ts";
import { opsMailFromEnv } from "./operations.ts";
import { runtimeFromEnv } from "./runtime-config.ts";
import { stripeFromEnv } from "./payments.ts";
import { check } from "./validation.ts";
import { Certificates } from "./certificates.ts";
import { dirname, join } from "node:path";
const { port, ...runtime } = runtimeFromEnv(process.env);
const adminRuntime = runtimeFromEnv({
  ...process.env,
  API_PORT: process.env.ADMIN_API_PORT || "3002",
  PUBLIC_ORIGIN: process.env.ADMIN_PUBLIC_ORIGIN,
});
const providerRuntime = runtimeFromEnv({...process.env, API_PORT:process.env.PROVIDER_API_PORT || "3003", PUBLIC_ORIGIN:process.env.PROVIDER_PUBLIC_ORIGIN});
check(port !== adminRuntime.port, "User and admin API ports must be different");
check(!runtime.publicOrigin || !adminRuntime.publicOrigin || runtime.publicOrigin !== adminRuntime.publicOrigin, "User and admin public origins must be different");
check(new Set([port,adminRuntime.port,providerRuntime.port]).size===3,"All portal API ports must differ");
const publicOrigins=[runtime.publicOrigin,adminRuntime.publicOrigin,providerRuntime.publicOrigin].filter(Boolean);
check(new Set(publicOrigins).size===publicOrigins.length,"All portal public origins must differ");
check(!process.env.TLS_MANAGED || ["0", "1"].includes(process.env.TLS_MANAGED), "TLS_MANAGED must be 0 or 1");
const certificates = process.env.TLS_MANAGED === "1" ? new Certificates(
  join(dirname(runtime.databasePath), "platform-tls.json"),
  {user:3443,admin:3444,provider:3445},
  {user:Number(process.env.WEB_PORT || 5173),admin:Number(process.env.ADMIN_WEB_PORT || 5174),provider:Number(process.env.PROVIDER_WEB_PORT || 5175)},
) : undefined;
try { await certificates?.start(); } catch { console.error("Stored TLS configuration could not be loaded"); process.exit(1); }
const mail = smtpFromEnv(process.env);
const app = createApplication({
  ...runtime,
  splitPortals: true,
  certificates,
  adminPublicOrigin: adminRuntime.publicOrigin,
  providerPublicOrigin: providerRuntime.publicOrigin,
  mail,
  opsMail: opsMailFromEnv(process.env, mail),
  stripe: stripeFromEnv(process.env),
});
app.server.listen(port, "127.0.0.1", () =>
  console.log(`CoreMatrix user API: http://127.0.0.1:${port}`),
);
app.adminServer!.listen(adminRuntime.port, "127.0.0.1", () =>
  console.log(`CoreMatrix admin API: http://127.0.0.1:${adminRuntime.port}`),
);
app.providerServer!.listen(providerRuntime.port,"127.0.0.1",() => console.log(`CoreMatrix supplier API: http://127.0.0.1:${providerRuntime.port}`));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  void Promise.all([app.server, app.adminServer!,app.providerServer!].map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve())),
  )).then(async () => {
    await app.drain();
    await certificates?.close();
    app.store.close();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
