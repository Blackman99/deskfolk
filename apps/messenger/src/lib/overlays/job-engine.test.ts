import { expect, test } from "bun:test";
import { builtinPlaybook } from "@real-bot/protocol";
import { engineOffSteps, sessionEngine, sessionsOnEngine } from "./job-engine.ts";

const sessions = [
  { id: "g-video", playbook_id: "video", origin_session_id: null },
  { id: "d-plain", playbook_id: null, origin_session_id: null },
  // A Bot↔Bot direct opened from the video group runs the group's engine.
  { id: "bb", playbook_id: null, origin_session_id: "g-video" },
  { id: "d-old", playbook_id: "removed-engine", origin_session_id: null },
  { id: "d-archived", playbook_id: "video", origin_session_id: null, archived_at: "2026-10-01T00:00:00.000Z" },
];
const known = (id: string) => id !== "removed-engine";

test("a job's engine is its conversation's, or the one it came from, else the default", () => {
  expect(sessionEngine(sessions, "g-video", "general", known)).toEqual({ id: "video", why: "own" });
  expect(sessionEngine(sessions, "bb", "general", known)).toEqual({ id: "video", why: "inherited" });
  expect(sessionEngine(sessions, "d-plain", "general", known)).toEqual({ id: "general", why: "fallback" });
  // An engine since removed reads as the default; a conversation gone is said so.
  expect(sessionEngine(sessions, "d-old", "general", known)).toEqual({ id: "general", why: "fallback" });
  expect(sessionEngine(sessions, "deleted", "general", known)).toEqual({ id: "general", why: "gone" });
  expect(sessionEngine(sessions, null, "coding", known)).toEqual({ id: "coding", why: "gone" });
});

test("the conversations on an engine leave the archived out and count those that inherit it", () => {
  expect(sessionsOnEngine(sessions, "video", "general", known)).toBe(2);
  expect(sessionsOnEngine(sessions, "general", "general", known)).toBe(2);
});

test("an engine's steps switched off are named in Roles' order; a step that cannot be switched is never off", () => {
  expect(engineOffSteps({ resolved: builtinPlaybook("general") })).toEqual(["scribe", "reflection"]);
  expect(engineOffSteps({ resolved: builtinPlaybook("video") })).toEqual(["escalation"]);
  expect(engineOffSteps(undefined)).toEqual([]);
});
