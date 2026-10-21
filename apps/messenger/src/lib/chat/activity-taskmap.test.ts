import { expect, test } from "bun:test";
import { emptySnapshot } from "../snapshot.ts";
import { ChatActivity } from "./activity.svelte.ts";

const host = { api: null, snapshot: emptySnapshot(), selectedId: null };
const at = "2026-10-21T05:00:00.000Z";

test("a Bot's tool frames reach the task map's live log, as a project session's do", () => {
  const activity = new ChatActivity(host);
  // A Bot's call, with where it works (ADR 0097).
  expect(activity.acceptEphemeral({ type: "tool", turn_id: "turn-1", id: "call_1", name: "write_file", phase: "started",
    bot_call: { session_id: "dm-1", bot_id: "bot-1", place: { zone: "project", path: "shots/a.png" }, model: "claude-opus-5-5", at } })).toBe(true);
  // A project session's agent (ADR 0095).
  activity.acceptEphemeral({ type: "tool", turn_id: "run-1", id: "toolu_1", name: "Read", phase: "started",
    agent_run: { session_id: "proj-1", agent_id: null, place: { zone: "project", path: "src/a.ts" }, model: null, at } });
  // A frame that says nothing of where its call works.
  activity.acceptEphemeral({ type: "tool", turn_id: "turn-2", id: "call_2", name: "shell", phase: "started" });
  expect(activity.agentCalls.callsOf("dm-1").map((c) => [c.id, c.actor, c.running])).toEqual([["call_1", "bot-1", true]]);
  expect(activity.agentCalls.callsOf("proj-1").map((c) => c.id)).toEqual(["toolu_1"]);
  activity.acceptEphemeral({ type: "tool", turn_id: "turn-1", id: "call_1", name: "write_file", phase: "exited", duration_ms: 800,
    bot_call: { session_id: "dm-1", bot_id: "bot-1", place: { zone: "project", path: "shots/a.png" }, model: "claude-opus-5-5", at, ok: true } });
  expect(activity.agentCalls.callsOf("dm-1").map((c) => [c.id, c.running, c.ok, c.durationMs])).toEqual([["call_1", false, true, 800]]);
});
