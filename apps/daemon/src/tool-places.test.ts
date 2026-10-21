import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionReplay, ToolFrame } from "@real-bot/protocol";
import type { CompletionOk } from "./completions";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { botPlaceOf, cardPlaceOf } from "./tool-places";

const ctx = { root: "/ws", workDir: "jobs/mv", home: "/Users/me" };

test("a Bot's file tools work where their path is, read from the workspace root", () => {
  expect(botPlaceOf("read_file", { path: "docs/plan.md" }, ctx)).toEqual({ place: { zone: "project", path: "docs/plan.md" }, file: "plan.md" });
  expect(botPlaceOf("write_file", { path: "/ws/jobs/mv/shot.png", content: "…" }, ctx)).toEqual({ place: { zone: "project", path: "jobs/mv/shot.png" }, file: "shot.png" });
  expect(botPlaceOf("list_dir", { path: "." }, ctx)).toEqual({ place: { zone: "project", path: "" }, file: null });
  expect(botPlaceOf("read_file", { path: "/tmp/elsewhere.txt" }, ctx).place).toEqual({ zone: "outside", path: "/tmp/elsewhere.txt" });
  expect(botPlaceOf("read_file", { path: "~/notes/a.md" }, ctx).place).toEqual({ zone: "outside", path: "/Users/me/notes/a.md" });
});

test("a Bot's shell works where its paths are, from its cwd or else the turn's work dir; MCP at its server; the rest nowhere", () => {
  // A bare word is not a path: with none named, it works where it runs.
  expect(botPlaceOf("shell", { command: "ls frames", cwd: "jobs/mv" }, ctx)).toMatchObject({ place: { zone: "project", path: "jobs/mv" }, action: "search" });
  expect(botPlaceOf("shell", { command: "ls frames/", cwd: "jobs/mv" }, ctx).place).toEqual({ zone: "project", path: "jobs/mv/frames" });
  expect(botPlaceOf("shell", { command: "ffmpeg -i cut.mp4 -vf scale=720:-1 small.mp4" }, ctx)).toMatchObject({ place: { zone: "project", path: "jobs/mv/small.mp4" }, file: "small.mp4" });
  expect(botPlaceOf("shell", { command: "python3 render.py" }, ctx)).toMatchObject({ place: { zone: "project", path: "jobs/mv/render.py" }, action: "script", file: "render.py" });
  expect(botPlaceOf("shell", { command: "git status" }, ctx).place).toEqual({ zone: "git" });
  expect(botPlaceOf("shell", { command: "bun test" }, { ...ctx, workDir: null }).place).toEqual({ zone: "check", check: "test" });
  expect(botPlaceOf("mcp_westlake_generate_video", { prompt: "x" }, ctx, "westlake-cpa")).toEqual({ place: { zone: "service", server: "westlake-cpa" }, file: null });
  expect(botPlaceOf("send_message", { body: "hi" }, ctx)).toEqual({ place: { zone: "none" }, file: null });
});

test("a card that comes before its call names its place: a command where it runs, a file by its path", () => {
  expect(cardPlaceOf({ kind_key: "shell", target: "/ws/jobs/mv", summary: "shell ffmpeg -i in.mp4 out.mp4" }, ctx)).toMatchObject({ tool: "shell", place: { zone: "project", path: "jobs/mv/out.mp4" } });
  expect(cardPlaceOf({ kind_key: "file-write", target: "/ws/docs/brief.md", summary: "file-write docs/brief.md" }, ctx)).toMatchObject({ tool: "write_file", place: { zone: "project", path: "docs/brief.md" }, file: "brief.md" });
  expect(cardPlaceOf({ kind_key: "agent-permission", target: "Bash", summary: "Bash …" }, ctx)).toMatchObject({ tool: "agent-permission", place: { zone: "none" } });
});

function call(id: string, name: string, args: Record<string, unknown>): CompletionOk {
  return { ok: true, content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }], finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null };
}

test("a Bot turn's calls are kept with where they worked, told on their frames, and read back as the conversation's replay", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bot-places-")));
  mkdirSync(join(root, "src"));
  const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
  const steps = [
    call("call_1", "write_file", { path: "docs/plan.md", content: "SECRET_BODY" }),
    call("call_2", "shell", { command: "ls src/", cwd: "." }),
    call("call_3", "read_file", { path: "/definitely/not/here.txt" }),
    // How a turn ends is not a step of its work.
    call("call_4", "end_turn", {}),
  ];
  const api = createLocalApi({
    store, token: "fixture", schedule: false,
    completions: {
      async complete(request) {
        const done = request.messages.filter((m) => m.role === "tool").length;
        return steps[done] ?? { ok: true, content: "done", toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
      },
      async judge() { throw new Error("direct turns do not judge"); },
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const get = (path: string) => fetch(`http://${server.hostname}:${server.port}${path}`, { headers: { Authorization: "Bearer fixture" } });
  const frames: ToolFrame[] = [];
  const unsubscribe = api.subscribeTools((frame) => frames.push(frame));
  try {
    await store.patchSettings({ workspace_path: root, endpoint_base_url: "http://127.0.0.1:1/v1",
      endpoint_api_key: "fixture", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
    const created = store.createBot({ name: "Builder", duties: "build", boundaries: "stay" });
    const bot = created.bot;
    const session = created.direct_session.id;
    const trigger = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写个计划" });
    await api.engine.handleInboundMessage(trigger, { fromUser: true });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && frames.filter((f) => f.phase === "exited").length < 4) await Bun.sleep(50);

    // end_turn still goes out as a frame, with nothing for the map.
    const ends = frames.filter((f) => f.name === "end_turn");
    expect(ends.length).toBeGreaterThan(0);
    expect(ends.every((f) => f.bot_call === undefined)).toBe(true);
    const started = frames.filter((f) => f.phase === "started" && f.name !== "end_turn");
    expect(started.map((f) => f.bot_call?.place)).toStrictEqual([
      { zone: "project", path: "docs/plan.md" },
      { zone: "project", path: "src" },
      { zone: "outside", path: "/definitely/not/here.txt" },
    ]);
    expect(started.every((f) => f.bot_call?.session_id === session && f.bot_call?.bot_id === bot.id && f.bot_call?.model === "fixture")).toBe(true);
    const ended = frames.filter((f) => f.phase === "exited" && f.name !== "end_turn");
    expect(ended.map((f) => f.bot_call?.ok)).toEqual([true, true, false]);

    const res = await get(`/v1/sessions/${session}/replay`);
    expect(res.status).toBe(200);
    const replay = (await res.json()) as SessionReplay;
    expect(replay.bots).toEqual([bot.id]);
    expect(replay.truncated).toBe(false);
    expect(replay.calls.map((c) => [c.id, c.tool, c.place.zone, c.file, c.ok, c.model])).toEqual([
      ["call_1", "write_file", "project", "plan.md", true, "fixture"],
      ["call_2", "shell", "project", null, true, "fixture"],
      ["call_3", "read_file", "outside", "here.txt", false, "fixture"],
    ]);
    expect(replay.calls[1]!.action).toBe("search");
    expect(replay.said).toEqual([{ kind: "say", at: trigger.created_at, text: "写个计划" }]);
    // The place is kept, never what the call carried.
    expect(JSON.stringify(store.db.query("SELECT * FROM tool_places").all())).not.toContain("SECRET_BODY");

    // A project session has its own replay, and clearing a conversation takes its record with it.
    const missing = await get("/v1/sessions/nope/replay");
    expect(missing.status).toBe(404);
    store.clearSessionMessages(session, { eraseQuotes: false });
    expect(store.sessionReplay(session).calls).toEqual([]);
  } finally {
    unsubscribe();
    api.terminals.shutdown();
    await api.engine.close();
    store.close();
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("a call whose card comes first is on the map at the card's place, then takes its own place, and carries your answer", () => {
  const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
  try {
    const created = store.createBot({ name: "Agent", duties: "d", boundaries: "b" });
    const bot = created.bot;
    const session = created.direct_session.id;
    const trigger = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "改一下" });
    const turn = store.createTurn({ sessionId: session, botId: bot.id, triggerMessageId: trigger.id });
    const fallback = { tool: "write_file", place: { zone: "project" as const, path: "docs/a.md" }, file: "a.md" };

    const approved = store.insertApproval({ turnId: turn.id, messageId: null, kind_key: "file-write", summary: "file-write docs/a.md", target: "/ws/docs/a.md" });
    store.cardForToolPlace({ turnId: turn.id, toolCallId: "toolu_1", approvalId: approved.id, fallback });
    store.resolveApproval(approved.id, "allow_once");
    store.finishToolPlace({ turnId: turn.id, toolCallId: "toolu_1", ok: true });
    // Allowed, the call starts: its own place and model, open again until it ends.
    store.beginToolPlace({ turnId: turn.id, toolCallId: "toolu_1", tool: "write_file", place: { zone: "project", path: "docs/b.md" }, file: "b.md", model: "claude-opus-5-5" });
    store.finishToolPlace({ turnId: turn.id, toolCallId: "toolu_1", ok: true, durationMs: 1200 });

    const denied = store.insertApproval({ turnId: turn.id, messageId: null, kind_key: "shell", summary: "shell rm -rf out", target: "/ws" });
    store.cardForToolPlace({ turnId: turn.id, toolCallId: "toolu_2", approvalId: denied.id, fallback: { tool: "shell", place: { zone: "project", path: "out" }, file: null } });
    store.resolveApproval(denied.id, "deny");
    store.finishToolPlace({ turnId: turn.id, toolCallId: "toolu_2", ok: false, errorCode: "denied" });

    const calls = store.sessionReplay(session).calls;
    expect(calls.map((c) => [c.id, c.place, c.model, c.ok, c.decision?.decision, c.decision?.source])).toEqual([
      ["toolu_1", { zone: "project", path: "docs/b.md" }, "claude-opus-5-5", true, "accept", "user_temporary"],
      ["toolu_2", { zone: "project", path: "out" }, null, false, "reject", "user_reject"],
    ]);
    // The call's own time once it ran; a refused one's is the wait for your answer.
    expect(calls[0]!.duration_ms).toBe(1200);
  } finally {
    store.close();
  }
});
