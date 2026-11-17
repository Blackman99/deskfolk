/**
 * An Antigravity project session's work for the task map's replay (ADR 0111 addendum 2026-11-17),
 * from what `session/load` replays: your lines and each tool call as it last stood. `agy` gives no
 * times, so they are made from the app's own record of the session: a group of calls (those after
 * one line of yours) is matched to that line by its words and spread between the line and the
 * reply that followed it. A foreground command's own `Created At` and `Completed At`, which `agy`
 * writes into its output, are used as they are.
 */
import { homedir } from "node:os";
import type { AgentReplay, AgentReplayCall, AgentReplayLine } from "@real-bot/protocol";
import { fileOfCall, placeOfCall } from "../claude-code/tool-place";
import { textOfContent, textOfRaw } from "../engine/agent/drivers/acp";
import { agyActionOf } from "../project-runner-agy";
import { withAgyAcp } from "./agy-acp";
import { loadAgySession, type AgyReplayEntry } from "./agy-sessions";
import type { ResolvedAgent } from "./runtime";

/** The app's own lines of the session, oldest first: `user` is yours, `bot` the agent's reply. */
export type AgyReplayLineInput = { kind: string; body: string; created_at: string };
export type AgyReplayContext = { sessionId: string; agentSession: string | null; projectDir: string; home: string; configDirs?: string[] };

const FALLBACK_SPAN_MS = 60_000;
const TIMES = /Created At:\s*(\S+)[\s\S]*?Completed At:\s*(\S+)/;

type Group = { text: string; tools: Array<Extract<AgyReplayEntry, { kind: "tool" }>> };
type Window = { start: number; end: number };

function groupsOf(entries: AgyReplayEntry[]): Group[] {
  const groups: Group[] = [];
  let current: Group = { text: "", tools: [] };
  let opened = false;
  for (const entry of entries) {
    if (entry.kind === "user") {
      if (opened || current.tools.length > 0) groups.push(current);
      current = { text: entry.text.trim(), tools: [] };
      opened = true;
    } else if (entry.kind === "tool") current.tools.push(entry);
  }
  if (opened || current.tools.length > 0) groups.push(current);
  return groups;
}

/** Each group's index among the user lines, in order, or -1: equal words first, then one holding the other's. */
function match(groups: Group[], users: Array<{ index: number; text: string }>): number[] {
  const out: number[] = [];
  let from = 0;
  for (const group of groups) {
    let found = -1;
    if (group.text) {
      for (const pass of [0, 1]) {
        for (let i = from; i < users.length && found < 0; i += 1) {
          const text = users[i]!.text;
          if (!text) continue;
          if (pass === 0 ? text === group.text : text.includes(group.text) || group.text.includes(text)) found = i;
        }
        if (found >= 0) break;
      }
    }
    out.push(found);
    if (found >= 0) from = found + 1;
  }
  return out;
}

const when = (value: string): number => Date.parse(value);

/** The replay from loaded entries and the app's lines. */
export function agyReplayOf(entries: AgyReplayEntry[], lines: AgyReplayLineInput[], ctx: AgyReplayContext): AgentReplay {
  const users = lines.flatMap((line, index) => (line.kind === "user" ? [{ index, text: line.body.trim(), at: when(line.created_at) }] : []));
  const groups = groupsOf(entries);
  const matched = match(groups, users);
  const windows: Array<Window | null> = groups.map((_, i) => {
    const user = matched[i]! >= 0 ? users[matched[i]!]! : null;
    if (!user || !Number.isFinite(user.at)) return null;
    const reply = lines.slice(user.index + 1).find((line) => line.kind === "bot" && Number.isFinite(when(line.created_at)) && when(line.created_at) >= user.at);
    return { start: user.at, end: reply ? when(reply.created_at) : user.at + FALLBACK_SPAN_MS };
  });
  // Unmatched groups: together between the matched ones around them, or the minute before the first.
  for (let i = 0; i < groups.length; i += 1) {
    if (windows[i]) continue;
    let j = i;
    while (j < groups.length && !windows[j]) j += 1;
    const before = i > 0 ? windows[i - 1]! : null;
    const after = j < groups.length ? windows[j]! : null;
    const now = lines.length ? Math.max(...lines.map((line) => when(line.created_at)).filter(Number.isFinite), Date.now() - FALLBACK_SPAN_MS) : Date.now() - FALLBACK_SPAN_MS;
    const end = after ? after.start : (before ? before.end : now) + FALLBACK_SPAN_MS;
    const start = before ? Math.min(before.end, end) : end - FALLBACK_SPAN_MS;
    // The run's calls share one window, so each group is given the slice its calls take of it.
    const total = groups.slice(i, j).reduce((sum, group) => sum + group.tools.length, 0);
    let used = 0;
    for (let k = i; k < j; k += 1) {
      const share = total > 0 ? (end - start) / total : 0;
      windows[k] = { start: start + share * used, end: start + share * (used + groups[k]!.tools.length) };
      used += groups[k]!.tools.length;
    }
    i = j - 1;
  }
  const calls: AgentReplayCall[] = [];
  groups.forEach((group, g) => {
    const window = windows[g]!;
    const n = group.tools.length;
    group.tools.forEach((entry, i) => {
      const update = entry.update;
      const raw = (update.rawInput ?? update.args) as Record<string, unknown> | undefined;
      const locations = Array.isArray(update.locations) ? (update.locations as Array<{ path?: unknown }>).flatMap((one) => (typeof one.path === "string" ? [one.path] : [])) : [];
      const action = agyActionOf({ kind: typeof update.kind === "string" ? update.kind : null, title: typeof update.title === "string" ? update.title : "", rawInput: raw && typeof raw === "object" ? raw : {}, locations }, ctx.projectDir);
      const frame = action.appName === "shell" ? { name: "shell", tool: "Bash", input: { command: action.command ?? "" } }
        : action.appName === "write_file" ? { name: "write_file", tool: "Write", input: { file_path: action.paths[0] ?? action.cwd } }
        : action.appName === "read_file" ? { name: "Read", tool: "Read", input: { file_path: action.paths[0] ?? action.cwd } }
        : action.appName === "list_dir" ? { name: "Grep", tool: "Grep", input: { path: action.paths[0] ?? action.cwd } }
        : action.appName === "web" ? { name: "WebFetch", tool: "WebFetch", input: {} }
        : { name: action.vendorTool, tool: action.vendorTool, input: {} };
      const { place, action: shellAction } = placeOfCall(frame.tool, frame.input, { projectDir: ctx.projectDir, cwd: action.cwd, home: ctx.home, configDirs: ctx.configDirs });
      const slot = (window.end - window.start) / (n + 1);
      let at = window.start + slot * (i + 1);
      let duration = slot;
      const output = textOfRaw(update.rawOutput) ?? textOfContent(update.content) ?? "";
      const stamps = action.appName === "shell" ? TIMES.exec(output) : null;
      if (stamps) {
        const created = when(stamps[1]!);
        const completed = when(stamps[2]!);
        if (Number.isFinite(created) && Number.isFinite(completed) && completed >= created) {
          at = created;
          duration = completed - created;
        }
      }
      calls.push({
        id: entry.id, at: new Date(Math.round(at)).toISOString(), agent_id: null, tool: frame.name, place, ...(shellAction ? { action: shellAction } : {}), model: null,
        file: fileOfCall(frame.tool, frame.input), ok: update.status === "completed", duration_ms: Math.max(0, Math.round(duration)), decision: null,
      });
    });
  });
  calls.sort((a, b) => a.at.localeCompare(b.at));
  const said: AgentReplayLine[] = lines.filter((line) => line.kind === "user" && line.body.trim()).map((line) => ({ kind: "say", at: line.created_at, text: line.body }));
  return { session_id: ctx.sessionId, agent_session: ctx.agentSession, source_session: null, calls, subagents: [], said };
}

/** Asks `agy` to load the session and reads its replay; throws when it cannot. */
export async function readAgyReplay(
  resolve: () => Promise<ResolvedAgent>,
  lines: AgyReplayLineInput[],
  ctx: Omit<AgyReplayContext, "home"> & { home?: string },
): Promise<AgentReplay> {
  if (!ctx.agentSession) return { session_id: ctx.sessionId, agent_session: null, source_session: null, calls: [], subagents: [], said: [] };
  const agy = await resolve();
  if (!agy.ok) throw new Error(agy.error);
  const sessionId = ctx.agentSession;
  const loaded = await withAgyAcp(agy, homedir(), async (rpc, caps) => {
    if (!caps.load) throw new Error("this agy cannot load its sessions");
    return loadAgySession(rpc, sessionId, ctx.projectDir);
  });
  return agyReplayOf(loaded.entries, lines, { ...ctx, home: ctx.home ?? homedir() });
}
