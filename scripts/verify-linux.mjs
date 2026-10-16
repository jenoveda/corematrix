import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)),
  dir = mkdtempSync(join(tmpdir(), "corematrix-linux-"));
chmodSync(dir, 0o700);
const containerName = "corematrix-linux-qa-" + randomUUID();
try {
  const image = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", "corematrix-linux-qa:node24"],
    { encoding: "utf8", timeout: 60000 },
  ).trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const architecture = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Architecture}}", image],
    { encoding: "utf8", timeout: 60000 },
  ).trim();
  assert(
    ["amd64", "arm64"].includes(architecture),
    "Unsupported Linux test architecture",
  );
  const release = join(dir, "release"),
    fixture = join(dir, "fixture");
  mkdirSync(release, { mode: 0o755 });
  mkdirSync(fixture, { mode: 0o755 });
  for (const name of ["server", "src", "tests"])
    cpSync(join(root, name), join(release, name), {
      recursive: true,
      filter: (source) =>
        statSync(source).isDirectory() ||
        [".ts", ".tsx"].includes(extname(source)),
    });
  copyFileSync(join(root, "package.json"), join(release, "package.json"));
  mkdirSync(join(release, "node_modules"));
  for (const name of ["stripe", "nodemailer"])
    cpSync(
      join(root, "node_modules", name),
      join(release, "node_modules", name),
      { recursive: true },
    );
  mkdirSync(join(release, "deploy"));
  for (const name of [
    "corematrix-api.service",
    "corematrix-api.env.example",
    "nginx-console.conf.example",
    "nginx-node.conf.example",
  ])
    copyFileSync(join(root, "deploy", name), join(release, "deploy", name));
  copyFileSync(
    join(root, "tests/linux/runtime.mjs"),
    join(fixture, "runtime.mjs"),
  );
  writeFileSync(
    join(fixture, "broken.service"),
    readFileSync(join(root, "deploy/corematrix-api.service"), "utf8").replace(
      "ExecStart=/usr/bin/node",
      "ExecStart=/nonexistent/corematrix-node",
    ),
  );
  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    containerName,
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs",
    "/tmp:mode=1777",
    "--mount",
    `type=bind,src=${release},dst=/opt/corematrix/current,readonly`,
    "--mount",
    `type=bind,src=${fixture},dst=/qa,readonly`,
  ];
  execFileSync("docker", [...args, image, "node", "--version"], {
    stdio: "inherit",
    timeout: 60000,
  });
  execFileSync("docker", [...args, image, "systemd-analyze", "--version"], {
    stdio: "inherit",
    timeout: 60000,
  });
  execFileSync(
    "docker",
    [
      ...args,
      image,
      "systemd-analyze",
      "--man=no",
      "verify",
      "/opt/corematrix/current/deploy/corematrix-api.service",
    ],
    { stdio: "inherit", timeout: 60000 },
  );
  assert.throws(
    () =>
      execFileSync(
        "docker",
        [
          ...args,
          image,
          "systemd-analyze",
          "--man=no",
          "verify",
          "/qa/broken.service",
        ],
        { stdio: "pipe", timeout: 60000 },
      ),
    (e) => e.status === 1,
  );
  console.log(
    "PASS: API systemd unit verifies; nonexistent executable is rejected. systemd was not started.",
  );
  const runtime = [
    ...args,
    "--user",
    "1001:1001",
    "--tmpfs",
    "/var/lib/corematrix:uid=1001,gid=1001,mode=0700",
    image,
  ];
  execFileSync(
    "go",
    [
      "-C",
      join(root, "agent"),
      "test",
      "-c",
      "-o",
      join(fixture, "agent-tests"),
    ],
    {
      env: {
        ...process.env,
        GOOS: "linux",
        GOARCH: architecture,
        CGO_ENABLED: "0",
        GOTOOLCHAIN: "local",
      },
      stdio: "inherit",
      timeout: 60000,
    },
  );
  execFileSync(
    "docker",
    [...runtime, "/qa/agent-tests", "-test.v", "-test.timeout=60s"],
    { stdio: "inherit", timeout: 90000 },
  );
  execFileSync("docker", [...runtime, "node", "/qa/runtime.mjs"], {
    stdio: "inherit",
    timeout: 60000,
  });
  const tests = readdirSync(join(root, "tests"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => "tests/" + name);
  execFileSync("docker", [...runtime, "node", "--test", ...tests], {
    stdio: "inherit",
    timeout: 120000,
  });
} finally {
  try {
    execFileSync("docker", ["rm", "--force", containerName], {
      stdio: "ignore",
      timeout: 10000,
    });
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}
