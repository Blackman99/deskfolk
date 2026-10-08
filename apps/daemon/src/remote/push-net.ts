/** Sending a push only to public addresses: the resolved IPs are checked and pinned before the request goes out. */
import { HttpsProxyAgent, type HttpsProxyAgentOptions } from "https-proxy-agent";
import { default as dns } from "node:dns";
import { default as https } from "node:https";
import { default as net } from "node:net";
import { getProxyForUrl } from "proxy-from-env";
import { HttpError } from "../errors";
import { isAllowedPushHost, parsePushEndpoint } from "./push-endpoint";

const MAX_PUSH_RESPONSE_BYTES = 64 * 1024;

function ipv4Octets(addr: string): [number, number, number, number] | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return NaN;
    return Number(part);
  });
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets as [number, number, number, number];
}

function isForbiddenIpv4(addr: string): boolean {
  const parts = ipv4Octets(addr);
  if (!parts) return true;
  const [b0, b1, b2] = parts;
  if (b0 === 0) return true;
  if (b0 === 10) return true;
  if (b0 === 127) return true;
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  if (b0 === 169 && b1 === 254) return true;
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;
  if (b0 === 192 && b1 === 168) return true;
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;
  if (b0 >= 224) return true;
  return false;
}

function expandIpv6Groups(addr: string): string[] | null {
  const lower = addr.trim().toLowerCase();
  if (!lower || lower.includes("%")) return null;
  const lastColon = lower.lastIndexOf(":");
  const dotted = lastColon >= 0 ? lower.slice(lastColon + 1) : "";
  let head = lower;
  let ipv4Tail: [number, number, number, number] | null = null;
  if (ipv4Octets(dotted)) {
    ipv4Tail = ipv4Octets(dotted);
    head = lower.slice(0, lastColon);
  }
  const sides = head.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] && sides[0].length > 0 ? sides[0].split(":") : [];
  const right = sides.length === 2 && sides[1] && sides[1].length > 0 ? sides[1].split(":") : [];
  const groups = [...left, ...right];
  if (groups.some((group) => group.length === 0 || group.length > 4 || /[^0-9a-f]/.test(group))) return null;
  const expected = ipv4Tail ? 6 : 8;
  if (sides.length === 1) {
    if (groups.length !== expected) return null;
  } else if (groups.length > expected) {
    return null;
  } else {
    const missing = expected - groups.length;
    groups.splice(left.length, 0, ...Array.from({ length: missing }, () => "0"));
  }
  const expanded = groups.map((group) => group.padStart(4, "0"));
  if (ipv4Tail) {
    expanded.push(((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16).padStart(4, "0"));
    expanded.push(((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16).padStart(4, "0"));
  }
  return expanded.length === 8 ? expanded : null;
}

function ipv6Bytes(addr: string): Uint8Array | null {
  const groups = expandIpv6Groups(addr);
  if (!groups) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const value = Number.parseInt(groups[i]!, 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function ipv4FromTail(bytes: Uint8Array): string {
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

function prefixEquals(bytes: Uint8Array, prefix: number[], bitLength: number): boolean {
  const fullBytes = Math.floor(bitLength / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== (prefix[i] ?? 0)) return false;
  }
  const remaining = bitLength % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return ((bytes[fullBytes] ?? 0) & mask) === ((prefix[fullBytes] ?? 0) & mask);
}

function isForbiddenIpv6(addr: string): boolean {
  const bytes = ipv6Bytes(addr);
  if (!bytes) return true;
  const mapped = prefixEquals(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96);
  const compatible = prefixEquals(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96) &&
    !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && (bytes[15] === 0 || bytes[15] === 1));
  const nat64 = prefixEquals(bytes, [0x00, 0x64, 0xff, 0x9b], 96);
  if (mapped || compatible || nat64) return isForbiddenIpv4(ipv4FromTail(bytes));
  if (bytes.every((b) => b === 0)) return true;
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  return false;
}

export function isPrivateOrForbiddenIp(ip: string): boolean {
  const addr = ip.trim();
  const family = net.isIP(addr);
  if (family === 4) return isForbiddenIpv4(addr);
  if (family === 6) return isForbiddenIpv6(addr);
  return true;
}

type LookupOptions = { all?: boolean };

function assertPublicAddresses(addresses: readonly dns.LookupAddress[]): dns.LookupAddress {
  if (addresses.length === 0) throw new Error("anti_ssrf_dns_empty");
  for (const item of addresses) {
    if (isPrivateOrForbiddenIp(item.address)) throw new Error(`anti_ssrf_forbidden_ip: ${item.address}`);
  }
  return addresses[0]!;
}

/** Resolve every address, reject any forbidden one, and pin the first public address. */
function lookupPinned(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    try {
      const first = assertPublicAddresses(addresses ?? []);
      if (options.all) callback(null, [first]);
      else callback(null, first.address, first.family);
    } catch (error) {
      callback(error as NodeJS.ErrnoException, "", 4);
    }
  });
}

/** CONNECT to the pinned IP. TLS SNI and the Host header stay the endpoint hostname. */
class PinnedHttpsProxyAgent<Uri extends string> extends HttpsProxyAgent<Uri> {
  constructor(proxy: Uri, opts?: HttpsProxyAgentOptions<Uri>) {
    super(proxy, opts);
  }

  override connect(req: import("node:http").ClientRequest, opts: Parameters<HttpsProxyAgent<Uri>["connect"]>[1]) {
    const named = "servername" in opts ? opts.servername : undefined;
    const hostname = named ?? (net.isIP(opts.host ?? "") ? undefined : opts.host);
    if (!hostname || net.isIP(hostname) || !isAllowedPushHost(hostname)) {
      return Promise.reject(new Error("anti_ssrf_forbidden_host"));
    }
    return new Promise<Awaited<ReturnType<HttpsProxyAgent<Uri>["connect"]>>>((resolve, reject) => {
      lookupPinned(hostname, {}, (err, address) => {
        if (err || typeof address !== "string") return reject(err ?? new Error("anti_ssrf_dns_empty"));
        if (!opts.secureEndpoint) return reject(new Error("anti_ssrf_forbidden_host"));
        resolve(super.connect(req, { ...opts, host: address, servername: hostname }));
      });
    });
  }
}

export function createSafePushFetch(): PushFetch {
  const direct = new https.Agent({ keepAlive: false, lookup: lookupPinned });
  const proxyAgents = new Map<string, HttpsProxyAgent<string>>();

  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const urlStr = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
      const url = parsePushEndpoint(urlStr);
      const proxy = getProxyForUrl(url.href);
      let agent: https.Agent = direct;
      if (proxy) {
        let pinned = proxyAgents.get(proxy);
        if (!pinned) {
          pinned = new PinnedHttpsProxyAgent(proxy, { keepAlive: false });
          proxyAgents.set(proxy, pinned);
        }
        agent = pinned;
      }

      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const req = https.request(url, {
        method: init?.method ?? "POST",
        headers: init?.headers as Record<string, string>,
        agent,
        servername: url.hostname,
        signal: init?.signal as AbortSignal | undefined,
      }, (res) => {
        const status = res.statusCode ?? 500;
        if (status >= 300 && status < 400) {
          res.resume();
          return fail(new HttpError(422, "redirect_forbidden", "redirects are not permitted"));
        }
        let received = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          const buf = Buffer.from(chunk);
          received += buf.length;
          if (received > MAX_PUSH_RESPONSE_BYTES) {
            res.destroy(new Error("response_too_large"));
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
          }
          resolve(new Response(body, { status, statusText: res.statusMessage, headers }));
        });
        res.on("error", fail);
      });

      req.on("error", fail);
      const signal = init?.signal;
      const onAbort = () => {
        fail(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        req.destroy();
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        req.once("close", () => signal.removeEventListener("abort", onAbort));
      }
      req.on("proxyConnect", (connect: { statusCode?: number }) => {
        if (connect.statusCode !== 200) {
          req.destroy(new Error(`proxy_connect_failed: ${connect.statusCode ?? 0}`));
        }
      });

      if (init?.body) {
        if (init.body instanceof Uint8Array || Buffer.isBuffer(init.body)) {
          req.write(Buffer.from(init.body));
        } else if (typeof init.body === "string") {
          req.write(init.body);
        }
      }
      req.end();
    });
  };
}

export type PushFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
