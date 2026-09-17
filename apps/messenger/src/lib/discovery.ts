import { LOCAL_API_DISCOVERY_PATH, LOCAL_API_HOST } from "@real-bot/protocol";

export type LocalEndpoint = {
  origin: string;
  token: string;
};

export function parseDiscovery(body: unknown): LocalEndpoint | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { port?: unknown; token?: unknown };
  if (typeof record.port !== "number" || !Number.isFinite(record.port)) return null;
  if (typeof record.token !== "string" || record.token.length === 0) return null;
  return { origin: `http://${LOCAL_API_HOST}:${record.port}`, token: record.token };
}

export function parseTauriEndpoint(body: unknown): LocalEndpoint | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { origin?: unknown; token?: unknown };
  if (typeof record.origin !== "string" || record.origin.length === 0) return null;
  if (typeof record.token !== "string" || record.token.length === 0) return null;
  return { origin: record.origin, token: record.token };
}

type TauriInternals = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

export async function discoverEndpoint(
  fetchFn: typeof fetch = fetch,
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<LocalEndpoint | null> {
  if (internals?.invoke) {
    try {
      const ep = await internals.invoke("local_api_endpoint");
      return parseTauriEndpoint(ep);
    } catch {
      return null;
    }
  }
  try {
    const res = await fetchFn(LOCAL_API_DISCOVERY_PATH);
    if (!res.ok) return null;
    return parseDiscovery(await res.json());
  } catch {
    return null;
  }
}

function readTauriInternals(): TauriInternals | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const w = globalThis as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__;
}
