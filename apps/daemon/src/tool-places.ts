/**
 * Where a Bot's tool call works (ADR 0097), read from its name and arguments the way a project
 * session's are (ADR 0095): a file tool's path from the workspace root, a shell command's paths from
 * where it runs, an MCP tool at its server; anything else (a message, a question, a ticket) names no
 * place. The recorder takes each `turn.tool` start and end on its way to the windows, keeps the
 * place in `tool_places`, and gives the frame its `bot_call`. Only the place is kept, never the
 * arguments: a write's content and a command's words stay in the turn's own record.
 */
import { homedir } from "node:os";
import { posix } from "node:path";
import type { AgentShellAction, AgentToolPlace, BotToolInfo, ClientEvent } from "@real-bot/protocol";
import { fileOfCall, placeOfCommand, placeOfPath, shellActionOf } from "./claude-code/tool-place";
import { SHELL_KIND } from "./permission-gate";
import type { Store } from "./store";
import type { ToolPlaceRow, ToolPlaceStart } from "./store/tool-places";

/** The app's file tools, and the names the agent runners give their agents' file tools. */
const FILE_TOOLS = new Set(["read_file", "write_file", "delete_file", "list_dir", "list_annotations"]);
/** Calls that do no work of their own: how a turn says it is done. */
const NOT_STEPS = new Set(["end_turn"]);

export type BotPlaceContext = {
  /** The workspace: file tools' paths are read from it, and paths in it are places of the town. */
  root: string;
  /** The turn's work dir, workspace-relative: where a shell with no `cwd` runs. */
  workDir: string | null;
  home: string;
};

export type BotPlace = { place: AgentToolPlace; action?: AgentShellAction; file: string | null };

function resolve(raw: string, base: string, home: string): string {
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? posix.join(home, raw.slice(2)) : raw;
  return posix.resolve(base, expanded);
}

function shellPlace(command: string, cwd: string, ctx: BotPlaceContext, root: string): BotPlace {
  return { place: placeOfCommand(command, { projectDir: root, cwd, home: ctx.home }), action: shellActionOf(command), file: fileOfCall("Bash", { command }) };
}

/** Where one call works, from its name, its arguments and, for an MCP tool, its server. */
export function botPlaceOf(name: string, args: Record<string, unknown>, ctx: BotPlaceContext, mcpServer?: string): BotPlace {
  if (mcpServer) return { place: { zone: "service", server: mcpServer }, file: null };
  const root = posix.resolve(ctx.root);
  if (name === "shell") {
    const command = typeof args.command === "string" ? args.command : "";
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : ctx.workDir;
    return shellPlace(command, cwd ? resolve(cwd, root, ctx.home) : root, ctx, root);
  }
  if (FILE_TOOLS.has(name)) {
    const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : ".";
    return { place: placeOfPath(resolve(path, root, ctx.home), { projectDir: root, home: ctx.home }), file: name === "list_dir" ? null : fileOfCall("Read", { path }) };
  }
  return { place: { zone: "none" }, file: null };
}

/**
 * Where a call works from the card it asks on, for a card that comes before its call starts: a
 * shell card names where the command runs and says the command after its kind; a file card names
 * the file.
 */
export function cardPlaceOf(card: { kind_key: string; target: string; summary: string }, ctx: BotPlaceContext): BotPlace & { tool: string } {
  const root = posix.resolve(ctx.root);
  if (card.kind_key === SHELL_KIND) {
    const command = card.summary.startsWith(`${SHELL_KIND} `) ? card.summary.slice(SHELL_KIND.length + 1) : card.summary;
    return { tool: "shell", ...shellPlace(command, resolve(card.target || ".", root, ctx.home), ctx, root) };
  }
  if (card.target.includes("/") || card.target.includes(".")) {
    return { tool: "write_file", place: placeOfPath(resolve(card.target, root, ctx.home), { projectDir: root, home: ctx.home }), file: fileOfCall("Read", { path: card.target }) };
  }
  return { tool: card.kind_key, place: { zone: "none" }, file: null };
}

function argsOf(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** A row as the frame's `bot_call`. */
export function botCallOf(row: ToolPlaceRow): BotToolInfo {
  let place: AgentToolPlace = { zone: "none" };
  try {
    place = JSON.parse(row.place) as AgentToolPlace;
  } catch {
    // a row this build did not write
  }
  return {
    session_id: row.session_id,
    bot_id: row.bot_id,
    place,
    ...(row.action ? { action: row.action as AgentShellAction } : {}),
    model: row.model,
    at: row.started_at,
    ...(row.ok === null ? {} : { ok: row.ok === 1 }),
  };
}

type ToolEvent = Extract<ClientEvent, { event: "turn.tool" }>;

/** The place context for a turn, or null when there is no workspace to read paths from. */
export function placeContextFor(store: Store, turnId: string, home = homedir()): BotPlaceContext | null {
  try {
    const root = store.workspacePath();
    return root ? { root, workDir: store.turnWorkDir(turnId), home } : null;
  } catch {
    return null;
  }
}

/**
 * Keeps each Bot tool call's place as its frames go out; returns the `bot_call` for the frame, or
 * nothing for a call it does not keep (no turn, no workspace) and for an end that is still waiting
 * on a card or an answer: that one is closed when you answer.
 */
export function createToolPlaceRecorder(store: Store, home = homedir()): (event: ToolEvent) => BotToolInfo | undefined {
  return (event) => {
    try {
      if (NOT_STEPS.has(event.name ?? "")) return undefined;
      if (event.phase === "started") {
        const ctx = placeContextFor(store, event.turn_id, home);
        if (!ctx) return undefined;
        const { place, action, file } = botPlaceOf(event.name ?? "", argsOf(event.arguments), ctx, event.mcp_server);
        const start: ToolPlaceStart = { turnId: event.turn_id, toolCallId: event.id, tool: event.name ?? "", place, action: action ?? null, file,
          model: event.model ?? null, at: event.occurred_at };
        const row = store.beginToolPlace(start);
        return row ? botCallOf(row) : undefined;
      }
      if (event.phase === "exited" && event.ok !== undefined) {
        const row = store.finishToolPlace({ turnId: event.turn_id, toolCallId: event.id, ok: event.ok, errorCode: event.error_code ?? null,
          durationMs: event.duration_ms ?? null, at: event.occurred_at });
        return row ? botCallOf(row) : undefined;
      }
    } catch {
      // The record is the map's, never the work's: a failed write leaves the call as it was.
    }
    return undefined;
  };
}
