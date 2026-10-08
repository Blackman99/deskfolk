/** An MCP server reached over Streamable HTTP, with its SSE replies. */
import type { McpHeader } from "@real-bot/protocol";
import { listMcpTools, readInstructions, type Era, type McpServerSpec, type McpSession } from "../mcp-host";
import type { McpListedTool } from "../mcp-names";
import { CLIENT_INFO, LEGACY_VERSION, McpSessionExpired, MODERN_VERSION, modernMeta, RpcError } from "./rpc";

export class HttpSession implements McpSession {
  dead = false;
  private nextId = 1;
  private era: Era = "legacy";
  private sessionId: string | null = null;
  private protocolVersion = LEGACY_VERSION;
  private readonly deadHooks: Array<() => void> = [];
  private closing: Promise<void> | null = null;
  private readonly url: string;
  private readonly headers: McpHeader[];
  private readonly auth: string | null;
  private readonly requestTimeoutMs: number;
  private readonly streamIdleMs: number;

  constructor(server: McpServerSpec, requestTimeoutMs: number, streamIdleMs: number) {
    this.url = server.url ?? "";
    this.headers = server.headers ?? [];
    this.auth = server.auth ?? null;
    this.requestTimeoutMs = requestTimeoutMs;
    this.streamIdleMs = streamIdleMs;
  }

  onDead(hook: () => void): void {
    this.deadHooks.push(hook);
  }

  async handshake(): Promise<string | null> {
    try {
      const modern = await this.request("server/discover", { _meta: modernMeta() }, undefined, "modern");
      this.era = "modern";
      this.protocolVersion = MODERN_VERSION;
      return readInstructions(modern);
    } catch (error) {
      const code = error instanceof RpcError ? error.code : null;
      if (code === -32022) {
        this.era = "modern";
        this.protocolVersion = MODERN_VERSION;
        return null;
      }
      this.sessionId = null;
      if (error instanceof RpcError || (error instanceof Error && error.message.startsWith("mcp http"))) {
        // fall through to legacy initialize
      } else {
        throw error;
      }
    }
    const result = await this.request(
      "initialize",
      {
        protocolVersion: LEGACY_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      undefined,
      "legacy",
    );
    this.era = "legacy";
    this.protocolVersion =
      typeof result.protocolVersion === "string" ? result.protocolVersion : LEGACY_VERSION;
    await this.notify("notifications/initialized", {});
    return readInstructions(result);
  }

  async listTools(): Promise<McpListedTool[]> {
    return listMcpTools((params, signal) => this.request("tools/list", params, signal, this.era));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request("tools/call", { name, arguments: args }, signal, this.era);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.shutdown();
    return this.closing;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.dead) return;
    await this.post({ jsonrpc: "2.0", method, params: this.withMeta(method, params, false, this.era) }, undefined);
  }

  private async request(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    era: Era = this.era,
  ): Promise<Record<string, unknown>> {
    if (this.dead) throw new Error("mcp server exited");
    if (signal?.aborted) throw new Error("mcp call aborted");
    const id = this.nextId++;
    const payload = this.withMeta(method, params, true, era);
    const parsed = await this.post({ jsonrpc: "2.0", id, method, params: payload }, signal, era);
    if (!parsed || typeof parsed !== "object") throw new Error("mcp http empty response");
    const msg = parsed as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (msg.error && typeof msg.error === "object") {
      const code = typeof msg.error.code === "number" ? msg.error.code : -32603;
      const message = typeof msg.error.message === "string" ? msg.error.message : "mcp error";
      throw new RpcError(code, message);
    }
    return msg.result && typeof msg.result === "object" && !Array.isArray(msg.result)
      ? (msg.result as Record<string, unknown>)
      : {};
  }

  private withMeta(
    method: string,
    params: Record<string, unknown>,
    isRequest: boolean,
    era: Era,
  ): Record<string, unknown> {
    if (era !== "modern" || method === "notifications/cancelled") return params;
    if (!isRequest && method.startsWith("notifications/")) return params;
    const existing =
      params._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
        ? (params._meta as Record<string, unknown>)
        : {};
    return { ...params, _meta: { ...modernMeta(), ...existing } };
  }

  private async post(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    era: Era = this.era,
  ): Promise<unknown> {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    });
    const sentSession = this.sessionId;
    if (sentSession) {
      headers.set("MCP-Protocol-Version", this.protocolVersion);
    }
    if (sentSession) headers.set("MCP-Session-Id", sentSession);
    for (const header of this.headers) headers.set(header.name, header.value);
    if (this.auth) headers.set("Authorization", this.auth.startsWith("Bearer ") ? this.auth : `Bearer ${this.auth}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted || controller.signal.aborted) throw new Error("mcp call aborted");
      throw error instanceof Error ? error : new Error("mcp http failed");
    }
    // Headers are in. The body is read below, so the caller's abort stays wired until it is done:
    // clearing that listener here is what let a silent stream hold a turn open for good.
    clearTimeout(timer);
    try {
      const sessionHeader = response.headers.get("mcp-session-id");
      if (response.ok && sessionHeader) this.sessionId = sessionHeader;
      if (response.status === 202) return {};
      if (response.status === 404 && sentSession) {
        this.expire();
        throw new McpSessionExpired();
      }
      if (!response.ok) {
        throw new Error(`mcp http ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        return await readSseJsonRpc(response, { idleMs: this.streamIdleMs, signal });
      }
      const bodyTimer = setTimeout(() => controller.abort(), this.streamIdleMs);
      try {
        return await response.json();
      } catch (error) {
        if (signal?.aborted) throw new Error("mcp call aborted");
        if (controller.signal.aborted) throw new Error("mcp http body timed out");
        throw error instanceof Error ? error : new Error("mcp http failed");
      } finally {
        clearTimeout(bodyTimer);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** The server forgot this session: there is nothing left to DELETE, and the host's next `ensure` opens a new one. */
  private expire(): void {
    this.sessionId = null;
    this.dead = true;
    for (const hook of this.deadHooks) hook();
  }

  private async shutdown(): Promise<void> {
    this.dead = true;
    for (const hook of this.deadHooks) hook();
    if (!this.sessionId) return;
    try {
      const headers = new Headers();
      headers.set("MCP-Session-Id", this.sessionId);
      if (this.auth) {
        headers.set("Authorization", this.auth.startsWith("Bearer ") ? this.auth : `Bearer ${this.auth}`);
      }
      for (const header of this.headers) headers.set(header.name, header.value);
      await fetch(this.url, { method: "DELETE", headers });
    } catch {
      // session teardown is best-effort
    }
  }
}

async function readSseJsonRpc(
  response: Response,
  opts: { idleMs: number; signal?: AbortSignal },
): Promise<unknown> {
  if (!response.body) throw new Error("mcp http empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let eventData = "";
  // A stream that goes quiet forever is the one shape that has no error to react to: the read
  // simply never settles. Give up on it rather than holding the turn open.
  let idled = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      idled = true;
      void reader.cancel().catch(() => undefined);
    }, opts.idleMs);
  };
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    arm();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buf += decoder.decode(value, { stream: true });
      while (true) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) {
          eventData += `${eventData ? "\n" : ""}${line.slice(5).trimStart()}`;
          continue;
        }
        if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) {
          continue;
        }
        if (line.length === 0) {
          const payload = eventData.trim();
          eventData = "";
          if (!payload) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) {
            return parsed;
          }
        }
      }
    }
  } catch (error) {
    // A cancelled reader may reject instead of reporting done, so both ways out say the same thing.
    throw giveUpReason(opts.signal, idled, opts.idleMs) ?? error;
  } finally {
    clearTimeout(idle);
    opts.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  throw (
    giveUpReason(opts.signal, idled, opts.idleMs) ??
    new Error("mcp http stream ended without a result")
  );
}

function giveUpReason(signal: AbortSignal | undefined, idled: boolean, idleMs: number): Error | null {
  if (signal?.aborted) return new Error("mcp call aborted");
  if (idled) return new Error(`mcp http stream went quiet for ${Math.round(idleMs / 1000)}s`);
  return null;
}
