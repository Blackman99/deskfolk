import type { McpHeader, McpServer, McpTransport } from "@real-bot/protocol";
import { mappedMcpChatTools, mapMcpTools, type MappedMcpTool } from "./mcp-names";
import type { ChatTool, McpPromptGuide } from "./prompts";

const CLIENT_INFO = { name: "real-bot", version: "0.0.0" };
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";

export type McpServerSpec = {
  id: string;
  name: string;
  transport?: McpTransport;
  command: string;
  args: string[];
  url?: string | null;
  headers?: McpHeader[];
  auth?: string | null;
  enabled: boolean;
  instructions: string | null;
};

type McpSession = {
  dead: boolean;
  onDead(hook: () => void): void;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

export type McpCallResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

export type McpInspectResult = {
  instructions: string | null;
  tools: Array<{ name: string; description: string }>;
};

export type McpHost = {
  listChatTools: (opts?: { serverIds?: string[] | null }) => Promise<ChatTool[]>;
  listForTurn: (opts?: { serverIds?: string[] | null }) => Promise<{
    tools: ChatTool[];
    guides: McpPromptGuide[];
  }>;
  inspect: (server: McpServerSpec) => Promise<McpInspectResult>;
  call: (
    modelName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<McpCallResult>;
  close: () => Promise<void>;
};

export type McpHostOptions = {
  listServers: () => McpServerSpec[];
  authFor?: (id: string) => Promise<string | null>;
  builtinNames?: Iterable<string>;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownWaitMs?: number;
};

export async function persistMcpInspect(
  store: {
    patchMcpServer: (
      id: string,
      patch: {
        instructions?: string | null;
        tool_catalog?: Array<{ name: string; description: string }>;
      },
    ) => McpServer | Promise<McpServer>;
  },
  host: McpHost,
  server: McpServer,
): Promise<McpServer> {
  if (!server.enabled) return server;
  const inspected = await host.inspect(server);
  if (!inspected.instructions && inspected.tools.length === 0) return server;
  return store.patchMcpServer(server.id, {
    instructions: inspected.instructions,
    tool_catalog: inspected.tools,
  });
}

type Era = "modern" | "legacy";

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createMcpHost(options: McpHostOptions): McpHost {
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const shutdownWaitMs = options.shutdownWaitMs ?? 2_000;
  const sessions = new Map<string, Live>();
  const ensuring = new Map<string, Promise<McpSession | null>>();
  let mapping: MappedMcpTool[] = [];
  let closed = false;
  let inflightRefresh: Promise<MappedMcpTool[]> | null = null;

  function builtinTaken(): Set<string> {
    return new Set(options.builtinNames ?? []);
  }

  function enabledServers(): McpServerSpec[] {
    return options.listServers().filter((s) => s.enabled);
  }

  function filterMapped(mapped: MappedMcpTool[], serverIds?: string[] | null): MappedMcpTool[] {
    if (serverIds == null) return mapped;
    const wanted = new Set(serverIds);
    return mapped.filter((tool) => wanted.has(tool.serverId));
  }

  async function dropUnwantedSessions(): Promise<void> {
    const enabledIds = new Set(enabledServers().map((server) => server.id));
    for (const [id, live] of [...sessions]) {
      if (enabledIds.has(id)) continue;
      await live.session.close();
      sessions.delete(id);
    }
    mapping = mapping.filter((tool) => enabledIds.has(tool.serverId));
  }

  async function connect(server: McpServerSpec): Promise<McpSession | null> {
    if (closed) return null;
    const auth =
      server.auth ?? (serverTransport(server) === "http" ? await options.authFor?.(server.id) : null) ?? null;
    const connected = { ...server, auth };
    const key = specKey(connected);
    const existing = sessions.get(server.id);
    if (existing) {
      if (existing.key === key && !existing.session.dead) return existing.session;
      await existing.session.close();
      sessions.delete(server.id);
    }
    if (closed) return null;
    const spawned =
      serverTransport(connected) === "http"
        ? await spawnHttpSession(connected, requestTimeoutMs)
        : await spawnStdioSession(connected, probeTimeoutMs, requestTimeoutMs, shutdownWaitMs);
    if (!spawned) return null;
    if (closed) {
      await spawned.session.close();
      return null;
    }
    const current = sessions.get(server.id);
    if (current && current.key === key && !current.session.dead) {
      await spawned.session.close();
      return current.session;
    }
    sessions.set(server.id, { key, session: spawned.session, instructions: spawned.instructions });
    spawned.session.onDead(() => {
      if (sessions.get(server.id)?.session === spawned.session) sessions.delete(server.id);
    });
    return spawned.session;
  }

  async function ensure(server: McpServerSpec): Promise<McpSession | null> {
    const pending = ensuring.get(server.id);
    if (pending) {
      await pending;
      return ensure(server);
    }
    const assigned: Promise<McpSession | null> = connect(server).finally(() => {
      if (ensuring.get(server.id) === assigned) ensuring.delete(server.id);
    });
    ensuring.set(server.id, assigned);
    return assigned;
  }

  function guidesFrom(mapped: MappedMcpTool[]): McpPromptGuide[] {
    const byServer = new Map<string, MappedMcpTool[]>();
    for (const tool of mapped) {
      const list = byServer.get(tool.serverId) ?? [];
      list.push(tool);
      byServer.set(tool.serverId, list);
    }
    const guides: McpPromptGuide[] = [];
    for (const server of enabledServers()) {
      const tools = byServer.get(server.id);
      if (!tools || tools.length === 0) continue;
      guides.push({
        name: server.name,
        instructions: sessions.get(server.id)?.instructions ?? server.instructions,
        tools: tools.map((tool) => ({
          modelName: tool.modelName,
          description: tool.description,
        })),
      });
    }
    return guides;
  }

  async function refreshAll(): Promise<MappedMcpTool[]> {
    await dropUnwantedSessions();
    const listed: Array<{
      id: string;
      name: string;
      tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    }> = [];
    for (const server of enabledServers()) {
      if (closed) break;
      const session = await ensure(server);
      if (!session) continue;
      try {
        const tools = await session.listTools();
        listed.push({ id: server.id, name: server.name, tools });
      } catch {
        await session.close();
        sessions.delete(server.id);
      }
    }
    mapping = mapMcpTools(listed, builtinTaken());
    return mapping;
  }

  function refreshMapping(): Promise<MappedMcpTool[]> {
    if (!inflightRefresh) {
      inflightRefresh = refreshAll().finally(() => {
        inflightRefresh = null;
      });
    }
    return inflightRefresh;
  }

  async function lookup(modelName: string): Promise<MappedMcpTool | undefined> {
    await dropUnwantedSessions();
    const hit = mapping.find((t) => t.modelName === modelName);
    if (hit) return hit;
    await refreshMapping();
    return mapping.find((t) => t.modelName === modelName);
  }

  return {
    async listChatTools(opts) {
      if (closed) return [];
      const mapped = await refreshMapping();
      return mappedMcpChatTools(filterMapped(mapped, opts?.serverIds));
    },
    async listForTurn(opts) {
      if (closed) return { tools: [], guides: [] };
      const mapped = await refreshMapping();
      const filtered = filterMapped(mapped, opts?.serverIds);
      return { tools: mappedMcpChatTools(filtered), guides: guidesFrom(filtered) };
    },
    async inspect(server) {
      if (closed) return { instructions: null, tools: [] };
      const session = await ensure(server);
      if (!session) return { instructions: null, tools: [] };
      try {
        const tools = await session.listTools();
        return {
          instructions: sessions.get(server.id)?.instructions ?? null,
          tools: tools.map((tool) => ({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : "",
          })),
        };
      } catch {
        return {
          instructions: sessions.get(server.id)?.instructions ?? null,
          tools: [],
        };
      }
    },
    async call(modelName, args, signal) {
      if (closed) return fail("mcp host is closed");
      if (signal?.aborted) return fail("mcp call aborted");
      const tool = await lookup(modelName);
      if (!tool) return fail(`unknown tool: ${modelName}`);
      const server = enabledServers().find((s) => s.id === tool.serverId);
      if (!server) {
        await dropUnwantedSessions();
        return fail(`unknown tool: ${modelName}`);
      }
      const session = await ensure(server);
      if (!session) return fail("mcp server is not running");
      try {
        const result = await session.callTool(tool.toolName, args, signal);
        return { ok: true, data: result };
      } catch (error) {
        return fail(error instanceof Error ? error.message : "mcp call failed");
      }
    },
    async close() {
      closed = true;
      const pendingRefresh = inflightRefresh;
      await Promise.all([
        ...[...ensuring.values()].map((pending) => pending.catch(() => null)),
        pendingRefresh ? pendingRefresh.catch(() => null) : Promise.resolve(),
      ]);
      const live = [...sessions.values()];
      sessions.clear();
      mapping = [];
      await Promise.all(live.map((item) => item.session.close()));
    },
  };
}

type Live = { key: string; session: McpSession; instructions: string | null };

function serverTransport(server: McpServerSpec): McpTransport {
  if (server.transport === "http" || server.transport === "stdio") return server.transport;
  return server.url ? "http" : "stdio";
}

function specKey(server: McpServerSpec): string {
  if (serverTransport(server) === "http") {
    const headers = (server.headers ?? [])
      .map((h) => `${h.name}=${h.value}`)
      .sort()
      .join("\n");
    return `http\0${server.url ?? ""}\0${headers}\0${server.auth ?? ""}`;
  }
  return `stdio\0${server.command}\0${server.args.join("\0")}`;
}

function fail(message: string): McpCallResult {
  return { ok: false, error: { code: "failed", message } };
}

function modernMeta(version = MODERN_VERSION): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
  };
}

function childEnv(): Record<string, string> {
  const keys = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "TMPDIR", "LANG", "LC_ALL"];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value && !value.startsWith("()")) env[key] = value;
  }
  return env;
}

async function spawnStdioSession(
  server: McpServerSpec,
  probeTimeoutMs: number,
  requestTimeoutMs: number,
  shutdownWaitMs: number,
): Promise<{ session: StdioSession; instructions: string | null } | null> {
  const era = await probeEra(server, probeTimeoutMs, shutdownWaitMs);
  return spawnSession(server, era, requestTimeoutMs, shutdownWaitMs);
}

async function spawnHttpSession(
  server: McpServerSpec,
  requestTimeoutMs: number,
): Promise<{ session: HttpSession; instructions: string | null } | null> {
  if (!server.url) return null;
  const session = new HttpSession(server, requestTimeoutMs);
  try {
    const instructions = await session.handshake();
    return { session, instructions };
  } catch {
    await session.close();
    return null;
  }
}

async function probeEra(
  server: McpServerSpec,
  probeTimeoutMs: number,
  shutdownWaitMs: number,
): Promise<Era> {
  const child = spawnChild(server);
  if (!child) return "legacy";
  const session = new StdioSession(child, { era: "modern", requestTimeoutMs: probeTimeoutMs, shutdownWaitMs });
  try {
    const result = await session.request("server/discover", { _meta: modernMeta() });
    const versions = result.supportedVersions;
    if (Array.isArray(versions) && versions.includes(MODERN_VERSION)) return "modern";
    if (Array.isArray(versions) && versions.length > 0) return "modern";
    return "modern";
  } catch (error) {
    const code = error instanceof RpcError ? error.code : null;
    if (code === -32022) return "modern";
    return "legacy";
  } finally {
    await session.close();
  }
}

async function spawnSession(
  server: McpServerSpec,
  era: Era,
  requestTimeoutMs: number,
  shutdownWaitMs: number,
): Promise<{ session: StdioSession; instructions: string | null } | null> {
  const child = spawnChild(server);
  if (!child) return null;
  const session = new StdioSession(child, { era, requestTimeoutMs, shutdownWaitMs });
  try {
    if (era === "legacy") {
      const result = await session.request("initialize", {
        protocolVersion: LEGACY_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      session.notify("notifications/initialized", {});
      return { session, instructions: readInstructions(result) };
    }
    try {
      const result = await session.request("server/discover", { _meta: modernMeta() });
      return { session, instructions: readInstructions(result) };
    } catch {
      return { session, instructions: null };
    }
  } catch {
    await session.close();
    return null;
  }
}

function readInstructions(result: Record<string, unknown>): string | null {
  if (typeof result.instructions === "string" && result.instructions.trim()) {
    return result.instructions;
  }
  return null;
}

function spawnChild(server: McpServerSpec): Bun.Subprocess | null {
  try {
    return Bun.spawn([server.command, ...server.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(),
    });
  } catch {
    return null;
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class StdioSession {
  dead = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly encoder = new TextEncoder();
  private closing: Promise<void> | null = null;
  private readonly deadHooks: Array<() => void> = [];
  private readonly era: Era;
  private readonly requestTimeoutMs: number;
  private readonly shutdownWaitMs: number;
  private readonly proc: Bun.Subprocess;

  constructor(
    proc: Bun.Subprocess,
    opts: { era: Era; requestTimeoutMs: number; shutdownWaitMs: number },
  ) {
    this.proc = proc;
    this.era = opts.era;
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.shutdownWaitMs = opts.shutdownWaitMs;
    void this.readStdout();
    void drain(this.proc.stderr);
    void this.proc.exited.then(() => this.markDead(new Error("mcp server exited")));
  }

  onDead(hook: () => void): void {
    this.deadHooks.push(hook);
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.dead) return;
    this.write({ jsonrpc: "2.0", method, params: this.withMeta(method, params, false) });
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (this.dead) throw new Error("mcp server exited");
    if (signal?.aborted) throw new Error("mcp call aborted");
    const id = this.nextId++;
    const payload = this.withMeta(method, params, true);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        this.notify("notifications/cancelled", { requestId: id, reason: "aborted" });
        finish(() => reject(new Error("mcp call aborted")));
      };
      const timer = setTimeout(() => {
        this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
        finish(() => reject(new Error("mcp request timed out")));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        timer,
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params: payload });
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error("mcp write failed")));
        return;
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    return listMcpTools((params) => this.request("tools/list", params));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.shutdown();
    return this.closing;
  }

  private withMeta(
    method: string,
    params: Record<string, unknown>,
    isRequest: boolean,
  ): Record<string, unknown> {
    if (this.era !== "modern" || method === "notifications/cancelled") return params;
    if (!isRequest && method.startsWith("notifications/")) return params;
    const existing =
      params._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
        ? (params._meta as Record<string, unknown>)
        : {};
    return { ...params, _meta: { ...modernMeta(), ...existing } };
  }

  private write(obj: unknown): void {
    const stdin = this.proc.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("mcp stdin is closed");
    stdin.write(this.encoder.encode(`${JSON.stringify(obj)}\n`));
  }

  private async readStdout(): Promise<void> {
    const stdout = this.proc.stdout;
    if (!stdout || typeof stdout === "number") return;
    const decoder = new TextDecoder();
    let buf = "";
    const reader = stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        while (true) {
          const nl = buf.indexOf("\n");
          if (nl < 0) break;
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.onLine(line);
        }
      }
    } catch {
      // process ended
    }
    this.markDead(new Error("mcp server exited"));
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as {
      id?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    if (msg.error && typeof msg.error === "object") {
      const code = typeof msg.error.code === "number" ? msg.error.code : -32603;
      const message = typeof msg.error.message === "string" ? msg.error.message : "mcp error";
      pending.reject(new RpcError(code, message));
      return;
    }
    const result =
      msg.result && typeof msg.result === "object" && !Array.isArray(msg.result)
        ? (msg.result as Record<string, unknown>)
        : {};
    pending.resolve(result);
  }

  private markDead(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const hook of this.deadHooks) hook();
  }

  private async shutdown(): Promise<void> {
    this.markDead(new Error("mcp server closed"));
    const stdin = this.proc.stdin;
    try {
      if (stdin && typeof stdin !== "number") stdin.end();
    } catch {
      // already closed
    }
    const exited = await waitFor(this.proc.exited, this.shutdownWaitMs);
    if (!exited) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // gone
      }
      const afterTerm = await waitFor(this.proc.exited, this.shutdownWaitMs);
      if (!afterTerm) {
        try {
          this.proc.kill("SIGKILL");
        } catch {
          // gone
        }
        await this.proc.exited;
      }
    }
  }
}

class HttpSession implements McpSession {
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

  constructor(server: McpServerSpec, requestTimeoutMs: number) {
    this.url = server.url ?? "";
    this.headers = server.headers ?? [];
    this.auth = server.auth ?? null;
    this.requestTimeoutMs = requestTimeoutMs;
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

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
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
    if (this.sessionId) {
      headers.set("MCP-Protocol-Version", this.protocolVersion);
    }
    if (this.sessionId) headers.set("MCP-Session-Id", this.sessionId);
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
      if (signal?.aborted || controller.signal.aborted) throw new Error("mcp call aborted");
      throw error instanceof Error ? error : new Error("mcp http failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    const sessionHeader = response.headers.get("mcp-session-id");
    if (response.ok && sessionHeader) this.sessionId = sessionHeader;
    if (response.status === 202) return {};
    if (!response.ok) {
      throw new Error(`mcp http ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return readSseJsonRpc(response);
    }
    return response.json();
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

async function listMcpTools(
  request: (
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>,
): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
  const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
  let cursor: unknown;
  for (let page = 0; page < 64; page++) {
    const params: Record<string, unknown> = {};
    if (typeof cursor === "string") params.cursor = cursor;
    const result = await request(params);
    const batch = Array.isArray(result.tools) ? result.tools : [];
    for (const item of batch) {
      if (!item || typeof item !== "object") continue;
      const tool = item as { name?: unknown; description?: unknown; inputSchema?: unknown };
      if (typeof tool.name !== "string") continue;
      tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : undefined,
        inputSchema: tool.inputSchema,
      });
    }
    if (typeof result.nextCursor !== "string" || result.nextCursor.length === 0) break;
    cursor = result.nextCursor;
  }
  return tools;
}

async function readSseJsonRpc(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("mcp http empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let eventData = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
  } finally {
    reader.releaseLock();
  }
  throw new Error("mcp http stream ended without a result");
}

async function drain(stream: ReadableStream<Uint8Array> | number | undefined): Promise<void> {
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

function waitFor(promise: Promise<unknown>, ms: number): Promise<boolean> {
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
