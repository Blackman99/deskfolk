/**
 * The task-map replay of Codex and Antigravity project sessions (ADR 0111 addendum 2026-11-17):
 * the pure mappings from hand-made threads and entries, and the route against a stand-in `agy acp`.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReplay, SessionDetail } from "@real-bot/protocol";
import { agyReplayOf } from "./agents/agy-replay";
import { codexReplayOf } from "./agents/codex-replay";
import type { AgyReplayEntry } from "./agents/agy-sessions";
import type { CodexThread } from "./agents/codex-sessions";
import { ulid } from "./ids";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const FAKE = join(import.meta.dir, "fixtures", "agents", "fake-agy.ts");
const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

const T0 = Date.parse("2026-11-17T10:00:00.000Z") / 1000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

test("Codex: calls are named and placed as the live frames are, timed from the turn's start by their durations; subagents carry their own", () => {
  const main: CodexThread = {
    id: "thr-main", model: "gpt-5.5", createdAt: T0 - 5,
    turns: [
      { id: "t1", startedAt: T0, completedAt: T0 + 10, items: [
        { type: "userMessage", id: "u1", content: [{ type: "text", text: "fix " }, { type: "text", text: "it" }] },
        { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'bun test'", cwd: "/work/proj", status: "completed", exitCode: 0, durationMs: 2000 },
        { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "src/a.ts" }], durationMs: 500 },
        { type: "commandExecution", id: "c2", command: "false", cwd: "/work/proj", status: "completed", exitCode: 1, durationMs: 60_000 },
        { type: "agentMessage", id: "m1", text: "done" },
      ] },
      { id: "t2", startedAt: T0 + 100, completedAt: null, status: "inProgress", items: [
        { type: "userMessage", id: "u2", content: [{ type: "text", text: "again" }] },
        { type: "webSearch", id: "w1", query: "x" },
        { type: "mcpToolCall", id: "p1", server: "docs", tool: "find", status: "completed", durationMs: 300 },
        { type: "collabAgentToolCall", id: "spawn1", tool: "spawnAgent", prompt: "Look at the logs\nand report", receiverThreadIds: ["thr-sub"] },
      ] },
    ],
  };
  const sub: CodexThread = {
    id: "thr-sub", model: "gpt-5.5-mini", agentNickname: "Scout",
    turns: [{ id: "s1", startedAt: T0 + 101, completedAt: T0 + 105, items: [{ type: "commandExecution", id: "sc1", command: "ls", status: "completed", exitCode: 0, durationMs: 100 }] }],
  };
  const replay = codexReplayOf([main, sub], { sessionId: "s", agentSession: "thr-main", projectDir: "/work/proj", home: "/home/me" });
  expect(replay.agent_session).toBe("thr-main");
  expect(replay.said).toEqual([{ kind: "say", at: iso(T0), text: "fix \nit" }, { kind: "say", at: iso(T0 + 100), text: "again" }]);
  const byId = Object.fromEntries(replay.calls.map((call) => [call.id, call]));
  expect(replay.calls.map((call) => call.id)).toEqual(["c1", "f1", "c2", "w1", "sc1", "p1"].sort((a, b) => byId[a]!.at.localeCompare(byId[b]!.at)));
  expect(byId.c1).toMatchObject({ at: iso(T0), tool: "shell", action: "check", agent_id: null, model: "gpt-5.5", ok: true, duration_ms: 2000, decision: null });
  expect(byId.f1).toMatchObject({ at: iso(T0 + 2), tool: "write_file", place: { zone: "project", path: "src/a.ts" }, file: "a.ts", duration_ms: 500, ok: true });
  // Never past the turn's end: a long command at 2.5 s stops at 10 s.
  expect(byId.c2).toMatchObject({ at: iso(T0 + 2.5), ok: false, duration_ms: 7500 });
  // The turn still going is read as far as it goes.
  expect(byId.w1).toMatchObject({ at: iso(T0 + 100), tool: "WebSearch" });
  expect(byId.p1).toMatchObject({ at: iso(T0 + 100), tool: "mcp__docs__find", duration_ms: 300 });
  expect(byId.sc1).toMatchObject({ agent_id: "thr-sub", model: "gpt-5.5-mini", at: iso(T0 + 101) });
  expect(replay.subagents).toEqual([{
    id: "thr-sub", description: "Look at the logs", agent_type: "Scout", model: "gpt-5.5-mini", spawned_by: "spawn1", first_at: iso(T0 + 101), last_at: iso(T0 + 105), calls: 1,
  }]);
});

const tool = (id: string, update: Record<string, unknown>): AgyReplayEntry => ({ kind: "tool", id, update: { toolCallId: id, status: "completed", ...update } });
const line = (kind: string, body: string, at: string) => ({ kind, body, created_at: at });
const ctx = { sessionId: "s", agentSession: "agy-1", projectDir: "/work/proj", home: "/home/me" };

test("agy: groups are matched to your lines by text and spread to the reply; a command's own times win; an unmatched group goes between", () => {
  const entries: AgyReplayEntry[] = [
    { kind: "user", text: "first ask, with extra words" },
    tool("a", { kind: "read", title: "x.ts", rawInput: { AbsolutePath: "/work/proj/x.ts" } }),
    tool("b", { kind: "edit", title: "x.ts", rawInput: { Path: "/work/proj/x.ts" }, status: "failed" }),
    { kind: "agent", text: "ok" },
    { kind: "user", text: "something the app never saw" },
    tool("c", { kind: "search", title: "grep", rawInput: { SearchPath: "/work/proj" } }),
    { kind: "user", text: "third" },
    tool("d", { kind: "execute", title: "run", rawInput: { CommandLine: "bun test" }, rawOutput: { output: "Created At: 2026-11-17T10:10:05.000Z\nCompleted At: 2026-11-17T10:10:08.000Z\nok" } }),
    tool("e", { kind: "fetch", title: "page" }),
  ];
  const lines = [
    line("user", "first ask", "2026-11-17T10:00:00.000Z"),
    line("bot", "ok", "2026-11-17T10:03:00.000Z"),
    line("user", "third", "2026-11-17T10:10:00.000Z"),
  ];
  const replay = agyReplayOf(entries, lines, ctx);
  const byId = Object.fromEntries(replay.calls.map((call) => [call.id, call]));
  // Two calls between 10:00 and 10:03: a third of the way each.
  expect(byId.a).toMatchObject({ tool: "Read", at: "2026-11-17T10:01:00.000Z", agent_id: null, model: null, decision: null, ok: true, file: "x.ts" });
  expect(byId.b).toMatchObject({ tool: "write_file", at: "2026-11-17T10:02:00.000Z", ok: false });
  // The unmatched group sits between the first reply and your third line.
  expect(Date.parse(byId.c!.at)).toBeGreaterThanOrEqual(Date.parse("2026-11-17T10:03:00.000Z"));
  expect(Date.parse(byId.c!.at)).toBeLessThan(Date.parse("2026-11-17T10:10:00.000Z"));
  expect(byId.c!.tool).toBe("Grep");
  // A command's own times; a call with none is spread over the minute after the line (no reply).
  expect(byId.d).toMatchObject({ tool: "shell", action: "check", at: "2026-11-17T10:10:05.000Z", duration_ms: 3000 });
  expect(byId.e).toMatchObject({ tool: "WebFetch", at: "2026-11-17T10:10:40.000Z" });
  expect(replay.said.map((one) => one.kind === "say" && one.text)).toEqual(["first ask", "third"]);
  expect(replay.calls.map((call) => call.at)).toEqual([...replay.calls.map((call) => call.at)].sort());
});

test("agy: with no lines matched the calls go before now, and a session with no calls is empty", () => {
  const replay = agyReplayOf([{ kind: "user", text: "zzz" }, tool("a", { kind: "read", title: "x" })], [line("user", "other", "2026-11-17T10:00:00.000Z")], ctx);
  expect(replay.calls).toHaveLength(1);
  expect(agyReplayOf([{ kind: "user", text: "hi" }, { kind: "agent", text: "yo" }], [], ctx).calls).toEqual([]);
});

test("the replay route asks agy to load the session and times its calls by the app's own lines", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-replay-")));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const script = { prompts: [], sessions: [{ sessionId: "agy-old", cwd: dir, title: "t", updatedAt: "2026-11-17T10:00:00.000Z", history: [
    { user: "hello there" }, { tool: { id: "t1", kind: "read", title: "a.ts", rawInput: { AbsolutePath: join(dir, "a.ts") } } },
    { tool: { id: "t2", kind: "execute", title: "run", rawInput: { CommandLine: "ls" } } }, { agent: "done" },
  ] }] };
  const api = createLocalApi({
    store, token: "agy-test", schedule: false,
    projectAgyVersion: async () => "1.5.10",
    projectAgy: async () => ({ ok: true, executable: process.execPath, source: "known", args: [FAKE, "acp"], proxy: null, env: { ...process.env as Record<string, string>, FAKE_AGY_SCRIPT: JSON.stringify(script) } }),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { api.projects.close(); await api.projects.idle(); await api.engine.close(); store.close(); await server.stop(true); rmSync(dir, { recursive: true, force: true }); });
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`http://${server.hostname}:${server.port}${path}`, {
      method, headers: { Authorization: "Bearer agy-test", "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": ulid() }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await response.json()) as T;
  };
  const made = await call<SessionDetail>("POST", "/v1/project-sessions", { agent: "antigravity", dir });
  store.recordProjectAgentSession(made.id, "agy-old");
  // The app's own line for the same words, and its reply, ten minutes apart.
  store.db.run(`INSERT INTO messages (id, session_id, kind, author, body, created_at) VALUES (?, ?, 'user', 'user', 'hello there', '2026-11-17T10:00:00.000Z')`, [ulid(), made.id]);
  store.db.run(`INSERT INTO messages (id, session_id, kind, author, body, created_at) VALUES (?, ?, 'bot', 'agy', 'done', '2026-11-17T10:09:00.000Z')`, [ulid(), made.id]);
  const replay = await call<AgentReplay>("GET", `/v1/project-sessions/${made.id}/replay`);
  expect(replay.agent_session).toBe("agy-old");
  expect(replay.calls.map((one) => [one.id, one.tool, one.at])).toEqual([["t1", "Read", "2026-11-17T10:03:00.000Z"], ["t2", "shell", "2026-11-17T10:06:00.000Z"]]);
  expect(replay.said).toEqual([{ kind: "say", at: "2026-11-17T10:00:00.000Z", text: "hello there" }]);
});
