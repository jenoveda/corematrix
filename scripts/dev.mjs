import { spawn } from "node:child_process";
const children = [
  spawn(process.execPath, ["--env-file-if-exists=.env", "server/index.ts"], {
    stdio: "inherit",
    env: { ...process.env, TLS_MANAGED: "1", TRUSTED_PROXY_IPS:"127.0.0.1" },
  }),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
    { stdio: "inherit" },
  ),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
    { stdio: "inherit", env: { ...process.env, VITE_PORTAL: "admin" } },
  ),
  spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1"],{stdio:"inherit",env:{...process.env,VITE_PORTAL:"provider"}}),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", (e) => {
    console.error(e.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code || 0));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
