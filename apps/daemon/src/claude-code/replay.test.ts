import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentReplay } from "./replay";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const ctx = { projectDir: "/work/app", home: "/Users/me", configDirs: [] };

function write(path: string, entries: Array<Record<string, unknown>>): string {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
}

const use = (id: string, name: string, input: Record<string, unknown>, at: string, extra: Record<string, unknown> = {}) =>
  ({ type: "assistant", timestamp: at, cwd: "/work/app", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, ...extra });
const result = (id: string, at: string, opts: { error?: boolean; decision?: Record<string, unknown>; content?: unknown } = {}) =>
  ({ type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: opts.error ?? false, content: opts.content ?? "ok" }] },
    ...(opts.decision ? { permissionDecision: opts.decision } : {}) });
const say = (text: string, at: string) => ({ type: "user", timestamp: at, message: { role: "user", content: text } });

test("a session's calls, where each worked, whether it went through, how long, and the decision Claude Code wrote", () => {
  const root = mkdtempSync(join(tmpdir(), "replay-"));
  dirs.push(root);
  const file = write(join(root, "s1.jsonl"), [
    say("修一下登录页", "2026-10-20T10:00:00.000Z"),
    use("t1", "Read", { file_path: "/work/app/src/login.ts" }, "2026-10-20T10:00:01.000Z"),
    result("t1", "2026-10-20T10:00:01.500Z", { decision: { decision: "accept", source: "config", reasonType: "mode" } }),
    use("t2", "Bash", { command: "bun test src/login.test.ts" }, "2026-10-20T10:00:02.000Z"),
    result("t2", "2026-10-20T10:00:12.000Z", { error: true }),
    use("t3", "Bash", { command: "rm -rf ~/.claude/projects" }, "2026-10-20T10:00:13.000Z"),
    result("t3", "2026-10-20T10:00:14.000Z", { error: true, decision: { decision: "reject", source: "config", reasonType: "safetyCheck" } }),
    use("t4", "AskUserQuestion", { questions: [{ question: "哪种？" }, { question: "放哪？" }] }, "2026-10-20T10:01:00.000Z"),
    result("t4", "2026-10-20T10:03:00.000Z", { content: 'Your questions have been answered: "哪种？"="A (Recommended)", "放哪？"="侧栏". You can now continue.',
      decision: { decision: "accept", source: "user_temporary" } }),
    use("t5", "Agent", { description: "map the code" }, "2026-10-20T10:04:00.000Z"),
    // A copy of an old message with no time: never a call of its own.
    { type: "api-request-blob", message: { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Read", input: { file_path: "/x" } }] } },
    // The same call written twice counts once.
    use("t1", "Read", { file_path: "/work/app/src/login.ts" }, "2026-10-20T10:00:01.000Z"),
    say("<command-name>/clear</command-name>", "2026-10-20T10:05:00.000Z"),
  ]);
  mkdirSync(join(root, "s1", "subagents"), { recursive: true });
  write(join(root, "s1", "subagents", "agent-abc.jsonl"), [
    use("s1", "Grep", { pattern: "login", path: "/work/app/src" }, "2026-10-20T10:04:05.000Z", { agentId: "abc", isSidechain: true }),
    result("s1", "2026-10-20T10:04:06.000Z"),
    use("s2", "Read", { file_path: "/work/app/docs/a.md" }, "2026-10-20T10:04:10.000Z", { agentId: "abc", isSidechain: true }),
    result("s2", "2026-10-20T10:04:11.000Z"),
  ]);
  writeFileSync(join(root, "s1", "subagents", "agent-abc.meta.json"), JSON.stringify({ agentType: "Explore", description: "map the code", toolUseId: "t5", model: "haiku" }));

  const replay = readAgentReplay({ sessionId: "p1", agentFile: file, sourceFile: null, agentSession: "s1", sourceSession: null }, ctx);
  expect(replay.calls.map((call) => call.id)).toEqual(["t1", "t2", "t3", "t4", "t5", "s1", "s2"]);
  expect(replay.calls[0]).toEqual({ id: "t1", at: "2026-10-20T10:00:01.000Z", agent_id: null, tool: "Read", place: { zone: "project", path: "src/login.ts" },
    file: "login.ts", ok: true, duration_ms: 500, decision: { decision: "accept", source: "config", reason_type: "mode" } });
  expect(replay.calls[1]).toMatchObject({ place: { zone: "check", check: "test" }, action: "check", ok: false, duration_ms: 10_000, decision: null });
  expect(replay.calls[2]).toMatchObject({ place: { zone: "claude_home" }, decision: { decision: "reject", reason_type: "safetyCheck" } });
  expect(replay.calls[4]).toMatchObject({ tool: "Agent", place: { zone: "none" }, duration_ms: 0 });
  expect(replay.calls.slice(5).map((call) => call.agent_id)).toEqual(["abc", "abc"]);
  expect(replay.subagents).toEqual([{ id: "abc", description: "map the code", agent_type: "Explore", model: "haiku", spawned_by: "t5",
    first_at: "2026-10-20T10:04:05.000Z", last_at: "2026-10-20T10:04:11.000Z", calls: 2 }]);
  expect(replay.said).toEqual([
    { kind: "say", at: "2026-10-20T10:00:00.000Z", text: "修一下登录页" },
    { kind: "answer", at: "2026-10-20T10:03:00.000Z", asked_at: "2026-10-20T10:01:00.000Z", questions: ["哪种？", "放哪？"], answers: ["A", "侧栏"] },
  ]);
  // Nothing of a command, a file's contents or a result is carried on.
  expect(JSON.stringify(replay)).not.toContain("rm -rf");
  expect(JSON.stringify(replay)).not.toContain("questions have been answered");
});

test("a session carried on from the terminal is read with its source, each call and line once", () => {
  const root = mkdtempSync(join(tmpdir(), "replay-"));
  dirs.push(root);
  const source = write(join(root, "src.jsonl"), [
    say("记住代号", "2026-10-19T10:00:00.000Z"),
    use("a1", "Read", { file_path: "/work/app/README.md" }, "2026-10-19T10:00:01.000Z"),
    result("a1", "2026-10-19T10:00:02.000Z"),
  ]);
  // A branch that copied the source's lines, and one that did not: both read the same.
  const copied = write(join(root, "branch.jsonl"), [
    say("记住代号", "2026-10-19T10:00:00.000Z"),
    use("a1", "Read", { file_path: "/work/app/README.md" }, "2026-10-19T10:00:01.000Z"),
    result("a1", "2026-10-19T10:00:02.000Z"),
    say("代号是什么", "2026-10-20T09:00:00.000Z"),
    use("b1", "Glob", { pattern: "*" }, "2026-10-20T09:00:01.000Z"),
  ]);
  const own = write(join(root, "branch2.jsonl"), [say("代号是什么", "2026-10-20T09:00:00.000Z"), use("b1", "Glob", { pattern: "*" }, "2026-10-20T09:00:01.000Z")]);
  for (const agentFile of [copied, own]) {
    const replay = readAgentReplay({ sessionId: "p1", agentFile, sourceFile: source, agentSession: "branch", sourceSession: "src" }, ctx);
    expect(replay.calls.map((call) => call.id)).toEqual(["a1", "b1"]);
    expect(replay.said.map((line) => (line.kind === "say" ? line.text : ""))).toEqual(["记住代号", "代号是什么"]);
    expect(replay).toMatchObject({ agent_session: "branch", source_session: "src" });
  }
  // Files gone: nothing to replay.
  expect(readAgentReplay({ sessionId: "p1", agentFile: join(root, "gone.jsonl"), sourceFile: null, agentSession: "gone", sourceSession: null }, ctx))
    .toEqual({ session_id: "p1", agent_session: null, source_session: null, calls: [], subagents: [], said: [] });
});
