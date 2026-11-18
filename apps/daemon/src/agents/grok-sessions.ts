/**
 * Your Grok sessions to carry on as project sessions (ADR 0115), asked of Grok itself on each of
 * your Grok accounts (`GROK_HOME`), never read from its files: `session/list` for what it keeps,
 * `_x.ai/session/updates` for what was said, each line at the time Grok wrote it. Grok 1.0.89 lists
 * every session it keeps, the app's own Bots' too, with no word of where each came from (measured
 * 2026-11-18), so the app's own are left out by what it knows of them (`isAppsOwn`, as for agy). A
 * carried-on session is branched (`_x.ai/session/fork`, `project-runner-grok.ts`): yours stays as it was.
 */
import type { AgentSessionListing } from "@real-bot/protocol";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { RpcPeer } from "../engine/agent/jsonrpc";
import type { ImportedLine, ImportedSession } from "./agent-sessions";
import { isAppsOwn } from "./agy-sessions";
import { GROK_ASK_TIMEOUT_MS, grokUpdates, recordMs, withGrokAcp, type GrokRecord } from "./grok-acp";
import type { ResolvedAgent } from "./runtime";

/** How long a listing is kept before the next ask starts Grok again. */
export const GROK_SESSIONS_MAX_AGE_MS = 60_000;

export type GrokSessionInfo = { sessionId: string; cwd?: string | null; title?: string | null; updatedAt?: string | null };

/** A path as the disk has it (`/tmp` is `/private/tmp` on macOS), or as given. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A session as the import list shows it, under the account it was found on; Grok titles its sessions itself. */
export function grokListing(session: GrokSessionInfo, configDir: string | null): AgentSessionListing {
  const title = (session.title ?? "").split("\n").find((line) => line.trim())?.trim() ?? "";
  return {
    agent: "grok", session_id: session.sessionId, config_dir: configDir, title: title.slice(0, 200) || session.sessionId,
    cwd: session.cwd ? real(session.cwd) : null, git_branch: null, modified_at: session.updatedAt ?? new Date(0).toISOString(), size: 0,
  };
}

/** Every session Grok lists, through every page. */
export async function listGrokSessions(rpc: RpcPeer): Promise<GrokSessionInfo[]> {
  const out: GrokSessionInfo[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages += 1) {
    const page: { sessions?: GrokSessionInfo[]; nextCursor?: string | null } = await rpc.request("session/list", cursor ? { cursor } : {}, GROK_ASK_TIMEOUT_MS);
    for (const session of page.sessions ?? []) if (typeof session?.sessionId === "string") out.push(session);
    cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
    if (!cursor) break;
  }
  return out;
}

/**
 * What a session's stored updates say: your lines and its answers, each at the time Grok wrote it
 * (chunks of one speaker in a row joined), and how many tool calls it made, which do not come along.
 */
export function grokConversationOf(records: GrokRecord[]): ImportedLine[] {
  const lines: ImportedLine[] = [];
  let last: { role: ImportedLine["role"]; prompt: unknown } | null = null;
  for (const record of records) {
    const update = record.params?.update;
    const kind = update?.sessionUpdate;
    if (kind !== "user_message_chunk" && kind !== "agent_message_chunk") {
      if (kind === "tool_call" || kind === "turn_completed") last = null;
      continue;
    }
    const content = update!.content as { type?: string; text?: string } | undefined;
    if (content?.type !== "text" || typeof content.text !== "string") continue;
    const role: ImportedLine["role"] = kind === "user_message_chunk" ? "user" : "assistant";
    const prompt = (update!._meta as { promptIndex?: unknown; promptId?: unknown } | undefined)?.promptIndex ?? (update!._meta as { promptId?: unknown } | undefined)?.promptId ?? null;
    const at = recordMs(record);
    if (last && last.role === role && lines.length > 0 && (prompt === null || last.prompt === null || prompt === last.prompt)) {
      lines[lines.length - 1]!.text += content.text;
      continue;
    }
    lines.push({ role, text: content.text, at: new Date(at ?? Date.now()).toISOString() });
    last = { role, prompt };
  }
  return lines.map((line) => ({ ...line, text: line.text.trim() })).filter((line) => line.text.length > 0);
}

/** How many tool calls the records hold. */
export function grokToolCallsOf(records: GrokRecord[]): number {
  return records.filter((record) => record.params?.update?.sessionUpdate === "tool_call").length;
}

/** A session read for carrying on; one Grok gave no title (`grok -p`) is named by its first line, as Codex's are. */
export function grokImported(session: GrokSessionInfo, records: GrokRecord[], configDir: string | null): ImportedSession {
  const listed = grokListing(session, configDir);
  const lines = grokConversationOf(records);
  const first = lines.find((line) => line.role === "user")?.text.split("\n").find((part) => part.trim())?.trim();
  const title = session.title?.trim() ? listed.title : (first ? [...first].slice(0, 200).join("") : listed.title);
  return { session_id: session.sessionId, title, cwd: listed.cwd, lines, tool_calls: grokToolCallsOf(records) };
}

const CARRY_MAX = 6000;

/**
 * What a session moved to another of your Grok accounts is told first (ADR 0110's way for Claude):
 * the conversation so far, the latest ~6000 characters of it; the files and results are still
 * there, so nothing done is to be redone.
 */
export function grokCarryNote(lines: ImportedLine[], en: boolean): string {
  const said = lines.map((line) => `${line.role === "user" ? (en ? "User" : "用户") : "Grok"}: ${line.text}`);
  let text = "";
  for (let index = said.length - 1; index >= 0; index -= 1) {
    const next = `${said[index]}\n\n${text}`;
    if ([...next].length > CARRY_MAX) break;
    text = next;
  }
  const head = en
    ? "(Deskfolk) This session moved to another of the user's Grok accounts, which cannot open the one before, so this is a new session. The conversation so far, latest last; the files and results it produced are still there, so do not redo work that is done:"
    : "（Deskfolk）这个会话换到了用户的另一个 Grok 账号，那个账号打不开之前的会话，所以这是新开的会话。下面是到现在为止的对话，最后的最新；做出来的文件和结果都还在，已经做完的不要重做：";
  return `${head}\n\n${text.trim()}`;
}

export type GrokSessions = {
  /** Your sessions on every Grok account, the app's own left out, newest first; kept a minute. */
  list(limit: number, exclude: ReadonlySet<string>, workspace: string | null, homes: Array<string | null>): Promise<{ items: AgentSessionListing[]; errors: string[] }>;
  /** One session read for carrying on, from the account it is on; null when Grok does not have it. */
  read(sessionId: string, configDir: string | null): Promise<ImportedSession | null>;
};

export function createGrokSessions(deps: { resolve: (configDir: string | null) => Promise<ResolvedAgent>; now?: () => number }): GrokSessions {
  const now = deps.now ?? Date.now;
  const kept = new Map<string, { sessions: GrokSessionInfo[]; at: number }>();
  const ask = async <T>(configDir: string | null, question: (rpc: RpcPeer) => Promise<T>): Promise<T> => {
    const grok = await deps.resolve(configDir);
    if (!grok.ok) throw new Error(grok.error);
    return withGrokAcp(grok, homedir(), async (rpc, caps) => {
      if (!caps.list) throw new Error("this grok cannot list its sessions: update it (grok update)");
      return question(rpc);
    });
  };
  const sessions = async (configDir: string | null): Promise<GrokSessionInfo[]> => {
    const key = configDir ?? "";
    const entry = kept.get(key);
    if (entry && now() - entry.at < GROK_SESSIONS_MAX_AGE_MS) return entry.sessions;
    const listed = await ask(configDir, listGrokSessions);
    kept.set(key, { sessions: listed, at: now() });
    return listed;
  };
  return {
    async list(limit, exclude, workspace, homes) {
      const errors: string[] = [];
      const lists = await Promise.all(homes.map((home) => sessions(home).then((found) => found.map((session) => ({ session, home }))).catch((error) => {
        errors.push(error instanceof Error ? error.message : String(error));
        return [];
      })));
      const items = lists.flat()
        .filter(({ session }) => !exclude.has(session.sessionId) && !isAppsOwn(session, workspace))
        .sort((a, b) => (b.session.updatedAt ?? "").localeCompare(a.session.updatedAt ?? ""))
        .slice(0, limit)
        .map(({ session, home }) => grokListing(session, home));
      return { items, errors };
    },
    async read(sessionId, configDir) {
      return ask(configDir, async (rpc) => {
        const session = (await listGrokSessions(rpc)).find((one) => one.sessionId === sessionId);
        if (!session) return null;
        return grokImported(session, await grokUpdates(rpc, sessionId, session.cwd ?? homedir()), configDir);
      });
    },
  };
}
