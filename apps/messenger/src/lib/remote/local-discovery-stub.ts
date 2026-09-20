import type { LocalEndpoint } from "../discovery.ts";

/** Hosted builds alias local discovery here so the Vite discovery path is not emitted. */
export async function discoverEndpoint(
  _fetchFn?: typeof fetch,
  _internals?: unknown,
  _pageOrigin?: string,
): Promise<LocalEndpoint | null> {
  return null;
}
