/** MCP server tools and reading their connection arguments. */
import type { McpHeader, McpServer, McpTransport } from "@real-bot/protocol";
import { runCollabTool, type ToolCtx, type ToolResult } from "../collab-tools";
import { HttpError } from "../errors";
import { optionalString, optionalStringArray, requireString } from "./args";
import { mutateConfiguration } from "./guards";

export async function listMcpServers(ctx: ToolCtx): Promise<ToolResult> {
  const servers = await ctx.store.listMcpServersHydrated();
  return {
    ok: true,
    data: {
      servers: servers.map(serializeMcp),
    },
    emitted: [],
  };
}

export async function addMcpServer(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const name = requireString(args.name, "name");
  const parsed = parseMcpToolSpec(args);
  const enabled = args.enabled === undefined ? true : Boolean(args.enabled);
  if (!ctx.approved) {
    return {
      ok: false,
      waitApproval: {
        kind_key: "mcp-add",
        target: mcpTarget(parsed.spec),
        summary: mcpAddSummary(name, parsed.spec),
        requiresApiKey: parsed.spec.transport === "http",
        run: (opts) =>
          runCollabTool(
            { ...ctx, approved: true, approvalApiKey: opts?.api_key },
            "add_mcp_server",
            args,
          ),
      },
      emitted: [],
    };
  }
  const auth =
    parsed.spec.transport === "http" ? (ctx.approvalApiKey?.trim() || undefined) : undefined;
  if (parsed.spec.transport === "http" && !auth) {
    throw new HttpError(422, "invalid_args", "api_key is required");
  }
  const server = await mutateConfiguration(ctx, () => ctx.store.createMcpServerSync({
    name,
    transport: parsed.spec.transport,
    command: parsed.spec.command,
    args: parsed.spec.args,
    url: parsed.spec.url,
    headers: parsed.spec.headers,
    auth,
    enabled,
    usage_note: parseUsageNoteArg(args.usage_note),
  }));
  return { ok: true, data: serializeMcp(server), emitted: [{ kind: "mcp", server }] };
}

/** `undefined` leaves the note alone; `null` or an empty string clears it. */
function parseUsageNoteArg(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "usage_note must be a string");
  }
  return value;
}

export async function updateMcpServer(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const id = requireString(args.id, "id");
  const current = ctx.store.listMcpServers().find((row) => row.id === id);
  if (!current) throw new HttpError(404, "not_found", "mcp server not found");
  const nextName = args.name !== undefined ? requireString(args.name, "name") : undefined;
  const nextTransport =
    args.transport !== undefined ? parseTransportArg(args.transport) : undefined;
  const nextCommand = args.command !== undefined ? requireString(args.command, "command") : undefined;
  const nextArgs = args.args !== undefined ? optionalStringArray(args.args) : undefined;
  const nextUrl = args.url !== undefined ? requireString(args.url, "url") : undefined;
  const nextHeadersParsed = args.headers !== undefined ? parseHeaderArg(args.headers) : undefined;
  const nextHeaders = nextHeadersParsed?.headers;
  const connectionChanging = mcpConnectionChanging(current, {
    transport: nextTransport,
    command: nextCommand,
    args: nextArgs,
    url: nextUrl,
    headers: nextHeaders,
  });
  if (connectionChanging && !ctx.approved) {
    const nextSpec: McpToolSpec = {
      transport: nextTransport ?? current.transport,
      command: nextCommand ?? current.command,
      args: nextArgs ?? current.args,
      url: nextUrl ?? current.url,
      headers: nextHeaders ?? current.headers,
    };
    return {
      ok: false,
      waitApproval: {
        kind_key: "mcp-edit",
        target: mcpTarget(nextSpec),
        summary: mcpEditSummary(nextName ?? current.name, nextSpec),
        requiresApiKey: nextSpec.transport === "http" && !current.auth_set,
        run: (opts) =>
          runCollabTool(
            {
              ...ctx,
              approved: true,
              approvalApiKey: opts?.api_key,
            },
            "update_mcp_server",
            args,
          ),
      },
      emitted: [],
    };
  }
  const auth = ctx.approvalApiKey?.trim() || undefined;
  if (
    ctx.approved &&
    connectionChanging &&
    (nextTransport ?? current.transport) === "http" &&
    !current.auth_set &&
    !auth
  ) {
    throw new HttpError(422, "invalid_args", "api_key is required");
  }
  const server = await mutateConfiguration(ctx, () => ctx.store.patchMcpServerSync(id, {
    name: nextName,
    transport: nextTransport,
    command: nextCommand,
    args: nextArgs,
    url: nextUrl,
    headers: nextHeaders,
    auth,
    enabled: args.enabled === undefined ? undefined : Boolean(args.enabled),
    usage_note: parseUsageNoteArg(args.usage_note),
  }));
  return { ok: true, data: serializeMcp(server), emitted: [{ kind: "mcp", server }] };
}

export async function deleteMcpServer(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const id = requireString(args.id, "id");
  await mutateConfiguration(ctx, () => ctx.store.deleteMcpServerSync(id));
  return { ok: true, data: { id }, emitted: [{ kind: "mcp_removed", id }] };
}

function serializeMcp(server: McpServer): Record<string, unknown> {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    headers: server.headers,
    auth_set: server.auth_set,
    enabled: server.enabled,
    instructions: server.instructions,
    usage_note: server.usage_note,
    tool_catalog: server.tool_catalog,
  };
}

type McpToolSpec = {
  transport: McpTransport;
  command: string;
  args: string[];
  url: string | null;
  headers: McpHeader[];
};

function parseMcpToolSpec(args: Record<string, unknown>): { spec: McpToolSpec; auth: string | undefined } {
  const url = optionalString(args.url);
  const command = optionalString(args.command);
  const parsedHeaders = args.headers === undefined ? { headers: [] as McpHeader[], auth: undefined } : parseHeaderArg(args.headers);
  const transport =
    args.transport !== undefined
      ? parseTransportArg(args.transport)
      : url && !command
        ? "http"
        : "stdio";
  if (transport === "http") {
    if (!url) throw new HttpError(422, "invalid_args", "url is required");
    return {
      spec: {
        transport,
        command: "",
        args: [],
        url,
        headers: parsedHeaders.headers,
      },
      auth: parsedHeaders.auth,
    };
  }
  if (!command) throw new HttpError(422, "invalid_args", "command is required");
  return {
    spec: {
      transport,
      command,
      args: optionalStringArray(args.args) ?? [],
      url: null,
      headers: [],
    },
    auth: undefined,
  };
}

function parseTransportArg(value: unknown): McpTransport {
  if (value !== "stdio" && value !== "http") {
    throw new HttpError(422, "invalid_args", "transport must be stdio or http");
  }
  return value;
}

function parseHeaderArg(value: unknown): { headers: McpHeader[]; auth?: string } {
  if (value === undefined || value === null) return { headers: [] };
  if (typeof value === "string") return parseHeaderLines(value);
  if (!Array.isArray(value)) {
    throw new HttpError(422, "invalid_args", "headers must be an array of { name, value }");
  }
  const headers: McpHeader[] = [];
  let auth: string | undefined;
  for (const item of value) {
    if (typeof item === "string") {
      const parsed = parseHeaderLines(item);
      headers.push(...parsed.headers);
      if (parsed.auth) auth = parsed.auth;
      continue;
    }
    if (!item || typeof item !== "object") {
      throw new HttpError(422, "invalid_args", "headers must be an array of { name, value }");
    }
    const name = (item as { name?: unknown }).name;
    const headerValue = (item as { value?: unknown }).value;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new HttpError(422, "invalid_args", "header name is required");
    }
    if (typeof headerValue !== "string") {
      throw new HttpError(422, "invalid_args", "header value must be a string");
    }
    if (name.trim().toLowerCase() === "authorization") {
      auth = headerValue;
      continue;
    }
    headers.push({ name: name.trim(), value: headerValue });
  }
  return { headers, auth };
}

function parseHeaderLines(raw: string): { headers: McpHeader[]; auth?: string } {
  const headers: McpHeader[] = [];
  let auth: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) throw new HttpError(422, "invalid_args", "headers must look like Name: value");
    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (name.toLowerCase() === "authorization") {
      auth = value;
      continue;
    }
    headers.push({ name, value });
  }
  return { headers, auth };
}

function mcpConnectionChanging(
  current: McpServer,
  next: {
    transport?: McpTransport;
    command?: string;
    args?: string[];
    url?: string;
    headers?: McpHeader[];
  },
): boolean {
  if (next.transport !== undefined && next.transport !== current.transport) return true;
  if (next.command !== undefined && next.command !== current.command) return true;
  if (next.args !== undefined && JSON.stringify(next.args) !== JSON.stringify(current.args)) return true;
  if (next.url !== undefined && next.url !== (current.url ?? "")) return true;
  if (next.headers !== undefined && JSON.stringify(next.headers) !== JSON.stringify(current.headers)) {
    return true;
  }
  return false;
}

function mcpTarget(spec: McpToolSpec): string {
  if (spec.transport === "http") return spec.url ?? "";
  return `${spec.command} ${spec.args.join(" ")}`.trim();
}

function mcpAddSummary(name: string, spec: McpToolSpec): string {
  return `mcp-add ${name}\n${mcpSummaryLine(spec)}`;
}

function mcpEditSummary(name: string, spec: McpToolSpec): string {
  return `mcp-edit ${name}\n${mcpSummaryLine(spec)}`;
}

function mcpSummaryLine(spec: McpToolSpec): string {
  if (spec.transport === "http") {
    const extra = spec.headers.length > 0 ? `\nheaders: ${spec.headers.map((h) => h.name).join(", ")}` : "";
    return `${spec.url}${extra}`;
  }
  return `${spec.command} ${spec.args.join(" ")}`.trimEnd();
}
