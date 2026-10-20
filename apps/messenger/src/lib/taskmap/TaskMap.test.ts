import { expect, test } from "bun:test";
import type { AgentReplay, AgentReplayCall, ToolFrame } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aProjectSession, fakeRuntime } from "../test-fixtures.ts";
import { settle } from "../test-async.ts";
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
