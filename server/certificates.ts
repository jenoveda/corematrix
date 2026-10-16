import { X509Certificate, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { createSecureContext } from "node:tls";
import { createServer } from "node:https";
import type { Server } from "node:https";
import { request } from "node:http";
import { isIP } from "node:net";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { once } from "node:events";
import { check, object, text, HttpError } from "./validation.ts";

type Configuration = { origin: string; certificate: string; privateKey: string; updatedAt: string; actorId: string };
import type { CertificateInfo, Portal } from "../src/domain.ts";
export function validateCertificate(value: unknown, allowExpired = false) {
  const data = object(value), origin = text(data.origin, "origin", 300);
  let url: URL;
  try { url = new URL(origin); } catch { throw new HttpError(400, "Invalid HTTPS origin", "invalid_certificate"); }
  check(url.protocol === "https:" && url.href === url.origin + "/" && !url.username && !url.password, "A fixed HTTPS origin is required", 400, "invalid_certificate");
  const certificate = text(data.certificate, "certificate", 32768), privateKey = text(data.privateKey, "privateKey", 16384);
  try {
    const blocks = certificate.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    if (!blocks.length || blocks.length > 10 || certificate.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) throw Error();
    const chain = blocks.map(pem => new X509Certificate(pem)), leaf = chain[0], now = Date.now();
    if (chain.some(cert => !Number.isFinite(Date.parse(cert.validFrom)) || !Number.isFinite(Date.parse(cert.validTo)) || Date.parse(cert.validFrom) > now || (!allowExpired && Date.parse(cert.validTo) <= now))) throw Error();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!(isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host, { subject: "never" }))) throw Error();
    const key = createPrivateKey(privateKey), publicKey = createPublicKey(key);
    if (!publicKey.export({type:"spki",format:"der"}).equals(leaf.publicKey.export({type:"spki",format:"der"}))) throw Error();
    if (!["rsa", "rsa-pss", "ec", "ed25519", "ed448"].includes(publicKey.asymmetricKeyType || "")) throw Error();
    if (["rsa", "rsa-pss"].includes(publicKey.asymmetricKeyType || "") && (publicKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw Error();
    if (publicKey.asymmetricKeyType === "ec" && !["prime256v1", "secp384r1", "secp521r1"].includes(publicKey.asymmetricKeyDetails?.namedCurve || "")) throw Error();
    if (leaf.keyUsage?.length && !leaf.keyUsage.some(oid => ["1.3.6.1.5.5.7.3.1", "2.5.29.37.0"].includes(oid))) throw Error();
    for (let i = 0; i < chain.length - 1; i++) if (!chain[i].checkIssued(chain[i+1]) || !chain[i].verify(chain[i+1].publicKey)) throw Error();
    createSecureContext({cert: certificate, key: privateKey, minVersion:"TLSv1.2"});
    return {origin: url.origin, certificate, privateKey};
  } catch { throw new HttpError(400, "Certificate, domain, validity or private key is invalid", "invalid_certificate"); }
}

export class Certificates {
  private configurations: Partial<Record<Portal, Configuration>> = {};
  private servers: Partial<Record<Portal, Server>> = {};
  private busy = false;
  private path: string;
  private ports: Record<Portal, number>;
  private upstreamPorts: Record<Portal, number>;
  constructor(path: string, ports: Record<Portal, number>, upstreamPorts: Record<Portal, number>) {
    this.path = path; this.ports = ports; this.upstreamPorts = upstreamPorts;
  }
  origin(portal: Portal) { return this.configurations[portal]?.origin; }
  list(): CertificateInfo[] {
    return (["user", "admin", "provider"] as Portal[]).map(portal => {
      const config = this.configurations[portal];
      if (!config) return {portal, configured:false};
      const cert = new X509Certificate(config.certificate);
      return {portal, configured:true, origin:config.origin, subject:cert.subject, issuer:cert.issuer,
        validFrom:new Date(cert.validFrom).toISOString(), validTo:new Date(cert.validTo).toISOString(),
        fingerprint:cert.fingerprint256, updatedAt:config.updatedAt, expired:Date.parse(cert.validTo) <= Date.now()};
    });
  }
  private async apply(portal: Portal, config: Configuration) {
    const options = {cert: config.certificate, key: config.privateKey, minVersion:"TLSv1.2" as const};
    const existing = this.servers[portal];
    if (existing) { existing.setSecureContext(options); return; }
    // shortcut: HTTP/SSE only; reload HTTPS development pages after code changes instead of Vite HMR.
    const server = createServer(options, (req, res) => {
      let matches = false;
      try { matches = new URL(`https://${req.headers.host}`).origin === this.origin(portal); } catch {}
      if (!matches) { res.writeHead(421); res.end(); return; }
      const headers = {...req.headers};
      for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-proto", "x-real-ip", "x-corematrix-client-ip", "x-corematrix-proto"])
        delete headers[name];
      headers["x-corematrix-client-ip"] = req.socket.remoteAddress || "127.0.0.1";
      headers["x-corematrix-proto"] = "https";
      const upstream = request({hostname:"127.0.0.1",port:this.upstreamPorts[portal],path:req.url,method:req.method,headers}, response => {
        res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
      req.pipe(upstream);
    });
    server.headersTimeout = 15000; server.requestTimeout = 90000;
    server.listen(this.ports[portal], "0.0.0.0");
    try { await once(server, "listening"); } catch { server.close(); throw new HttpError(503, "TLS listener unavailable", "certificate_unavailable"); }
    this.servers[portal] = server;
  }
  async start() {
    if (!existsSync(this.path)) return;
    const saved = object(JSON.parse(readFileSync(this.path, "utf8")));
    for (const portal of ["user", "admin", "provider"] as Portal[]) {
      if (!saved[portal]) continue;
      const config = object(saved[portal]);
      // Expired stored certificates stay visible and renewable; startup must not discard their configuration.
      const normalized = {...validateCertificate(config,true),updatedAt:text(config.updatedAt,"updatedAt",100),actorId:text(config.actorId,"actorId",100)};
      this.configurations[portal] = normalized;
      await this.apply(portal, normalized);
    }
  }
  async save(portal: Portal, value: unknown, actorId: string) {
    check(!this.busy, "Certificate update already running", 409, "certificate_busy");
    const validated = validateCertificate(value);
    check(!Object.entries(this.configurations).some(([other,configuration])=>other!==portal && configuration.origin===validated.origin), "Portal HTTPS origins must differ", 400, "invalid_certificate");
    this.busy = true;
    const previous = this.configurations[portal], existed = !!this.servers[portal];
    const config = {...validated, actorId, updatedAt:new Date().toISOString()};
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      await this.apply(portal, config);
      mkdirSync(dirname(this.path), {recursive:true,mode:0o700});
      writeFileSync(temporary, JSON.stringify({...this.configurations,[portal]:config}), {mode:0o600,flag:"wx",flush:true});
      renameSync(temporary,this.path);
      this.configurations[portal] = config;
      return this.list();
    } catch (e) {
      if (previous) await this.apply(portal, previous);
      else if (!existed && this.servers[portal]) { this.servers[portal]!.close(); delete this.servers[portal]; }
      if (e instanceof HttpError) throw e;
      throw new HttpError(503, "Certificate could not be saved", "certificate_unavailable");
    } finally { rmSync(temporary,{force:true}); this.busy = false; }
  }
  async close() {
    await Promise.all(Object.values(this.servers).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    this.servers = {};
  }
}
