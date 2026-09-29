import { describe, expect, test } from "bun:test";
import { Store } from ".";
import { ORGANIZER_RUNS_KEPT_PER_SESSION, ORGANIZER_RUNS_PRUNE_EDGE_SQL, ORGANIZER_RUNS_PRUNE_SQL } from "./organizer-runs";

function open(): Store {
  return new Store();
}

/** A minimal, valid write; each test overrides the fields it cares about. */
function baseInput(overrides: Partial<Parameters<Store["recordOrganizerRun"]>[0]> = {}): Parameters<Store["recordOrganizerRun"]>[0] {
  return {
    sessionId: "session-1",
    taskId: null,
    mode: "message",
    messageId: null,
    spendId: null,
    rawAnswer: null,
    failKind: null,
    decision: null,
    candidatesPayload: { recent_plan_ids: [], elsewhere_plan_ids: [], existing_check_ids: [] },
    candidatesApply: null,
    candidatesAtParse: null,
    downgradeReason: null,
    applied: false,
    rejectReason: null,
    held: null,
    appliedTaskId: null,
    appliedTicketId: null,
    ...overrides,
  };
}

describe("organizer runs", () => {
  test("a row round-trips its JSON fields and its boolean as SQLite's own 0/1", () => {
    const store = open();
    const row = store.recordOrganizerRun(
      baseInput({
        taskId: "plan-1",
        mode: "settle",
        rawAnswer: '{"decision":"continue"}',
        decision: "continue",
        candidatesPayload: { recent_plan_ids: ["p1", "p2"], elsewhere_plan_ids: ["p3"], existing_check_ids: ["c1"] },
        candidatesApply: { decision: "continue", resume_plan_id: null, join_plan_id: null, ticket_ids: ["t1"], message_ticket: null, check_ids: ["c1"] },
        candidatesAtParse: { recent_plan_ids: ["p1", "p2"], elsewhere_plan_ids: ["p3"], existing_check_ids: ["c1"] },
        applied: true,
        held: ["kept the goal as it was"],
        appliedTaskId: "plan-1",
        appliedTicketId: "t1",
      }),
    );
    expect(row.applied).toBe(true);
    expect(row.candidates_payload).toEqual({ recent_plan_ids: ["p1", "p2"], elsewhere_plan_ids: ["p3"], existing_check_ids: ["c1"] });
    expect(row.candidates_apply).toEqual({ decision: "continue", resume_plan_id: null, join_plan_id: null, ticket_ids: ["t1"], message_ticket: null, check_ids: ["c1"] });
    expect(row.candidates_at_parse).toEqual({ recent_plan_ids: ["p1", "p2"], elsewhere_plan_ids: ["p3"], existing_check_ids: ["c1"] });
    expect(row.held).toEqual(["kept the goal as it was"]);
    // The raw row underneath is a real SQLite table, not just the typed accessor: 0/1, not a JS boolean.
    const raw = store.db.query<{ applied: number }, [string]>("SELECT applied FROM organizer_runs WHERE id = ?").get(row.id);
    expect(raw?.applied).toBe(1);
    const [read] = store.organizerRunsForTask("plan-1");
    expect(read).toEqual(row);
  });

  test("a plan's runs come back newest first, whether they started against it or a resume/join only named it", () => {
    const store = open();
    const startedAgainstIt = store.recordOrganizerRun(baseInput({ taskId: "plan-1" }));
    const landedOnItInstead = store.recordOrganizerRun(
      baseInput({ taskId: null, decision: "resume", applied: true, appliedTaskId: "plan-1", candidatesApply: { decision: "resume", resume_plan_id: "plan-1", join_plan_id: null, ticket_ids: [], message_ticket: null, check_ids: [] } }),
    );
    // Named as the resume target but refused before it landed anywhere: no task_id, no applied_task_id — only
    // the parsed answer's own candidates_apply still says which plan this run was about.
    const namedButRejected = store.recordOrganizerRun(
      baseInput({ taskId: null, decision: "resume", applied: false, rejectReason: "a line asking to stop would have reopened parked plan plan-1", candidatesApply: { decision: "resume", resume_plan_id: "plan-1", join_plan_id: null, ticket_ids: [], message_ticket: null, check_ids: [] } }),
    );
    store.recordOrganizerRun(baseInput({ taskId: "some-other-plan" }));
    const runs = store.organizerRunsForTask("plan-1");
    expect(runs.map((run) => run.id)).toEqual([namedButRejected.id, landedOnItInstead.id, startedAgainstIt.id]);
  });

  test("the debug limit bounds how many rows come back, newest kept", () => {
    const store = open();
    const rows = Array.from({ length: 5 }, () => store.recordOrganizerRun(baseInput({ taskId: "plan-1" })));
    const runs = store.organizerRunsForTask("plan-1", 2);
    expect(runs.map((run) => run.id)).toEqual([rows[4]!.id, rows[3]!.id]);
  });

  test("a decision the parser downgraded keeps the named target and a reason, and the target's own query finds it", () => {
    const store = open();
    // The payload offered plan-9 as a job the Bots here were on elsewhere; by the time the call
    // came back it no longer qualified, so the parser fell back to continue on a different plan.
    const row = store.recordOrganizerRun(
      baseInput({
        taskId: "plan-5",
        decision: "continue",
        candidatesPayload: { recent_plan_ids: [], elsewhere_plan_ids: ["plan-9"], existing_check_ids: [] },
        candidatesApply: { decision: "join", resume_plan_id: null, join_plan_id: "plan-9", ticket_ids: [], message_ticket: null, check_ids: [] },
        candidatesAtParse: { recent_plan_ids: [], elsewhere_plan_ids: [], existing_check_ids: [] },
        downgradeReason: "named join target plan-9 is not (or no longer) a job the Bots here are on elsewhere; decision fell back to continue",
        applied: true,
        appliedTaskId: "plan-5",
      }),
    );
    expect(row.decision).toBe("continue");
    expect(row.candidates_apply).toMatchObject({ decision: "join", join_plan_id: "plan-9" });
    expect(row.candidates_payload.elsewhere_plan_ids).toEqual(["plan-9"]);
    expect(row.candidates_at_parse?.elsewhere_plan_ids).toEqual([]);
    expect(row.downgrade_reason).toContain("plan-9");
    // Neither task_id nor applied_task_id names plan-9 — only the raw candidates_apply does.
    const [found] = store.organizerRunsForTask("plan-9");
    expect(found?.id).toBe(row.id);
  });

  test("rows past the per-session cap are pruned on write, newest kept", () => {
    const store = open();
    const base = Date.now();
    const total = ORGANIZER_RUNS_KEPT_PER_SESSION + 3;
    const rows = Array.from({ length: total }, (_, i) => store.recordOrganizerRun(baseInput({ sessionId: "session-cap", now: new Date(base + i) })));
    const remaining = store.db.query<{ id: string }, [string]>("SELECT id FROM organizer_runs WHERE session_id = ?").all("session-cap");
    expect(remaining).toHaveLength(ORGANIZER_RUNS_KEPT_PER_SESSION);
    const remainingIds = new Set(remaining.map((row) => row.id));
    for (const row of rows.slice(3)) expect(remainingIds.has(row.id)).toBe(true);
    for (const row of rows.slice(0, 3)) expect(remainingIds.has(row.id)).toBe(false);
    // A different session's rows are untouched by another session's cap.
    store.recordOrganizerRun(baseInput({ sessionId: "session-other" }));
    expect(store.db.query<{ id: string }, [string]>("SELECT id FROM organizer_runs WHERE session_id = ?").all("session-other")).toHaveLength(1);
  });

  test("pruning stays on the session index: no table scan and no sort, however long the history", () => {
    const store = open();
    const plan = (sql: string, params: Array<string | number>) =>
      store.db
        .query<{ detail: string }, Array<string | number>>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => row.detail);
    const edge = plan(ORGANIZER_RUNS_PRUNE_EDGE_SQL, ["session-1", ORGANIZER_RUNS_KEPT_PER_SESSION]);
    const prune = plan(ORGANIZER_RUNS_PRUNE_SQL, ["session-1", "2026-01-01T00:00:00.000Z", "x"]);
    for (const steps of [edge, prune]) {
      expect(steps.some((step) => step.includes("organizer_runs_session"))).toBe(true);
      expect(steps.some((step) => /TEMP B-TREE|^SCAN /.test(step))).toBe(false);
    }
    // The delete's range reaches past the session's equality into (created_at, id), not just session_id.
    expect(prune.some((step) => /created_at.*[<>]/.test(step))).toBe(true);
  });

  test("clearing a session's history, or deleting a group, removes its organizer runs too — unlike spend, they are not a ledger kept on purpose", () => {
    const store = open();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reader = store.createBot({ name: "Reader", duties: "read", boundaries: "stay" });
    const group = store.createGroup({ name: "组", members: [writer.bot.id, reader.bot.id] });
    const direct = writer.direct_session.id;
    const count = (sessionId: string) =>
      (store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM organizer_runs WHERE session_id = ?").get(sessionId) ?? { n: 0 }).n;
    store.recordOrganizerRun(baseInput({ sessionId: direct }));
    store.recordOrganizerRun(baseInput({ sessionId: group.id }));

    store.clearSessionMessages(direct);
    expect(count(direct)).toBe(0);

    store.deleteSession(group.id);
    expect(count(group.id)).toBe(0);
  });
});
