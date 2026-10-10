/**
 * The app's own tools as an MCP server a local agent connects to (ADR 0079): `end_turn`, `submit`,
 * `ask_user`, `delegate` and the rest, with your MCP servers' tools behind the app's own MCP host,
 * as every Bot has them. Claude Code gets them in process (ADR 0061); an agent in a process of its
 * own reaches them at `http://127.0.0.1:17890/v1/agent-mcp/<token>`, or through the daemon's stdio
 * shim (`--agent-mcp`) when it only speaks stdio MCP.
 *
 * The token is the whole credential: minted for one segment of one turn, never written anywhere,
 * handed to the agent only in the launch it makes, and gone when the segment ends — a call that
 * comes in after that is told the segment is over. The route sits before the daemon's own bearer
 * check, takes no browser origin and no host but the loopback, and is not on the phone's relay.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolBridge } from "../engine/agent-runner";

export const AGENT_MCP_PREFIX = "/v1/agent-mcp/";
/** The header an agent's stdio shim reads its token from, and sends back. */
export const AGENT_MCP_TOKEN_ENV = "DESKFOLK_AGENT_MCP_TOKEN";
export const AGENT_MCP_URL_ENV = "DESKFOLK_AGENT_MCP_URL";

type Entry = { turnId: string; bridge: AgentToolBridge };

/** The port the daemon listens on, once it does: agents reach the app's tools there. */
let listening: number | null = null;
export function setAgentMcpPort(port: number | null): void {
  listening = port;
}
export function agentMcpPort(): number | null {
  return listening;
}
const entries = new Map<string, Entry>();

/** A new token for one segment's tools. */
export function mintAgentMcp(turnId: string, bridge: AgentToolBridge): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Buffer.from(bytes).toString("base64url");
  entries.set(token, { turnId, bridge });
  return token;
}

export function revokeAgentMcp(token: string | null | undefined): void {
  if (token) entries.delete(token);
}

/** For tests: how many segments have their tools mounted. */
export function mountedAgentMcp(): number {
  return entries.size;
}

/** Whether a request is for the agents' MCP route (matched before the daemon's own token check). */
export function isAgentMcpPath(path: string): boolean {
  return path.startsWith(AGENT_MCP_PREFIX);
}

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

/**
 * Answers one MCP request: a fresh server over the segment's tools, stateless (no session id), the
 * answer as JSON once the call is done — an answer that waits on your approval card holds the
 * request open for as long as that takes (`server.timeout(request, 0)` lifts Bun's idle cut).
 */
export async function handleAgentMcp(request: Request, keepOpen?: (request: Request) => void): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("Origin")) return Response.json({ error: { code: "forbidden_origin", message: "origin is not allowed" } }, { status: 403 });
  if (!LOOPBACK_HOST.test(request.headers.get("Host") ?? url.host)) return Response.json({ error: { code: "forbidden", message: "loopback only" } }, { status: 403 });
  const token = url.pathname.slice(AGENT_MCP_PREFIX.length);
  const entry = /^[A-Za-z0-9_-]{43}$/.test(token) ? entries.get(token) : undefined;
  if (!entry) return Response.json({ error: { code: "not_found", message: "this segment has ended" } }, { status: 404 });
  keepOpen?.(request);
  const server = new Server({ name: "deskfolk", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: entry.bridge.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object" as const, ...tool.inputSchema },
      ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const out = await entry.bridge.call(call.params.name, (call.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text" as const, text: out.text }], isError: out.isError };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close().catch(() => {});
  }
}
