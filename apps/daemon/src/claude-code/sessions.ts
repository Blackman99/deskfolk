/**
 * Your Claude Code sessions as files (ADR 0095): what the import lists, and one session read into
 * the lines its conversation shows. Claude Code keeps each session as `projects/<dir>/<id>.jsonl`
 * under an account's config directory, one JSON entry per line, chained by `parentUuid`. Only the
 * transcripts are read here, never a sign-in; a Bot's own tools stay out of these directories.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeCodeSessionListing } from "@real-bot/protocol";
import { defaultConfigDir } from "./account";

/** Where sessions are looked for: an account's directory, and the `agent_config_dir` a Bot on it keeps. */
export type ClaudeSessionRoot = { configDir: string | null; dir: string };

export type ClaudeSessionListing = ClaudeCodeSessionListing;

export type ClaudeSessionLine = { role: "user" | "assistant"; text: string; at: string };

export type ClaudeSessionRead = {
  session_id: string;
  title: string;
  cwd: string | null;
  lines: ClaudeSessionLine[];
  /** Tool calls the conversation made, not imported one by one. */
  tool_calls: number;
};

/** What a listing reads off each end of a file: titles are written as it goes, the start says where. */
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 128 * 1024;
/** How many files a listing opens at most while looking for ones that qualify. */
const SCAN_MAX = 400;
const TITLE_MAX = 120;

/** The daemon's own account first (null), then each you listed; a directory reached twice is kept once. */
export function claudeSessionRoots(listed: string[], env: Record<string, string | undefined> = process.env): ClaudeSessionRoot[] {
  const roots: ClaudeSessionRoot[] = [{ configDir: null, dir: env.CLAUDE_CONFIG_DIR?.trim() || defaultConfigDir() }];
  for (const dir of listed) roots.push({ configDir: dir, dir });
  return roots;
}

type Entry = Record<string, unknown>;

function parseLines(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object") out.push(value as Entry);
    } catch {
      // a line cut by the head or tail window, or one being written
    }
  }
  return out;
}

function readSlice(path: string, start: number, length: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** A session's name: the one you gave it, else the one Claude Code wrote, else its first prompt. */
function titleOf(entries: Entry[], fallback: string): string {
  let custom: string | null = null;
  let ai: string | null = null;
  for (const entry of entries) {
    if (entry.type === "custom-title") custom = str(entry.customTitle) ?? custom;
    else if (entry.type === "ai-title") ai = str(entry.aiTitle) ?? ai;
    else if (entry.type === "summary") ai ??= str(entry.summary);
  }
  return clip((custom ?? ai ?? fallback).replace(/\s+/g, " ").trim(), TITLE_MAX);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * What you typed, from a user entry's content: null for a tool result, a meta entry, a slash
 * command's own lines or an interrupt marker. System reminders inside it are left out.
 */
export function promptText(entry: Entry): string | null {
  if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) return null;
  // The summary a compaction writes reads as a prompt, but nobody typed it.
  if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return null;
  // Claude Code's own notices (a background task finishing) come as user lines too, from an origin that is not you.
  const origin = entry.origin as { kind?: unknown } | undefined;
  if (origin && typeof origin === "object" && origin.kind !== undefined && origin.kind !== "human") return null;
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    if (content.some((part) => (part as { type?: string })?.type === "tool_result")) return null;
    text = content.flatMap((part) => ((part as { type?: string; text?: string }).type === "text" ? [(part as { text: string }).text] : [])).join("\n");
  } else return null;
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text) return null;
  if (/^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)>/.test(text)) return null;
  if (/^\[Request interrupted by user/.test(text)) return null;
  return text;
}

function assistantParts(entry: Entry): { text: string; tools: number } {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return { text: content, tools: 0 };
  if (!Array.isArray(content)) return { text: "", tools: 0 };
  let text = "";
  let tools = 0;
  for (const part of content as Array<{ type?: string; text?: string }>) {
    if (part.type === "text" && typeof part.text === "string") text += part.text;
    else if (part.type === "tool_use") tools += 1;
  }
  return { text, tools };
}

/**
 * The sessions you could carry on, newest first: the terminal's, not the SDK's (the app's own
 * branches among those), each file once however many roots reach it.
 */
export function listClaudeSessions(roots: ClaudeSessionRoot[], options: { limit: number }): ClaudeSessionListing[] {
  const files: Array<{ path: string; real: string; configDir: string | null; mtime: number; size: number; id: string }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const projects = join(root.dir, "projects");
    let dirs: string[];
    try {
      dirs = readdirSync(projects);
    } catch {
      continue;
    }
    for (const name of dirs) {
      let names: string[];
      try {
        names = readdirSync(join(projects, name));
      } catch {
        continue;
      }
      for (const file of names) {
        if (!file.endsWith(".jsonl") || file.startsWith("agent-")) continue;
        const path = join(projects, name, file);
        try {
          const real = realpathSync(path);
          if (seen.has(real)) continue;
          const stat = statSync(real);
          if (!stat.isFile() || stat.size === 0) continue;
          seen.add(real);
          files.push({ path, real, configDir: root.configDir, mtime: stat.mtimeMs, size: stat.size, id: file.slice(0, -".jsonl".length) });
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: ClaudeSessionListing[] = [];
  for (const file of files.slice(0, SCAN_MAX)) {
    if (out.length >= options.limit) break;
    let head: Entry[];
    let tail: Entry[];
    try {
      head = parseLines(readSlice(file.real, 0, Math.min(HEAD_BYTES, file.size)));
      tail = file.size > HEAD_BYTES ? parseLines(readSlice(file.real, Math.max(0, file.size - TAIL_BYTES), Math.min(TAIL_BYTES, file.size))) : head;
    } catch {
      continue;
    }
    const lastEntrypoint = [...tail].reverse().map((entry) => str(entry.entrypoint)).find(Boolean) ?? null;
    if (lastEntrypoint && lastEntrypoint.startsWith("sdk")) continue;
    const firstPrompt = head.map(promptText).find((text): text is string => text !== null);
    if (!firstPrompt) continue;
    const cwd = head.map((entry) => str(entry.cwd)).find(Boolean) ?? null;
    const branch = [...tail].reverse().map((entry) => str(entry.gitBranch)).find(Boolean) ?? null;
    out.push({
      session_id: file.id,
      config_dir: file.configDir,
      title: titleOf(file.size > HEAD_BYTES ? [...head, ...tail] : head, firstPrompt),
      cwd,
      git_branch: branch,
      modified_at: new Date(file.mtime).toISOString(),
      size: file.size,
    });
  }
  return out;
}

/** The file of one session under an account's directory, or null when there is none. */
export function findClaudeSessionFile(root: ClaudeSessionRoot, sessionId: string): string | null {
  // A file name, never a path.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  const projects = join(root.dir, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const name of dirs) {
    const path = join(projects, name, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * One session's conversation as it ended: the chain back from its last line (`parentUuid`, and
 * across a compaction `logicalParentUuid`), so a rewound branch and subagents' sidechains are left
 * out. Your prompts and Claude's text in order; tool calls only counted.
 */
export function readClaudeSession(path: string, sessionId: string): ClaudeSessionRead {
  const entries = parseLines(readFileSync(path, "utf8"));
  const byUuid = new Map<string, Entry>();
  let last: Entry | null = null;
  for (const entry of entries) {
    const uuid = str(entry.uuid);
    if (!uuid) continue;
    byUuid.set(uuid, entry);
    if ((entry.type === "user" || entry.type === "assistant") && entry.isSidechain !== true) last = entry;
  }
  const chain: Entry[] = [];
  const visited = new Set<string>();
  for (let at: Entry | undefined = last ?? undefined; at; ) {
    const uuid = str(at.uuid)!;
    if (visited.has(uuid)) break;
    visited.add(uuid);
    chain.push(at);
    const parent = str(at.parentUuid) ?? str(at.logicalParentUuid);
    at = parent ? byUuid.get(parent) : undefined;
  }
  chain.reverse();
  const lines: ClaudeSessionLine[] = [];
  let toolCalls = 0;
  /** Claude's text since your last prompt: one reply, however many steps it took. */
  let reply: ClaudeSessionLine | null = null;
  const flush = () => {
    if (reply && reply.text.trim()) lines.push({ ...reply, text: reply.text.trim() });
    reply = null;
  };
  for (const entry of chain) {
    const at = str(entry.timestamp) ?? new Date(0).toISOString();
    if (entry.type === "user") {
      const text = promptText(entry);
      if (text === null) continue;
      flush();
      lines.push({ role: "user", text, at });
    } else if (entry.type === "assistant" && entry.isSidechain !== true) {
      const { text, tools } = assistantParts(entry);
      toolCalls += tools;
      if (!text.trim()) continue;
      if (reply) reply.text += `\n\n${text}`;
      else reply = { role: "assistant", text, at };
    }
  }
  flush();
  const cwd = entries.map((entry) => str(entry.cwd)).find(Boolean) ?? null;
  const firstPrompt = lines.find((line) => line.role === "user")?.text ?? sessionId;
  return { session_id: sessionId, title: titleOf(entries, firstPrompt), cwd, lines, tool_calls: toolCalls };
}
