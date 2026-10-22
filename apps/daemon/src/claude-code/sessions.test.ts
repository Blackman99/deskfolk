import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryKeyStore } from "../secrets";
import { Store } from "../store";
import { claudeSessionRoots, findClaudeSessionFile, listClaudeSessions, readClaudeSession } from "./sessions";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function account(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  dirs.push(dir);
  return dir;
}

let seq = 0;
const at = (minute: number) => `2026-10-19T10:${String(minute).padStart(2, "0")}:00.000Z`;

/** One session file, its entries written as Claude Code does: one JSON object per line. */
function session(root: string, project: string, id: string, entries: Array<Record<string, unknown>>, mtime?: Date): string {
  const dir = join(root, "projects", project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

function user(uuid: string, parent: string | null, content: unknown, extra: Record<string, unknown> = {}) {
  return { type: "user", uuid, parentUuid: parent, isSidechain: false, cwd: "/work/app", entrypoint: "cli", gitBranch: "main", timestamp: at(++seq), message: { role: "user", content }, ...extra };
}

function claude(uuid: string, parent: string, content: unknown[], extra: Record<string, unknown> = {}) {
  return { type: "assistant", uuid, parentUuid: parent, isSidechain: false, cwd: "/work/app", entrypoint: "cli", timestamp: at(++seq), message: { id: `msg-${uuid}`, role: "assistant", content }, ...extra };
}

test("a session reads as your prompts and Claude's replies along the chain it ended on", () => {
  const root = account();
  const path = session(root, "-work-app", "s-1", [
    { type: "mode", mode: "normal" },
    user("u0", null, "<command-name>/clear</command-name>"),
    user("u1", "u0", "<system-reminder>ignore me</system-reminder>登录页白屏了"),
    claude("a1", "u1", [{ type: "text", text: "我先看看路由。" }, { type: "tool_use", id: "t1", name: "Read", input: {} }]),
    user("r1", "a1", [{ type: "tool_result", tool_use_id: "t1", content: "..." }]),
    claude("a2", "r1", [{ type: "text", text: "是路由守卫的问题。" }]),
    // A rewound branch: never the conversation as it ended.
    user("x1", "a2", "这条后来撤回了"),
    claude("x2", "x1", [{ type: "text", text: "撤回分支的答复" }]),
    // A subagent's sidechain.
    claude("sc", "a2", [{ type: "text", text: "子代理的话" }], { isSidechain: true }),
    { type: "system", subtype: "compact_boundary", uuid: "cb", parentUuid: null, logicalParentUuid: "a2", timestamp: at(++seq) },
    user("cs", "cb", "This session is being continued from a previous conversation…", { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user("u2", "cs", [{ type: "text", text: "把测试补上" }], { origin: { kind: "human" } }),
    user("m2", "u2", "Caveat: meta", { isMeta: true }),
    // Claude Code's notice that a background task finished: a user line nobody typed, older builds without its origin.
    user("n2", "m2", "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>", { origin: { kind: "task-notification" } }),
    user("n3", "n2", "<task-notification>\n<task-id>b2</task-id>\n</task-notification>"),
    claude("a3", "n3", [{ type: "tool_use", id: "t2", name: "Bash", input: {} }]),
    claude("a4", "a3", [{ type: "text", text: "补好了。" }]),
    { type: "ai-title", aiTitle: "修登录页白屏" },
  ]);
  const read = readClaudeSession(path, "s-1");
  expect(read.title).toBe("修登录页白屏");
  expect(read.cwd).toBe("/work/app");
  expect(read.tool_calls).toBe(2);
  expect(read.lines.map((line) => [line.role, line.text])).toEqual([
    ["user", "登录页白屏了"],
    ["assistant", "我先看看路由。\n\n是路由守卫的问题。"],
    ["user", "把测试补上"],
    ["assistant", "补好了。"],
  ]);
  expect(read.lines[0]!.at).toBe(at(2));
});

test("the listing has terminal sessions newest first, each file once, with the name you gave it over Claude Code's", () => {
  const root = account();
  const other = account();
  session(root, "-work-app", "old", [user("u", null, "旧的会话")], new Date("2026-10-01T00:00:00Z"));
  session(root, "-work-app", "named", [user("u", null, "第一句"), { type: "ai-title", aiTitle: "自动标题" }, { type: "custom-title", customTitle: "我起的名字" }],
    new Date("2026-10-18T00:00:00Z"));
  // The app's own branch: SDK lines appended after the terminal's.
  session(root, "-work-app", "branch", [user("u", null, "终端里的话"), user("v", "u", "应用里的话", { entrypoint: "sdk-ts" })], new Date("2026-10-19T00:00:00Z"));
  // Nothing typed: a session that only ran a command.
  session(root, "-work-app", "empty", [user("u", null, "<command-name>/model</command-name>")], new Date("2026-10-19T00:00:00Z"));
  // A subagent's own file.
  session(root, "-work-app", "agent-abc", [user("u", null, "子代理")], new Date("2026-10-19T00:00:00Z"));
  // A second account whose projects are the first's, as ~/.claude-b/projects can be.
  symlinkSync(join(root, "projects"), join(other, "projects"));
  const listed = listClaudeSessions(claudeSessionRoots([other], { CLAUDE_CONFIG_DIR: root }), { limit: 10 });
  expect(listed.map((row) => [row.session_id, row.title, row.config_dir])).toEqual([
    ["named", "我起的名字", null],
    ["old", "旧的会话", null],
  ]);
  expect(listed[0]).toMatchObject({ cwd: "/work/app", git_branch: "main" });
  expect(listClaudeSessions(claudeSessionRoots([other], { CLAUDE_CONFIG_DIR: root }), { limit: 1 })).toHaveLength(1);
  expect(findClaudeSessionFile({ configDir: other, dir: other }, "named")).not.toBeNull();
  expect(findClaudeSessionFile({ configDir: other, dir: other }, "../named")).toBeNull();
});

test("an import is a project session in the session's directory, its history read and no Bot's (ADR 0095)", () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  try {
    const read = { session_id: "src", title: "修登录页", cwd: "/work/app", tool_calls: 4, lines: [
      { role: "user" as const, text: "登录页白屏了", at: at(1) },
      { role: "assistant" as const, text: "是路由守卫的问题", at: at(2) },
    ] };
    const created = store.createProjectSession({ dir: "/work/app", agent: "claude_code", configDir: null, imported: read, locale: "zh" });
    expect(created).toMatchObject({ kind: "project", name: "修登录页", project_dir: "/work/app", project_agent: "claude_code", project_source: "src", project_agent_session: null });
    expect(created.participants.map((row) => row.member)).toEqual(["user"]);
    const rows = store.db
      .query<{ kind: string; author: string; body: string; created_at: string; hidden_from_bots: number }, [string]>(
        `SELECT kind, author, body, created_at, hidden_from_bots FROM messages WHERE session_id = ? ORDER BY created_at, id`)
      .all(created.id);
    expect(rows.slice(0, 2).map((row) => [row.kind, row.author, row.created_at.slice(0, 16)])).toEqual([
      ["user", "user", at(1).slice(0, 16)],
      ["bot", "agent", at(2).slice(0, 16)],
    ]);
    expect(rows.at(-1)).toMatchObject({ kind: "system", author: "app" });
    expect(rows.at(-1)!.body).toContain("4 次工具调用没有列出");
    expect(rows.every((row) => row.hidden_from_bots === 1)).toBe(true);
    expect(store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM bots`).get()?.n).toBe(0);
    expect(store.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM notifications WHERE session_id = ?`).get(created.id)?.n).toBe(0);
    expect(store.listSessions().find((row) => row.id === created.id)?.unread_count ?? 0).toBe(0);
    expect(store.projectOf(created.id)).toEqual({ dir: "/work/app", agent: "claude_code", configDir: null, agentSession: null, source: "src", model: null, effort: null, mode: null });
  } finally {
    store.close();
  }
});
