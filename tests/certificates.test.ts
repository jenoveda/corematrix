import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Certificates, validateCertificate } from "../server/certificates.ts";

test("certificate validation rejects mismatched keys, domains, malformed chains and expired certificates without leaking secrets", async t => {
  const dir = mkdtempSync(join(tmpdir(),"cm-certificates-"));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  for (const name of ["one","two"]) execFileSync("openssl",[
    "req","-x509","-newkey","rsa:2048","-nodes","-days","2",
    "-keyout",join(dir,name+".key"),"-out",join(dir,name+".crt"),"-subj","/CN=localhost",
    "-addext","subjectAltName=DNS:localhost,IP:127.0.0.1",
  ],{stdio:"ignore"});
  const first = {origin:"https://localhost",certificate:readFileSync(join(dir,"one.crt"),"utf8"),privateKey:readFileSync(join(dir,"one.key"),"utf8")};
  const second = {...first,certificate:readFileSync(join(dir,"two.crt"),"utf8"),privateKey:readFileSync(join(dir,"two.key"),"utf8")};
  assert.equal(validateCertificate(first).origin,first.origin);
  for (const value of [
    {...first,origin:"http://localhost"}, {...first,origin:"https://other.invalid"},
    {...first,origin:"https://localhost/path"}, {...first,privateKey:second.privateKey},
    {...first,certificate:first.certificate+"PRIVATE_SECRET"}, {...first,privateKey:"PRIVATE_SECRET"},
  ]) assert.throws(() => validateCertificate(value), e => {
    assert(e instanceof Error); assert(!e.message.includes("PRIVATE_SECRET")); assert(!e.message.includes("BEGIN PRIVATE")); return true;
  });
  const now = Date.now();
  const clock = t.mock.method(Date,"now",() => now + 10*86400000);
  assert.throws(() => validateCertificate(first)); clock.mock.restore();
  const path = join(dir,"platform-tls.json");
  const manager = new Certificates(path,{user:0,admin:0,provider:0},{user:8080,admin:8081,provider:8082});
  t.after(() => manager.close());
  const pending = manager.save("user",first,"actor-1");
  await assert.rejects(manager.save("admin",second,"actor-2"),{code:"certificate_busy"});
  await pending;
  const original = manager.list()[0];
  assert.equal(original.configured,true); assert.equal(statSync(path).mode & 0o777,0o600);
  assert(!JSON.stringify(manager.list()).includes("PRIVATE KEY"));
  assert(!JSON.stringify(manager.list()).includes("certificate\""));
  await assert.rejects(manager.save("user",{...first,privateKey:second.privateKey},"actor-2"));
  assert.deepEqual(manager.list()[0],original);
  await manager.save("user",second,"actor-2");
  assert.notEqual(manager.list()[0].fingerprint,original.fingerprint);
  await assert.rejects(manager.save("admin",first,"actor-2"));
  await manager.close();
  const restarted = new Certificates(path,{user:0,admin:0,provider:0},{user:8080,admin:8081,provider:8082});
  t.after(() => restarted.close()); await restarted.start();
  assert.equal(restarted.list()[0].fingerprint,manager.list()[0].fingerprint);
});
