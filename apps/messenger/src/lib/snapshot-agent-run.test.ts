import { expect, test } from "bun:test";
import { aProjectSession, anAgentRun } from "./test-fixtures.ts";
import { applyEvent, emptySnapshot, keepNewestRun } from "./snapshot.ts";

const upsert = (over: Parameters<typeof anAgentRun>[0]) => ({ event: "agent_run.upsert" as const, occurred_at: "t", ...anAgentRun(over) });

test("agent_run.upsert keeps the newest run of a session", () => {
  let snapshot = applyEvent(emptySnapshot(), upsert({ status: "running" }));
  expect(snapshot.agentRuns["proj-1"]?.status).toBe("running");
  snapshot = applyEvent(snapshot, upsert({ status: "waiting_approval", updated_at: "2026-09-19T01:00:05.000Z" }));
  expect(snapshot.agentRuns["proj-1"]?.status).toBe("waiting_approval");
  // The same run, older than what is held: a late frame does not roll it back.
  snapshot = applyEvent(snapshot, upsert({ status: "running", updated_at: "2026-09-19T01:00:01.000Z" }));
  expect(snapshot.agentRuns["proj-1"]?.status).toBe("waiting_approval");
  // A new run replaces it; an older run's late frame does not.
  snapshot = applyEvent(snapshot, upsert({ id: "run-2", status: "running", created_at: "2026-09-19T02:00:00.000Z", updated_at: "2026-09-19T02:00:00.000Z" }));
  expect(snapshot.agentRuns["proj-1"]?.id).toBe("run-2");
  snapshot = applyEvent(snapshot, upsert({ id: "run-1", status: "completed", updated_at: "2026-09-19T03:00:00.000Z" }));
  expect(snapshot.agentRuns["proj-1"]?.id).toBe("run-2");
});

test("runs are kept per session and go with a removed session", () => {
  let snapshot = applyEvent(emptySnapshot(), upsert({ session_id: "a" }));
  snapshot = applyEvent(snapshot, upsert({ id: "run-b", session_id: "b" }));
  expect(Object.keys(snapshot.agentRuns).sort()).toEqual(["a", "b"]);
  snapshot = applyEvent(snapshot, { event: "session.removed", occurred_at: "t", id: "a" });
  expect(Object.keys(snapshot.agentRuns)).toEqual(["b"]);
});

test("a run read on opening does not replace one an event already brought", () => {
  const newer = anAgentRun({ status: "completed", updated_at: "2026-09-19T01:05:00.000Z" });
  const runs = keepNewestRun({ "proj-1": newer }, anAgentRun({ status: "running" }));
  expect(runs["proj-1"]).toBe(newer);
  expect(keepNewestRun({}, newer)["proj-1"]).toBe(newer);
});

test("a project session upsert keeps its directory", () => {
  const session = aProjectSession();
  const next = applyEvent(emptySnapshot(), { event: "session.upsert", occurred_at: "t", ...session });
  expect(next.sessions[0]?.project_dir).toBe("/Users/a/proj");
});

test("a project session's model and thinking level come and go with its upserts; null is the default again", () => {
  let snapshot = applyEvent(emptySnapshot(), { event: "session.upsert", occurred_at: "t", ...aProjectSession({ project_model: "opus", project_effort: "high" }) });
  expect(snapshot.sessions[0]).toMatchObject({ project_model: "opus", project_effort: "high" });
  snapshot = applyEvent(snapshot, { event: "session.upsert", occurred_at: "t", ...aProjectSession({ project_model: null, project_effort: null }) });
  expect(snapshot.sessions[0]).toMatchObject({ project_model: null, project_effort: null });
});
