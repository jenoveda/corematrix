import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const image =
  "nginx@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5";
const dir = mkdtempSync(join(tmpdir(), "corematrix-nginx-"));
chmodSync(dir, 0o700);
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=console.example.invalid",
      "-addext",
      "subjectAltName=DNS:console.example.invalid,IP:127.0.0.1,IP:127.0.0.2",
    ],
    { stdio: "pipe", timeout: 30000 },
  );
  chmodSync(join(dir, "key.pem"), 0o600);
  mkdirSync(join(dir, "www"));
  writeFileSync(
    join(dir, "www/index.html"),
    "Isolated CoreMatrix Nginx syntax fixture",
  );
  const configs = {
    console: readFileSync(
      join(root, "deploy/nginx-console.conf.example"),
      "utf8",
    )
      .replaceAll("/etc/corematrix/tls/fullchain.pem", "/qa/cert.pem")
      .replaceAll("/etc/corematrix/tls/privkey.pem", "/qa/key.pem")
      .replaceAll("/opt/corematrix/current/dist/user", "/qa/www"),
    admin: readFileSync(join(root, "deploy/nginx-admin.conf.example"), "utf8")
      .replaceAll("/etc/corematrix/admin-tls/fullchain.pem", "/qa/cert.pem")
      .replaceAll("/etc/corematrix/admin-tls/privkey.pem", "/qa/key.pem")
      .replaceAll("/opt/corematrix/current/dist/admin", "/qa/www"),
    provider: readFileSync(join(root, "deploy/nginx-provider.conf.example"), "utf8")
      .replaceAll("/etc/corematrix/provider-tls/fullchain.pem", "/qa/cert.pem")
      .replaceAll("/etc/corematrix/provider-tls/privkey.pem", "/qa/key.pem")
      .replaceAll("/opt/corematrix/current/dist/provider", "/qa/www"),
    node: readFileSync(join(root, "deploy/nginx-node.conf.example"), "utf8")
      .replaceAll("NODE_IP", "127.0.0.2")
      .replaceAll("CONTROL_PLANE_IP", "127.0.0.3")
      .replaceAll("/etc/corematrix/node.crt", "/qa/cert.pem")
      .replaceAll("/etc/corematrix/node.key", "/qa/key.pem"),
  };
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--tmpfs",
    "/var/cache/nginx",
    "--tmpfs",
    "/var/run",
    "--tmpfs",
    "/var/log/nginx",
    "--tmpfs",
    "/tmp",
    "--mount",
    `type=bind,src=${dir},dst=/qa,readonly`,
    "--entrypoint",
    "nginx",
    image,
  ];
  execFileSync("docker", [...args, "-v"], { timeout: 60000, stdio: "inherit" });
  for (const [name, config] of Object.entries(configs)) {
    writeFileSync(
      join(dir, name + ".conf"),
      `events {}\nhttp {\n${config}\n}\n`,
    );
    execFileSync("docker", [...args, "-t", "-c", "/qa/" + name + ".conf"], {
      timeout: 60000,
      stdio: "inherit",
    });
    console.log("PASS: isolated Linux nginx -t for " + name + " template");
  }
  writeFileSync(
    join(dir, "invalid.conf"),
    "events {}\nhttp { corematrix_invalid_directive on; }\n",
  );
  assert.throws(
    () =>
      execFileSync("docker", [...args, "-t", "-c", "/qa/invalid.conf"], {
        stdio: "pipe",
        timeout: 60000,
      }),
    (error) => error.status === 1,
  );
  console.log("PASS: invalid configuration is rejected");
  const architecture = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Architecture}}", image],
    { encoding: "utf8", timeout: 60000 },
  ).trim();
  assert(
    ["amd64", "arm64"].includes(architecture),
    "Unsupported test image architecture",
  );
  execFileSync(
    "go",
    [
      "test",
      "-c",
      "-o",
      join(dir, "runtime-tests"),
      join(root, "tests/nginx/runtime_test.go"),
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
  writeFileSync(
    join(dir, "runtime.conf"),
    `pid /tmp/nginx.pid;\nerror_log /tmp/master-error.log info;\nevents {}\nhttp {\n${configs.console}\n${configs.node}\n}\n`,
  );
  execFileSync(
    "docker",
    [
      ...args.slice(0, -3),
      "--entrypoint",
      "/qa/runtime-tests",
      image,
      "-test.v",
      "-test.timeout=45s",
    ],
    { stdio: "inherit", timeout: 60000 },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
