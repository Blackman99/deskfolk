/**
 * Whether an endpoint runs on this computer or this network (ADR 0067): a model server such as
 * Ollama, LM Studio or llama.cpp's `llama-server`, which takes no key and, past its context window,
 * quietly cuts the prompt instead of refusing it. Such an endpoint may be saved without a key, and
 * its requests get the checks and time limits a model on this hardware needs.
 *
 * Read from the address alone: loopback, `localhost` and `*.localhost`, `*.local` (mDNS), the private
 * IPv4 ranges (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10) and unique-local
 * IPv6 (fc00::/7). A public name that happens to resolve to one of these is not recognised.
 */
export function isLocalEndpoint(baseUrl: string | null | undefined): boolean {
  const host = hostOf((baseUrl ?? "").trim());
  if (!host) return false;
  if (host.startsWith("[") && host.endsWith("]")) return isLocalIpv6(host.slice(1, -1));
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const v4 = ipv4Octets(host);
  if (v4) return isLocalIpv4(v4);
  return false;
}

/**
 * The host of an absolute URL, lower-cased, IPv6 kept in its brackets; null when there is none.
 * Read by hand: this package runs where `URL` may not be declared.
 */
function hostOf(raw: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[0-9a-f:.]+\]|[^:/?#\s]+)/i.exec(raw);
  return match ? match[1]!.toLowerCase().replace(/\.$/, "") : null;
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isLocalIpv4([a, b]: number[]): boolean {
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a === 169 && b === 254;
}

function isLocalIpv6(host: string): boolean {
  if (host === "::1" || host === "::") return true;
  // An IPv4 address written as IPv6: `::ffff:127.0.0.1`, or the same in hex (`::ffff:7f00:1`).
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted) {
    const octets = ipv4Octets(dotted[1]!);
    return octets !== null && isLocalIpv4(octets);
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16);
    const low = parseInt(mapped[2]!, 16);
    return isLocalIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  const first = parseInt(host.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true;
  return (first & 0xffc0) === 0xfe80;
}
