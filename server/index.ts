import { createApplication } from "./app.ts";
import { smtpFromEnv } from "./mail.ts";
import { opsMailFromEnv } from "./operations.ts";
import { runtimeFromEnv } from "./runtime-config.ts";
import { stripeFromEnv } from "./payments.ts";
const { port, ...runtime } = runtimeFromEnv(process.env);
const mail = smtpFromEnv(process.env);
const app = createApplication({
  ...runtime,
  mail,
  opsMail: opsMailFromEnv(process.env, mail),
  stripe: stripeFromEnv(process.env),
});
app.server.listen(port, "127.0.0.1", () =>
  console.log(`CoreMatrix API: http://127.0.0.1:${port}`),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  app.server.close(async () => {
    await app.drain();
    app.store.close();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
