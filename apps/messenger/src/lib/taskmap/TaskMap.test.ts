import { expect, test } from "bun:test";
import { generateBoringAvatar, type AgentReplay, type AgentReplayCall, type SessionReplay, type SessionReplayCall, type ToolFrame } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aGroup, aProjectSession, aProvider, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { settle } from "../test-async.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import { AgentCallLog } from "./live.svelte.ts";
import TaskMap from "./TaskMap.svelte";

const t = copyFor("zh");
const T0 = Date.parse("2026-10-20T01:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

let n = 0;
function aCall(path: string, s: number, over: Partial<AgentReplayCall> = {}): AgentReplayCall {
  n += 1;
  return { id: `toolu_${n}`, at: iso(s), agent_id: null, tool: "Edit", place: { zone: "project", path }, model: "claude-opus-5-5", file: path.split("/").pop() ?? null, ok: true, duration_ms: 400, decision: null, ...over };
}

function aReplay(): AgentReplay {
  n = 0;
  return {
    session_id: "proj-1",
    agent_session: "s-1",
    source_session: null,
    calls: [
      ...Array.from({ length: 12 }, (_, i) => aCall("apps/daemon/src/store/a.ts", i * 5)),
      ...Array.from({ length: 12 }, (_, i) => aCall("apps/messenger/src/lib/chat/b.svelte", 70 + i * 5, i % 2 ? { agent_id: "agent-x", model: "claude-sonnet-5-5" } : {})),
      aCall("x", 140, { tool: "Bash", place: { zone: "check", check: "test" }, ok: false }),
    ],
    subagents: [{ id: "agent-x", description: "Build the chat", agent_type: "general-purpose", model: "sonnet", spawned_by: null, first_at: iso(75), last_at: iso(130), calls: 6 }],
    said: [{ kind: "say", at: iso(0), text: "把地图做出来" }],
  };
}

function open(replay = aReplay()) {
  const session = aProjectSession({ project_dir: "/w/real-bot" });
  const runtime = fakeRuntime({ sessions: [session], agentRuns: {} });
  Reflect.set(runtime, "client", { projectReplay: async () => replay });
  Reflect.set(runtime, "agentCalls", new AgentCallLog());
  const view = render(TaskMap, { runtime, t, session });
  return { ...view, runtime };
}

test("the map reads the session's replay and lays the town out from its folders", async () => {
  const { host, close } = open();
  await settle();
  const plates = [...host.querySelectorAll(".tm-plate .tm-plate-name")].map((el) => el.textContent?.replace(/\d+$/, ""));
  expect(plates).toContain(t.taskmap.places.root);
  expect(plates).toContain("store");
  expect(plates).toContain("chat");
  expect(plates).toContain(t.taskmap.places.check);
  // At its newest step: every call counted, the agent and its subagent both drawn with the agent's logo.
  expect(host.textContent).toContain(t.taskmap.controls.step(25, 25));
  expect(host.querySelectorAll(".tm-actor").length).toBe(2);
  expect(host.querySelectorAll(".tm-badge [data-agent-logo='claude_code']").length).toBeGreaterThan(0);
  // What it was asked, and the moments: a subagent went out, a call failed.
  expect(host.textContent).toContain("把地图做出来");
  expect(host.textContent).toContain(t.taskmap.moments.fail(1));
  // Nothing is running, so where it left off reads as rest rather than mid-step.
  expect(host.querySelector(".tm-side .tm-scard")?.textContent).toContain(t.taskmap.status.idle("").trim());
  close();
});

test("a building's plate opens its card, and the card's next visit moves the playhead", async () => {
  const { host, close } = open();
  await settle();
  const store = [...host.querySelectorAll<HTMLButtonElement>(".tm-plate")].find((b) => b.textContent?.includes("store"))!;
  click(store);
  const card = host.querySelector(".tm-insp");
  expect(card?.textContent).toContain("store");
  expect(card?.textContent).toContain("apps/daemon/src/store");
  click(host.querySelector(".tm-insp .ui-icon-btn"));
  expect(host.querySelector(".tm-insp")).toBeNull();
  close();
});

test("a call seen live lands on the map before any replay holds it", async () => {
  const { host, runtime, close } = open();
  await settle();
  const plateNames = () => [...host.querySelectorAll(".tm-plate .tm-plate-name")].map((el) => el.textContent ?? "");
  expect(plateNames().some((name) => name.includes(t.taskmap.places.git))).toBe(false);
  const frame = {
    type: "tool", turn_id: "run-1", id: "toolu_live", name: "Bash", phase: "started",
    agent_run: { session_id: "proj-1", agent_id: null, place: { zone: "git" }, model: "claude-opus-5-5", at: iso(200) },
  } as ToolFrame;
  runtime.agentCalls.applyTool(frame);
  await settle();
  // The town was laid out from the replay, so a new kind of place folds in rather than appearing as a new building.
  expect(host.textContent).toContain(t.taskmap.controls.step(26, 26));
  expect(plateNames().some((name) => name.includes(t.taskmap.places.git))).toBe(false);
  close();
});

test("a subagent's moment says what it was sent to do, and only a long call is a long one", async () => {
  const { host, close } = open();
  await settle();
  expect(host.textContent).toContain("Build the chat");
  expect(host.textContent).not.toContain(t.taskmap.moments.long(t.taskmap.verbs.edit, 0));
  close();
});

test("a new session's first calls lay its town out while they come in", async () => {
  const empty = { ...aReplay(), calls: [], subagents: [], said: [] };
  const { host, runtime, close } = open(empty);
  await settle();
  expect(host.textContent).toContain(t.taskmap.empty);
  for (let i = 0; i < 5; i++) {
    runtime.agentCalls.applyTool({
      type: "tool", turn_id: "run-1", id: `toolu_new_${i}`, name: "Read", phase: "started",
      agent_run: { session_id: "proj-1", agent_id: null, place: { zone: "project", path: "web/auth/login.ts" }, model: "claude-opus-5-5", at: iso(i * 3) },
    } as ToolFrame);
  }
  await settle();
  const plates = [...host.querySelectorAll(".tm-plate .tm-plate-name")].map((el) => el.textContent?.replace(/\d+$/, ""));
  expect(plates).toContain("auth");
  close();
});

test("the ground shows the grabbing hand only while it is being dragged", async () => {
  const { host, close } = open();
  await settle();
  const view = host.querySelector<HTMLElement>(".tm-view")!;
  const at = (type: string, x: number, buttons: number) =>
    view.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons, clientX: x, clientY: 100 }));
  at("pointerdown", 100, 1);
  at("pointermove", 130, 1);
  await settle();
  expect(view.classList.contains("is-dragging")).toBe(true);
  at("pointerup", 130, 0);
  await settle();
  expect(view.classList.contains("is-dragging")).toBe(false);
  close();
});

function aBotCall(bot: string, path: string, s: number, over: Partial<SessionReplayCall> = {}): SessionReplayCall {
  n += 1;
  return { id: `call_${n}`, at: iso(s), bot_id: bot, turn_id: "turn-1", task_id: null, tool: "write_file", place: { zone: "project", path }, model: "deepseek-chat",
    file: path.split("/").pop() ?? null, ok: true, duration_ms: 300, decision: null, ...over };
}

function openBots(replay: SessionReplay, turns = [] as ReturnType<typeof aTurn>[]) {
  const session = aGroup({ id: "g-1" });
  const director = aBot({ id: "bot-1", name: "导演", avatar: generateBoringAvatar({ name: "导演" }), provider_id: "prov-1" });
  const reviewer = aBot({ id: "bot-2", name: "审片员", runner: "claude_code" });
  const runtime = fakeRuntime({
    sessions: [session], bots: [director, reviewer], turns,
    providers: [aProvider({ id: "prov-1", name: "DeepSeek", base_url: "https://api.deepseek.com" })],
  });
  Reflect.set(runtime, "client", { sessionReplay: async () => replay, projectReplay: async () => { throw new Error("not a project session"); } });
  Reflect.set(runtime, "agentCalls", new AgentCallLog());
  const view = render(TaskMap, { runtime, t, session });
  return { ...view, runtime };
}

function aBotReplay(): SessionReplay {
  n = 0;
  return {
    session_id: "g-1",
    bots: ["bot-1", "bot-2"],
    truncated: false,
    calls: [
      ...Array.from({ length: 8 }, (_, i) => aBotCall("bot-1", "jobs/mv/shots/a.png", i * 10)),
      aBotCall("bot-1", "x", 85, { tool: "mcp_westlake_generate_video", place: { zone: "service", server: "westlake-cpa" }, file: null }),
      ...Array.from({ length: 6 }, (_, i) => aBotCall("bot-2", "jobs/mv/review/notes.md", 100 + i * 10, { tool: "read_file", model: "claude-opus-5-5" })),
    ],
    said: [
      { kind: "say", at: iso(0), text: "做一支 MV" },
      { kind: "answer", at: iso(95), asked_at: iso(90), questions: ["要几个镜头？"], answers: ["六个"], bot_id: "bot-2" },
    ],
  };
}

test("a Bot conversation's map: its Bots in the workspace, each with its own name, figure and its model's logo", async () => {
  const { host, close } = openBots(aBotReplay());
  await settle();
  const plates = [...host.querySelectorAll(".tm-plate .tm-plate-name")].map((el) => el.textContent?.replace(/\d+$/, ""));
  expect(plates).toContain(t.taskmap.bots.root);
  expect(plates).toContain("westlake-cpa");
  expect(plates.some((p) => p === "shots" || p === "review")).toBe(true);
  // Both Bots stand on the map all along, named as the sidebar names them.
  expect(host.querySelectorAll(".tm-actor").length).toBe(2);
  const names = [...host.querySelectorAll(".tm-badge-name")].map((el) => el.textContent);
  expect(names).toEqual(["导演", "审片员"]);
  // The endpoint's vendor on one badge, Claude Agent's spark on the other.
  expect(host.querySelector(".tm-badge .connector-logo.is-deepseek")).not.toBeNull();
  expect(host.querySelector(".tm-badge [data-agent-logo='claude_code']")).not.toBeNull();
  // One card for each Bot, not a main line and subagents.
  expect(host.querySelectorAll(".tm-side .tm-main").length).toBe(2);
  expect(host.textContent).not.toContain(t.taskmap.card.subs);
  // Your answer to the reviewer's question is a moment of its own, and the note says where the record comes from.
  expect(host.textContent).toContain("六个");
  expect(host.textContent).toContain(t.taskmap.bots.note);
  close();
});

test("a Bot conversation with no record yet says the map starts from this version", async () => {
  const { host, close } = openBots({ session_id: "g-1", bots: [], calls: [], said: [], truncated: false });
  await settle();
  expect(host.textContent).toContain(t.taskmap.bots.empty);
  close();
});

test("a Bot's call seen live lands on the map, its Bot working while its turn runs", async () => {
  const live = aTurn({ id: "turn-9", session_id: "g-1", bot_id: "bot-1", status: "running" });
  const { host, runtime, close } = openBots(aBotReplay(), [live]);
  await settle();
  expect(host.textContent).toContain(t.taskmap.controls.step(15, 15));
  runtime.agentCalls.applyTool({
    type: "tool", turn_id: "turn-9", id: "call_live", name: "shell", phase: "started",
    bot_call: { session_id: "g-1", bot_id: "bot-1", place: { zone: "project", path: "jobs/mv/shots" }, action: "script", model: "deepseek-chat", at: iso(300) },
  } as ToolFrame);
  await settle();
  expect(host.textContent).toContain(t.taskmap.controls.step(16, 16));
  expect(host.textContent).toContain(t.taskmap.live);
  close();
});

test("the same conversation, updated while it works, keeps its map: it is read again only for another conversation", async () => {
  const session = aGroup({ id: "g-1" });
  const runtime = fakeRuntime({ sessions: [session], bots: [aBot({ id: "bot-1" }), aBot({ id: "bot-2", name: "审片员" })] });
  let reads = 0;
  Reflect.set(runtime, "client", { sessionReplay: async () => { reads += 1; return aBotReplay(); } });
  Reflect.set(runtime, "agentCalls", new AgentCallLog());
  const props = reactive({ runtime, t, session });
  const { host, close } = render(TaskMap, props);
  await settle();
  expect(reads).toBe(1);
  const plates = () => host.querySelectorAll(".tm-plate").length;
  const before = plates();
  expect(before).toBeGreaterThan(0);
  // Every message and every step of a working Bot hands the pane a new summary of the same conversation.
  for (let i = 0; i < 5; i++) {
    props.session = { ...session, updated_at: iso(1000 + i) };
    await settle();
    expect(plates()).toBe(before);
  }
  expect(reads).toBe(1);
  props.session = aGroup({ id: "g-2" });
  await settle();
  expect(reads).toBe(2);
  close();
});
