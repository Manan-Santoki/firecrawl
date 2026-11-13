import { lookup } from "node:dns/promises";
import net from "node:net";

/**
 * Server-side request forgery guard. When BLOCK_PRIVATE_NETWORKS is enabled
 * (the default) the browser and the HTTP client refuse to contact loopback,
 * link-local, private, CGNAT, multicast and unspecified addresses, including
 * through redirects and sub-resources. The proxy, if configured, still
 * resolves the public target; this guard only inspects direct targets.
 */

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const value = ipv4ToInt(address);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return (
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("ff")
    );
  }
  return false;
}

const cache = new Map<string, { privateTarget: boolean; expires: number }>();

export async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host)) return isPrivateAddress(host);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const cached = cache.get(host);
  if (cached && cached.expires > Date.now()) return cached.privateTarget;
  let privateTarget = false;
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    privateTarget = addresses.some(entry => isPrivateAddress(entry.address));
  } catch {
    // Unresolvable hosts are left to the browser, which reports the DNS error.
    privateTarget = false;
  }
  if (cache.size > 5_000) cache.clear();
  cache.set(host, { privateTarget, expires: Date.now() + 60_000 });
  return privateTarget;
}

export async function isBlockedUrl(rawUrl: string, enabled: boolean): Promise<boolean> {
  if (!enabled) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isPrivateHost(url.hostname);
}
