/**
 * The proxy a Claude Agent turn's Claude Code reaches Anthropic through (ADR 0061). The usual
 * variables come first and pass through untouched: `HTTPS_PROXY`, then `ALL_PROXY`, with `NO_PROXY`
 * taking the host out. With none of them set, the system's own HTTPS proxy is handed to Claude Code
 * as `HTTPS_PROXY`: `scutil --proxy` on macOS, the current user's Internet Settings on Windows. A
 * daemon started from a terminal carries the variables; the one the app starts from Finder, the
 * Start menu or at login carries none, and on a network that reaches Anthropic only through a proxy
 * the setting the browser follows is the only one there is — the desktop updater falls back the
 * same way (`apps/desktop/src-tauri/src/updates.rs`, whose parsers these are). Only `HTTPS_PROXY`
 * is set: a Bot's own `curl http://localhost:…` keeps going straight.
 */
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import { envLookup } from "../platform";

export type ClaudeProxy = { url: string; source: "env" | "system" };

/** The system's own proxy for `host`; null when there is none, or none this build follows. */
export type SystemProxy = (host: string) => Promise<string | null>;

const ANTHROPIC_HOST = "api.anthropic.com";
const LOCAL_HOSTS = "localhost,127.0.0.1,::1";
const INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

export async function claudeProxy(
  env: Record<string, string | undefined>,
  system: SystemProxy = systemProxyFor,
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeProxy | null> {
  const host = anthropicHost(env);
  if (bypassesProxy(host, envValue(env, "NO_PROXY", platform))) return null;
  const named = envValue(env, "HTTPS_PROXY", platform) ?? envValue(env, "ALL_PROXY", platform);
  if (named) return { url: named, source: "env" };
  if (bypassesProxy(host, LOCAL_HOSTS)) return null;
  const url = await system(host);
  return url ? { url, source: "system" } : null;
}

/** The environment with the system proxy filled in, when that is where the proxy came from. */
export function withSystemProxy(
  env: Record<string, string>,
  proxy: Pick<ClaudeCodeStatus, "proxy" | "proxy_source"> | null,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (proxy?.proxy_source !== "system" || !proxy.proxy) return env;
  const out: Record<string, string> = { ...env, HTTPS_PROXY: proxy.proxy };
  if (!envValue(env, "NO_PROXY", platform)) out.NO_PROXY = LOCAL_HOSTS;
  return out;
}

/** A proxy URL for the Settings card, with any user and password in it hidden. */
export function maskProxy(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1***@");
}

/** A proxy variable, either spelling: `HTTPS_PROXY` or `https_proxy`, any case at all on Windows. */
function envValue(env: Record<string, string | undefined>, name: string, platform: NodeJS.Platform): string | null {
  const raw = (envLookup(env, name, platform) ?? envLookup(env, name.toLowerCase(), platform))?.trim();
  return raw ? raw : null;
}

/** Where Claude Code sends its requests: `ANTHROPIC_BASE_URL`'s host when one is set. */
function anthropicHost(env: Record<string, string | undefined>): string {
  const base = env.ANTHROPIC_BASE_URL?.trim();
  if (!base) return ANTHROPIC_HOST;
  try {
    return new URL(base).hostname.replace(/^\[|\]$/g, "") || ANTHROPIC_HOST;
  } catch {
    return ANTHROPIC_HOST;
  }
}

/** Does a `NO_PROXY` list cover this host? `*` covers everything; an entry matches the host or any name under it. */
export function bypassesProxy(host: string, noProxy: string | null): boolean {
  if (!noProxy) return false;
  const name = host.trim().replace(/\.$/, "").toLowerCase();
  return noProxy.split(",").some((entry) => {
    const raw = entry.trim();
    if (raw === "*") return true;
    const bare = raw.replace(/^\*/, "").replace(/^\./, "").toLowerCase();
    return bare !== "" && (name === bare || name.endsWith(`.${bare}`));
  });
}

/** The system's HTTPS proxy for `host` on this machine: macOS and Windows have one to read. */
export async function systemProxyFor(host: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform === "darwin") {
    const dump = await readCommand(["/usr/sbin/scutil", "--proxy"]);
    return dump ? proxyFromScutil(host, dump) : null;
  }
  if (platform === "win32") {
    const systemRoot = envLookup(process.env, "SystemRoot", "win32") ?? "C:\\Windows";
    const out = await readCommand([`${systemRoot.replace(/\\+$/, "")}\\System32\\reg.exe`, "query", INTERNET_SETTINGS]);
    const values = out ? parseRegQuery(out) : null;
    if (!values) return null;
    const enabled = Number.parseInt(values.get("proxyenable") ?? "0", 16) !== 0;
    return proxyFromWindowsSettings(host, enabled, values.get("proxyserver") ?? "", values.get("proxyoverride") ?? "");
  }
  return null;
}

/**
 * The HTTPS proxy macOS would use for `host`, from `scutil --proxy`: the secure web proxy in System
 * Settings › Network › Proxies, which browsers follow and proxy apps switch on. `ExceptionsList`
 * takes the host out as `NO_PROXY` does. Only the top-level dictionary counts (`__SCOPED__` holds
 * per-interface copies); a PAC file or a SOCKS-only setup gives null. A port of the updater's
 * `proxy_from_scutil`.
 */
export function proxyFromScutil(host: string, dump: string): string | null {
  let depth = 0;
  let inExceptions = false;
  const fields = new Map<string, string>();
  const exceptions: string[] = [];
  for (const raw of dump.split("\n")) {
    const line = raw.trim();
    if (line === "}") {
      depth = Math.max(0, depth - 1);
      inExceptions = inExceptions && depth > 1;
      continue;
    }
    const opens = line.endsWith("{");
    const split = line.indexOf(" : ");
    if (split >= 0) {
      const name = line.slice(0, split);
      const value = line.slice(split + 3);
      if (depth === 1 && opens) inExceptions = name === "ExceptionsList";
      else if (depth === 1) fields.set(name, value.trim());
      else if (depth === 2 && inExceptions) exceptions.push(value.trim());
    }
    if (opens) depth += 1;
  }
  if (fields.get("HTTPSEnable") !== "1") return null;
  const server = fields.get("HTTPSProxy");
  const port = Number.parseInt(fields.get("HTTPSPort") ?? "", 10);
  if (!server || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  if (bypassesProxy(host, exceptions.join(","))) return null;
  return `http://${server}:${port}`;
}

/**
 * The values `reg query <key>` prints for the key itself, by lower-cased name:
 * `    ProxyEnable    REG_DWORD    0x1`. Subkey lines carry no indent and are skipped. Null when
 * nothing parsed (no such key, or an answer in some other shape).
 */
export function parseRegQuery(out: string): Map<string, string> | null {
  const values = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const match = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    if (match) values.set(match[1]!.toLowerCase(), (match[3] ?? "").trim());
  }
  return values.size > 0 ? values : null;
}

/**
 * The proxy Windows would use for `host`, from the current user's Internet Settings: the "Use a
 * proxy server" switch in Settings › Network & internet › Proxy, which browsers follow and proxy
 * apps flip when they turn on "system proxy". `server` is `host:port` for every protocol, or per
 * protocol as `http=host:port;https=host:port;socks=host:port`, where `https` is the one that counts
 * and a lone `http` entry serves it too. `overrides` is the `;`-separated bypass list, `*` wildcards
 * and all, where `<local>` means any name without a dot. A PAC script or a SOCKS-only setup gives
 * null. A port of the updater's `proxy_from_windows_settings`.
 */
export function proxyFromWindowsSettings(host: string, enabled: boolean, server: string, overrides: string): string | null {
  if (!enabled) return null;
  const trimmed = server.trim();
  const entry = (scheme: string) => {
    for (const part of trimmed.split(";")) {
      const at = part.indexOf("=");
      if (at >= 0 && part.slice(0, at).trim().toLowerCase() === scheme) return part.slice(at + 1).trim();
    }
    return null;
  };
  const address = trimmed.includes("=") ? entry("https") ?? entry("http") : trimmed;
  if (!address || windowsBypassesProxy(host, overrides)) return null;
  const lower = address.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return address;
  if (lower.includes("://")) return null;
  return `http://${address}`;
}

/**
 * Does a Windows `ProxyOverride` list cover this host? Entries are case-insensitive globs over the
 * whole host (`*.corp.example`, `10.*`); `<local>` covers any name without a dot.
 */
function windowsBypassesProxy(host: string, overrides: string): boolean {
  const name = host.trim().replace(/\.$/, "").toLowerCase();
  return overrides.split(";").some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "<local>") return !name.includes(".");
    return entry !== "" && globMatches(entry, name);
  });
}

function globMatches(pattern: string, text: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === text;
  const first = parts[0]!;
  const last = parts.at(-1)!;
  if (!text.startsWith(first) || text.length < first.length + last.length || !text.endsWith(last)) return false;
  let rest = text.slice(first.length, text.length - last.length);
  for (const middle of parts.slice(1, -1)) {
    const at = rest.indexOf(middle);
    if (at < 0) return false;
    rest = rest.slice(at + middle.length);
  }
  return true;
}

/** A system tool's output, or null when it cannot run, fails, or takes more than three seconds. */
async function readCommand(argv: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    const timer = setTimeout(() => proc.kill(), 3_000);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}
