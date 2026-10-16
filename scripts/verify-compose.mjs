import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "cm-compose-"));
chmodSync(dir, 0o700);
const project = "corematrix-compose-qa-" + randomBytes(6).toString("hex");
const override = join(dir, "override.yaml");
writeFileSync(override, "services:\n  api:\n    env_file: !reset []\n", { mode: 0o600 });
const args = ["compose", "--env-file", "/dev/null", "-p", project, "-f", join(root, "compose.yaml"), "-f", override];
const env = { ...process.env, COREMATRIX_BIND_IP: "127.0.0.1", COREMATRIX_PORT: "0", COREMATRIX_ADMIN_PORT: "0", COREMATRIX_PROVIDER_PORT:"0", COREMATRIX_HTTPS_PORT: "0", COREMATRIX_ADMIN_HTTPS_PORT: "0", COREMATRIX_PROVIDER_HTTPS_PORT:"0" };
function compose(more, extra = {}) {
  return execFileSync("docker", [...args, ...more], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 180000 });
}
let certificate, privateKey;
async function call(base, path, method = "GET", body, cookie = "", csrf = "", extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = (base.startsWith("https:") ? httpsRequest : httpRequest)(base + path, {
      ca: certificate,
      agent: false,
      ...(base.startsWith("https:") ? {servername:"localhost"} : {}),
      method,
      headers: { Origin: base, Cookie: cookie, "X-CSRF-Token": csrf,
        ...(encoded ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) } : {}), ...extraHeaders },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, text,
          data: response.headers["content-type"]?.includes("application/json") ? JSON.parse(text) : null,
          cookie: response.headers["set-cookie"]?.[0].split(";")[0] || "",
          rawCookie: response.headers["set-cookie"]?.[0] || "" });
      });
      response.on("error", reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error("HTTP test timed out")));
    req.on("error", error => reject(new Error(`${method} ${path} failed`, {cause:error}))); req.end(encoded);
  });
}
try {
  compose(["up", "-d", "--build", "--wait", "--wait-timeout", "90"]);
  const ports = {};
  for (const [key, internal] of Object.entries({COREMATRIX_PORT:8080,COREMATRIX_ADMIN_PORT:8081,COREMATRIX_PROVIDER_PORT:8082,COREMATRIX_HTTPS_PORT:3443,COREMATRIX_ADMIN_HTTPS_PORT:3444,COREMATRIX_PROVIDER_HTTPS_PORT:3445})) {
    ports[key] = compose(["port", "api", String(internal)]).trim().split(":").at(-1);
    env[key] = ports[key]; // Keep the externally configured HTTPS origins stable across container recreation.
  }
  const user = "http://127.0.0.1:" + ports.COREMATRIX_PORT, admin = "http://127.0.0.1:" + ports.COREMATRIX_ADMIN_PORT;
  const secureUser = "https://127.0.0.1:" + ports.COREMATRIX_HTTPS_PORT, secureAdmin = "https://127.0.0.1:" + ports.COREMATRIX_ADMIN_HTTPS_PORT;
  const provider="http://127.0.0.1:"+ports.COREMATRIX_PROVIDER_PORT, secureProvider="https://127.0.0.1:"+ports.COREMATRIX_PROVIDER_HTTPS_PORT;
  const providerPage=await call(provider,"/"); assert.equal(providerPage.status,200);
  const userPage = await call(user, "/"), adminPage = await call(admin, "/");
  assert.equal(userPage.status,200); assert.equal(adminPage.status,200); assert.notEqual(userPage.text,adminPage.text);
  for (const [base, page] of [[user,userPage],[admin,adminPage],[provider,providerPage]]) {
    const asset = page.text.match(/src="(\/assets\/[^\"]+\.js)"/)[1];
    assert.equal((await call(base,asset)).status,200);
  }
  const password = "Compose!" + randomBytes(16).toString("base64url");
  const credentials = {email:"user@tests.invalid",password,name:"Compose user"};
  const registered = await call(user,"/api/auth/register","POST",credentials);
  assert.equal(registered.status,201); assert.equal(registered.data.balance,0);
  assert.equal((await call(admin,"/api/auth/register","POST",credentials)).status,404);
  assert.equal((await call(user,"/api/admin/models","GET",undefined,registered.cookie)).status,404);
  assert.equal((await call(admin,"/api/auth/login","POST",credentials)).status,401);
  compose(["exec","-T","-e","ADMIN_EMAIL","-e","ADMIN_PASSWORD","api","node","server/create-admin.ts"],{ADMIN_EMAIL:"admin@tests.invalid",ADMIN_PASSWORD:password});
  const providerCredentials={...credentials,email:"supplier@tests.invalid"};
  const supplier=await call(provider,"/api/auth/register","POST",providerCredentials);
  assert.equal(supplier.status,201);assert.equal(supplier.data.user.role,"provider");
  assert.equal((await call(user,"/api/auth/login","POST",providerCredentials)).status,401);
  assert.equal((await call(provider,"/api/admin/providers","GET",undefined,supplier.cookie)).status,404);
  assert.equal((await call(provider,"/api/provider/profile","GET",undefined,supplier.cookie)).data.profile.status,"pending");
  const adminCredentials = {email:"admin@tests.invalid",password};
  assert.equal((await call(user,"/api/auth/login","POST",adminCredentials)).status,401);
  const loggedIn = await call(admin,"/api/auth/login","POST",adminCredentials);
  assert.equal(loggedIn.status,200); assert(loggedIn.cookie.startsWith("cm_admin_session="));
  assert.equal((await call(admin,"/api/admin/models","GET",undefined,registered.cookie.replace("cm_user_","cm_admin_"))).status,401);
  console.log("PASS: separate HTTP portals and session authentication");
  execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-days","2","-keyout",join(dir,"key.pem"),"-out",join(dir,"cert.pem"),"-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost,IP:127.0.0.1"],{stdio:"pipe"});
  certificate = readFileSync(join(dir,"cert.pem"),"utf8"); privateKey = readFileSync(join(dir,"key.pem"),"utf8");
  const secretQuery = "privacy-" + randomBytes(16).toString("hex");
  for (const [portal, origin] of [["user",secureUser],["provider",secureProvider],["admin",secureAdmin]]) {
    const result = await call(admin,"/api/admin/certificates/"+portal,"PUT",{origin,certificate,privateKey},loggedIn.cookie,loggedIn.data.csrfToken);
    assert.equal(result.status,200); assert(!result.text.includes("PRIVATE KEY"));
  }
  assert.equal((await call(user,"/api/portal")).data.origin,secureUser);
  assert.equal((await call(admin,"/api/portal")).data.origin,secureAdmin);
  assert.equal((await call(user,"/api/auth/login","POST",credentials)).status,426);
  assert.equal((await call(secureUser,"/")).status,200);
  assert.equal((await call(secureAdmin,"/")).status,200);
  assert.equal((await call(secureProvider,"/")).status,200);
  assert.equal((await call(secureProvider,"/api/auth/login","POST",providerCredentials)).data.user.role,"provider");
  const secureLogin = await call(secureUser,"/api/auth/login","POST",credentials);
  assert.equal(secureLogin.status,200); assert(secureLogin.rawCookie.includes("; Secure"));
  assert.equal((await call(secureAdmin,"/api/admin/models","GET",undefined,loggedIn.cookie)).status,200);
  assert.equal((await call(secureUser,"/api/health?token="+secretQuery)).status,200);
  assert.equal((await call(secureUser,"/api/health","GET",undefined,"","",{Host:"foreign.invalid"})).status,421);
  const invalid = await call(secureAdmin,"/api/admin/certificates/user","PUT",{origin:secureUser,certificate,privateKey:"PRIVATE_SECRET"},loggedIn.cookie,loggedIn.data.csrfToken);
  assert.equal(invalid.status,400); assert(!invalid.text.includes("PRIVATE_SECRET"));
  assert.equal((await call(secureUser,"/api/health")).status,200);
  assert(!compose(["logs","--no-color","web"]).includes(secretQuery));
  const inspection = JSON.parse(compose(["exec","-T","api","node","--input-type=module","-e","import {existsSync,statSync} from 'node:fs'; console.log(JSON.stringify({uid:process.getuid(),env:existsSync('/app/.env'),data:existsSync('/app/data'),mode:statSync('/var/lib/corematrix/platform-tls.json').mode & 511}));"]));
  assert.deepEqual(inspection,{uid:1000,env:false,data:false,mode:384});
  assert.equal(compose(["exec","-T","web","id","-u"]).trim(),"101");
  console.log("PASS: certificate-verified HTTPS, failed replacement and private key permissions");
  compose(["down"]); compose(["up","-d","--no-build","--wait","--wait-timeout","90"]);
  assert.equal((await call(secureUser,"/api/auth/login","POST",credentials)).data.user.id,registered.data.user.id);
  assert.equal((await call(secureAdmin,"/api/auth/login","POST",adminCredentials)).data.user.role,"admin");
  assert.equal((await call(secureProvider,"/api/auth/login","POST",providerCredentials)).data.user.id,supplier.data.user.id);
  console.log("PASS: Linux Compose three portals, isolated authentication, verified TLS, Secure cookies, private key permissions, replacement failure, safe logs and persistence after recreation");
} finally {
  assert(project.startsWith("corematrix-compose-qa-"));
  try { compose(["down","--volumes","--remove-orphans","--rmi","local"]); }
  finally { rmSync(dir,{recursive:true,force:true}); }
}
