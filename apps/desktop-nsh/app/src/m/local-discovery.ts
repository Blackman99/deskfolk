import { LOCAL_API_DISCOVERY_PATH } from "@real-bot/protocol/local-discovery";
import { parseDiscovery, parseShellEndpoint, type LocalEndpoint } from "./discovery.ts";
import { readShellBridge, type ShellBridge } from "./desktop-shell.ts";

function pageOriginFromWindow(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return location.origin;
}

export async function discoverEndpoint(
  fetchFn: typeof fetch = fetch,
  internals: ShellBridge | undefined = readShellBridge(),
  pageOrigin: string | undefined = pageOriginFromWindow(),
): Promise<LocalEndpoint | null> {
  if (internals?.invoke) {
    try {
      const ep = await internals.invoke("local_api_endpoint");
      return parseShellEndpoint(ep);
    } catch {
      return null;
    }
  }
  try {
    const res = await fetchFn(LOCAL_API_DISCOVERY_PATH);
    if (!res.ok) return null;
    return parseDiscovery(await res.json(), pageOrigin);
  } catch {
    return null;
  }
}
