import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { check } from "./validation.ts";

function canonical(value: string | undefined): string | undefined {
  if (!value || value.includes("%")) return;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = normalized.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
  if (!mapped) return normalized;
  const high = parseInt(mapped[1], 16),
    low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}
export function clientIpResolver(addresses: string[] = []) {
  check(addresses.length <= 32, "At most 32 trusted proxy IPs are allowed");
  const trusted = new Set(
    addresses.map((address) => {
      const ip = canonical(address);
      check(ip, "TRUSTED_PROXY_IPS requires exact IPv4 or IPv6 addresses");
      return ip;
    }),
  );
  return (req: IncomingMessage) => {
    const peer = canonical(req.socket.remoteAddress) || "unknown";
    if (!trusted.has(peer)) return peer;
    const header = req.headers["x-forwarded-for"];
    if (typeof header !== "string" || header.length > 1024) return peer;
    const chain = header.split(",");
    if (chain.length > 8) return peer;
    const ips = chain.map((value) => canonical(value.trim()));
    if (ips.some((ip) => !ip)) return peer;
    let current = peer;
    // Walk only through trusted hops; client-supplied prefixes cannot replace the first untrusted sender.
    for (let i = ips.length - 1; i >= 0 && trusted.has(current); i--)
      current = ips[i]!;
    return current;
  };
}
