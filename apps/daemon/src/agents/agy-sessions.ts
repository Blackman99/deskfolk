/**
 * Your Antigravity sessions to carry on as project sessions (ADR 0111), asked of `agy acp` itself,
 * never read from its files: `session/list` for what it keeps, `session/load` for what was said.
 * `agy` 1.5.10 lists every session it keeps — the terminal's, and the app's own Bots' — with no
 * word of where each came from, and takes no directory to list by (measured 2026-11-17), so the
 * app's own are left out by what it knows of them (`isAppsOwn`). `agy` cannot branch a session: one
 * carried on goes on in that same session (`project-runner-agy.ts` resumes it).
 */
import type { AgentSessionListing } from "@real-bot/protocol";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { sep } from "node:path";
import type { RpcPeer } from "../engine/agent/jsonrpc";
import { isWithinPath } from "../workspace-paths";
import type { ImportedLine, ImportedSession } from "./agent-sessions";
import { AGY_ASK_TIMEOUT_MS, withAgyAcp } from "./agy-acp";
import type { ResolvedAgent } from "./runtime";

/** How long a listing is kept before the next ask starts `agy` again. */
export const AGY_SESSIONS_MAX_AGE_MS = 60_000;

export type AgySessionInfo = { sessionId: string; cwd?: string | null; title?: string | null; updatedAt?: string | null };

/** What a session's replay holds, in order: what you said, what it said, and each tool call as it last stood. */
export type AgyReplayEntry =
  | { kind: "user" | "agent"; text: string }
  | { kind: "tool"; id: string; update: Record<string, unknown> };

/** A path as the disk has it (`/tmp` is `/private/tmp` on macOS), or as given. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * A session one of the app's own Bots opened, as far as can be told: a Bot's turn starts with its
 * profile (`# 人设`, `# Profile`), which `agy` takes for the title, and runs in the workspace or a
 * call's own folder under the system's temporary one (`deskfolk-call-…`).
 */
export function isAppsOwn(session: AgySessionInfo, workspace: string | null): boolean {
  if (/^#\s*(人设|Profile)\s*$/m.test((session.title ?? "").split("\n")[0] ?? "")) return true;
  const cwd = session.cwd ? real(session.cwd) : null;
  if (!cwd) return false;
  if (workspace && isWithinPath(real(workspace), cwd, process.platform)) return true;
  const temp = real(tmpdir());
  return isWithinPath(temp, cwd, process.platform) && cwd.slice(temp.length).split(sep).some((part) => part.startsWith("deskfolk-call-"));
}

/** A session as the import list shows it; `agy` titles its sessions itself. */
export function agyListing(session: AgySessionInfo): AgentSessionListing {
  const title = (session.title ?? "").split("\n").find((line) => line.trim())?.trim() ?? "";
  return {
    agent: "antigravity", session_id: session.sessionId, config_dir: null, title: title.slice(0, 200) || session.sessionId,
    cwd: session.cwd ? real(session.cwd) : null, git_branch: null, modified_at: session.updatedAt ?? new Date(0).toISOString(), size: 0,
  };
}

/** Every session `agy` lists, through every page. */
export async function listAgySessions(rpc: RpcPeer): Promise<AgySessionInfo[]> {
  const out: AgySessionInfo[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages += 1) {
    const page: { sessions?: AgySessionInfo[]; nextCursor?: string | null } = await rpc.request("session/list", cursor ? { cursor } : {}, AGY_ASK_TIMEOUT_MS);
    for (const session of page.sessions ?? []) if (typeof session?.sessionId === "string") out.push(session);
    cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
    if (!cursor) break;
  }
  return out;
}

/**
 * One session's history as `session/load` replays it before it answers: what you said and what it
 * said, chunks of one speaker joined, and each tool call as it last stood. `agy` gives no times.
 */
export async function loadAgySession(rpc: RpcPeer, sessionId: string, cwd: string): Promise<{ entries: AgyReplayEntry[]; title: string | null }> {
  const entries: AgyReplayEntry[] = [];
  const tools = new Map<string, Extract<AgyReplayEntry, { kind: "tool" }>>();
  let title: string | null = null;
  rpc.onNotification((method, params) => {
    const p = (params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
    if (method !== "session/update" || p.sessionId !== sessionId || !p.update) return;
    const update = p.update;
    const kind = update.sessionUpdate;
    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type !== "text" || typeof content.text !== "string") return;
      const speaker = kind === "user_message_chunk" ? "user" : "agent";
      const last = entries.at(-1);
      if (last && last.kind === speaker) last.text += content.text;
      else entries.push({ kind: speaker, text: content.text });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const id = String(update.toolCallId ?? "");
      if (!id) return;
      const known = tools.get(id);
      if (known) known.update = { ...known.update, ...update };
      else {
        const entry = { kind: "tool" as const, id, update };
        tools.set(id, entry);
        entries.push(entry);
      }
    } else if (kind === "session_info_update" && typeof update.title === "string") title = update.title;
  });
  await rpc.request("session/load", { sessionId, cwd, mcpServers: [] }, AGY_ASK_TIMEOUT_MS * 2);
  await rpc.request("session/close", { sessionId }, 5_000).catch(() => undefined);
  return { entries, title };
}

/** A loaded session as lines to carry in: each at a millisecond of its own, oldest first, before `updatedAt`. */
export function agyImported(session: AgySessionInfo, loaded: { entries: AgyReplayEntry[]; title: string | null }): ImportedSession {
  const said = loaded.entries.filter((entry): entry is Extract<AgyReplayEntry, { kind: "user" | "agent" }> => entry.kind !== "tool" && entry.text.trim().length > 0);
  const end = Date.parse(session.updatedAt ?? "") || Date.now();
  const lines: ImportedLine[] = said.map((entry, index) => ({
    role: entry.kind === "user" ? "user" : "assistant", text: entry.text.trim(), at: new Date(end - (said.length - index)).toISOString(),
  }));
  const listed = agyListing(session);
  return { session_id: session.sessionId, title: loaded.title?.trim() || listed.title, cwd: listed.cwd, lines, tool_calls: loaded.entries.length - said.length - loaded.entries.filter((entry) => entry.kind !== "tool" && !entry.text.trim()).length };
}

export type AgySessions = {
  /** Your sessions, the app's own left out; kept a minute. */
  list(limit: number, exclude: ReadonlySet<string>, workspace: string | null): Promise<AgentSessionListing[]>;
  /** One session read for carrying on; null when `agy` does not have it. */
  read(sessionId: string): Promise<ImportedSession | null>;
};

export function createAgySessions(deps: { resolve: () => Promise<ResolvedAgent>; now?: () => number }): AgySessions {
  const now = deps.now ?? Date.now;
  let kept: { sessions: AgySessionInfo[]; at: number } | null = null;
  const ask = async <T>(question: (rpc: RpcPeer) => Promise<T>): Promise<T> => {
    const agy = await deps.resolve();
    if (!agy.ok) throw new Error(agy.error);
    return withAgyAcp(agy, homedir(), async (rpc, caps) => {
      if (!caps.list || !caps.load) throw new Error("this agy cannot list or load its sessions: update it (agy update)");
      return question(rpc);
    });
  };
  const sessions = async (): Promise<AgySessionInfo[]> => {
    if (kept && now() - kept.at < AGY_SESSIONS_MAX_AGE_MS) return kept.sessions;
    const listed = await ask(listAgySessions);
    kept = { sessions: listed, at: now() };
    return listed;
  };
  return {
    async list(limit, exclude, workspace) {
      return (await sessions())
        .filter((session) => !exclude.has(session.sessionId) && !isAppsOwn(session, workspace))
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .slice(0, limit)
        .map(agyListing);
    },
    async read(sessionId) {
      return ask(async (rpc) => {
        const session = (await listAgySessions(rpc)).find((one) => one.sessionId === sessionId);
        if (!session) return null;
        return agyImported(session, await loadAgySession(rpc, sessionId, session.cwd ?? homedir()));
      });
    },
  };
}


