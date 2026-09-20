import { LOCAL_API_HOST } from "@real-bot/protocol";

export type LocalEndpoint = {
  origin: string;
  token: string;
};

/** Same loopback family as the messenger page, so Chrome does not treat the call as local-network access. */
export function loopbackOrigin(port: number, pageOrigin?: string): string {
  let host: string = LOCAL_API_HOST;
  if (pageOrigin) {
    try {
      const hostname = new URL(pageOrigin).hostname;
      const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
      if (bare === "::1") host = "[::1]";
    } catch {
      // keep IPv4 loopback
    }
  }
  return `http://${host}:${port}`;
}

export function parseDiscovery(body: unknown, pageOrigin?: string): LocalEndpoint | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { port?: unknown; token?: unknown };
  if (typeof record.port !== "number" || !Number.isFinite(record.port)) return null;
  if (typeof record.token !== "string" || record.token.length === 0) return null;
  return { origin: loopbackOrigin(record.port, pageOrigin), token: record.token };
}

export function parseTauriEndpoint(body: unknown): LocalEndpoint | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { origin?: unknown; token?: unknown };
  if (typeof record.origin !== "string" || record.origin.length === 0) return null;
  if (typeof record.token !== "string" || record.token.length === 0) return null;
  return { origin: record.origin, token: record.token };
}

