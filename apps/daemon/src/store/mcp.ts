import {
  mcpAuthKeychainName,
  type McpHeader,
  type McpTransport,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { codePointCount } from "../text";
import { emptyToNull, keyMutation, planKey, requireNonEmpty, type McpRow, type StoreContext } from "./shared";

export function listMcpServers(ctx: StoreContext) {
  return ctx.db
    .query<McpRow, []>(`SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE`)
    .all()
    .map((row) => toMcp(ctx, row, ctx.keys.peek(mcpAuthKeychainName(row.id)) !== undefined));
}

export async function listMcpServersHydrated(ctx: StoreContext) {
  const rows = ctx.db
    .query<McpRow, []>(`SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE`)
    .all();
  const out = [];
  for (const row of rows) {
    await ctx.keys.read(mcpAuthKeychainName(row.id));
    out.push(toMcp(ctx, row, true));
  }
  return out;
}

export async function mcpAuth(ctx: StoreContext, id: string): Promise<string | null> {
  return ctx.keys.read(mcpAuthKeychainName(id));
}

export function createMcpServerSync(
  ctx: StoreContext,
  input: {
    name: string;
    transport?: McpTransport;
    command?: string;
    args?: string[];
    url?: string | null;
    headers?: McpHeader[];
    auth?: string;
    enabled?: boolean;
    instructions?: string | null;
    usage_note?: string | null;
    tool_catalog?: Array<{ name: string; description: string }>;
  },
) {
  const name = requireNonEmpty("name", input.name);
  const spec = normalizeMcpSpec({
    transport: input.transport,
    command: input.command,
    args: input.args,
    url: input.url,
    headers: input.headers,
  });
  const now = isoNow();
  const catalog = JSON.stringify(input.tool_catalog ?? []);
  const instructions = input.instructions?.trim() ? input.instructions : null;
  const usageNote = parseMcpUsageNote(input.usage_note);
  const id = ulid();
  const row: McpRow = {
    id,
    name,
    transport: spec.transport,
    command: spec.command,
    args: JSON.stringify(spec.args),
    url: spec.url,
    headers: JSON.stringify(spec.headers),
    enabled: input.enabled === false ? 0 : 1,
    instructions,
    usage_note: usageNote,
    tool_catalog: catalog,
    created_at: now,
    updated_at: now,
  };
  ctx.db.run(
    `INSERT INTO mcp_servers (id, name, transport, command, args, url, headers, enabled, instructions, usage_note, tool_catalog, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      row.transport ?? "stdio",
      row.command,
      row.args,
      row.url ?? null,
      row.headers ?? "[]",
      row.enabled,
      row.instructions ?? null,
      row.usage_note ?? null,
      row.tool_catalog ?? "[]",
      row.created_at,
      row.updated_at,
    ],
  );
  if (input.auth !== undefined && typeof input.auth !== "string") throw new HttpError(422, "invalid_args", "auth must be a string");
  if (typeof input.auth === "string" && input.auth.length > 0) {
    planKey(ctx, mcpAuthKeychainName(id), input.auth);
  }
  return toMcp(ctx, row, true);
}

export function patchMcpServerSync(
  ctx: StoreContext,
  id: string,
  patch: {
    name?: string;
    transport?: McpTransport;
    command?: string;
    args?: string[];
    url?: string | null;
    headers?: McpHeader[];
    auth?: string;
    enabled?: boolean;
    instructions?: string | null;
    usage_note?: string | null;
    tool_catalog?: Array<{ name: string; description: string }>;
  },
) {
  if (ctx.keys.pending(mcpAuthKeychainName(id))) throw new HttpError(409, "conflict", "credential write is pending; retry its request id");
  const current = ctx.db.query<McpRow, [string]>(`SELECT * FROM mcp_servers WHERE id = ?`).get(id);
  if (!current) throw new HttpError(404, "not_found", "mcp server not found");
  // The note is written by you or a Bot, so it survives connection changes; only an explicit
  // patch replaces or clears it.
  const usageNote =
    patch.usage_note !== undefined ? parseMcpUsageNote(patch.usage_note) : (current.usage_note ?? null);
  const name = patch.name !== undefined ? requireNonEmpty("name", patch.name) : current.name;
  const spec = normalizeMcpSpec({
    transport: patch.transport ?? parseTransport(current.transport),
    command: patch.command !== undefined ? patch.command : current.command,
    args: patch.args !== undefined ? patch.args : parseMcpArgs(current.args),
    url: patch.url !== undefined ? patch.url : current.url,
    headers: patch.headers !== undefined ? patch.headers : parseMcpHeaders(current.headers),
  });
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
  const connectionChanged =
    spec.transport !== parseTransport(current.transport) ||
    spec.command !== current.command ||
    JSON.stringify(spec.args) !== current.args ||
    (spec.url ?? null) !== (current.url ?? null) ||
    JSON.stringify(spec.headers) !== (current.headers ?? "[]");
  const instructions =
    patch.instructions !== undefined
      ? patch.instructions?.trim()
        ? patch.instructions
        : null
      : connectionChanged
        ? null
        : current.instructions;
  const toolCatalog =
    patch.tool_catalog !== undefined
      ? JSON.stringify(patch.tool_catalog)
      : connectionChanged
        ? "[]"
        : (current.tool_catalog ?? "[]");
  const now = isoNow();
  ctx.db.run(
    `UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args = ?, url = ?, headers = ?, enabled = ?, instructions = ?, usage_note = ?, tool_catalog = ?, updated_at = ? WHERE id = ?`,
    [
      name,
      spec.transport,
      spec.command,
      JSON.stringify(spec.args),
      spec.url ?? null,
      JSON.stringify(spec.headers),
      enabled,
      instructions ?? null,
      usageNote,
      toolCatalog ?? "[]",
      now,
      id,
    ],
  );
  if (patch.auth !== undefined) {
    planKey(ctx, mcpAuthKeychainName(id), patch.auth);
  }
  const next = ctx.db.query<McpRow, [string]>(`SELECT * FROM mcp_servers WHERE id = ?`).get(id)!;
  return toMcp(ctx, next, true);
}

export function deleteMcpServerSync(ctx: StoreContext, id: string): void {
  if (ctx.keys.pending(mcpAuthKeychainName(id))) throw new HttpError(409, "conflict", "credential write is pending; retry its request id");
  const changes = ctx.db.run(`DELETE FROM mcp_servers WHERE id = ?`, [id]).changes;
  if (changes === 0) throw new HttpError(404, "not_found", "mcp server not found");
  planKey(ctx, mcpAuthKeychainName(id), "");
}

export function toMcp(ctx: StoreContext, row: McpRow, authKnown = false) {
  const transport = parseTransport(row.transport);
  return {
    id: row.id,
    name: row.name,
    transport,
    command: row.command,
    args: parseMcpArgs(row.args),
    url: emptyToNull(row.url),
    headers: parseMcpHeaders(row.headers),
    auth_set: ctx.keyPlan?.some((op) => op.name === mcpAuthKeychainName(row.id)) ? Boolean(ctx.keyPlan.find((op) => op.name === mcpAuthKeychainName(row.id))?.value) : authKnown ? ctx.keys.peek(mcpAuthKeychainName(row.id)) != null : false,
    enabled: row.enabled === 1,
    instructions: row.instructions?.trim() ? row.instructions : null,
    usage_note: row.usage_note?.trim() ? row.usage_note : null,
    tool_catalog: parseToolCatalog(row.tool_catalog),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const MCP_USAGE_NOTE_MAX = 2000;

/** Trims the roster-level MCP usage note; empty means "no note". */
export function parseMcpUsageNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "usage_note must be a string");
  }
  const note = value.trim();
  if (note.length === 0) return null;
  if (codePointCount(note) > MCP_USAGE_NOTE_MAX) {
    throw new HttpError(422, "invalid_args", `usage_note must be at most ${MCP_USAGE_NOTE_MAX} characters`);
  }
  return note;
}

export function parseTransport(value: string | null | undefined): McpTransport {
  return value === "http" ? "http" : "stdio";
}

export function parseMcpArgs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through
  }
  return [];
}

export function parseMcpHeaders(raw: string | null | undefined): McpHeader[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: McpHeader[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const name = (item as { name?: unknown }).name;
      const value = (item as { value?: unknown }).value;
      if (typeof name !== "string" || name.trim().length === 0) continue;
      if (typeof value !== "string") continue;
      out.push({ name: name.trim(), value });
    }
    return out;
  } catch {
    return [];
  }
}

export function parseToolCatalog(raw: string | null | undefined): Array<{ name: string; description: string }> {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is { name: unknown; description?: unknown } =>
          Boolean(item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"),
        )
        .map((item) => ({
          name: String(item.name),
          description: typeof item.description === "string" ? item.description : "",
        }));
    }
  } catch {
    // fall through
  }
  return [];
}

export function normalizeMcpSpec(input: {
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string | null;
  headers?: McpHeader[];
}): {
  transport: McpTransport;
  command: string;
  args: string[];
  url: string | null;
  headers: McpHeader[];
} {
  const urlGiven = typeof input.url === "string" && input.url.trim().length > 0;
  const commandGiven = typeof input.command === "string" && input.command.trim().length > 0;
  const transport: McpTransport =
    input.transport ?? (urlGiven && !commandGiven ? "http" : "stdio");
  if (transport === "http") {
    if (!urlGiven) throw new HttpError(422, "invalid_args", "url is required");
    return {
      transport,
      command: "",
      args: [],
      url: resolveMcpUrl(input.url),
      headers: normalizeMcpHeaders(input.headers ?? []),
    };
  }
  if (!commandGiven) throw new HttpError(422, "invalid_args", "command is required");
  return {
    transport,
    command: requireNonEmpty("command", input.command),
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    url: null,
    headers: [],
  };
}

export function normalizeMcpHeaders(value: unknown): McpHeader[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(422, "invalid_args", "headers must be an array of { name, value }");
  }
  const out: McpHeader[] = [];
  for (const item of value) {
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
    const trimmed = name.trim();
    if (trimmed.toLowerCase() === "authorization") continue;
    out.push({ name: trimmed, value: headerValue });
  }
  return out;
}

export function resolveMcpUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "url must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new HttpError(422, "invalid_args", "url is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(422, "invalid_args", "url must be an http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(422, "invalid_args", "url must be an http or https URL");
  }
  return parsed.href;
}

export async function createMcpServer(ctx: StoreContext, input: Parameters<typeof createMcpServerSync>[1]) {
  return keyMutation(ctx, () => createMcpServerSync(ctx, input));
}

export async function patchMcpServer(ctx: StoreContext, id: string, patch: Parameters<typeof patchMcpServerSync>[2]) {
  await ctx.keys.read(mcpAuthKeychainName(id));
  return keyMutation(ctx, () => patchMcpServerSync(ctx, id, patch));
}

export async function deleteMcpServer(ctx: StoreContext, id: string): Promise<void> {
  await keyMutation(ctx, () => deleteMcpServerSync(ctx, id));
}

export function applyMcpInspection(ctx: StoreContext, id: string, revision: string, inspected: { instructions: string | null; tools: Array<{ name: string; description: string }> }) {
  return ctx.tx.run(() => {
    const row = ctx.db.query<McpRow, [string]>("SELECT * FROM mcp_servers WHERE id = ?").get(id);
    if (!row || row.updated_at !== revision || ctx.keys.pending(mcpAuthKeychainName(id))) return null;
    const changed = ctx.db.run("UPDATE mcp_servers SET instructions = ?, tool_catalog = ?, updated_at = ? WHERE id = ? AND updated_at = ?", [inspected.instructions, JSON.stringify(inspected.tools), isoNow(), id, revision]).changes;
    return changed ? toMcp(ctx, ctx.db.query<McpRow, [string]>("SELECT * FROM mcp_servers WHERE id = ?").get(id)!, true) : null;
  });
}
