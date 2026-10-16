import { spawnSync } from "node:child_process";
for (const portal of ["user", "admin", "provider"]) {
  const result = spawnSync(process.execPath, [
    "node_modules/vite/bin/vite.js", "build", "--outDir", `dist/${portal}`,
  ], { stdio: "inherit", env: { ...process.env, VITE_PORTAL: portal } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
