/** What both MCP session kinds share: protocol versions, client info, RPC errors and small waits. */


export const CLIENT_INFO = { name: "real-bot", version: "0.0.0" };
export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSION = "2025-11-25";

export function modernMeta(version = MODERN_VERSION): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
  };
}

/**
 * A Streamable HTTP server answered 404 to a request that carried our session id: it no longer
 * knows the session (it was restarted or redeployed) and did not run the request. The spec has the
 * client start a new session, and the request is safe to send again on it.
 */
export class McpSessionExpired extends Error {
  constructor() {
    super("mcp session expired");
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export async function drain(stream: ReadableStream<Uint8Array> | number | undefined): Promise<void> {
  if (!stream || typeof stream === "number") return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // ignore
  }
}

export function waitFor(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}
