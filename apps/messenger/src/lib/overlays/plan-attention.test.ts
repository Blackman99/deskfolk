import { expect, test } from "bun:test";
import type { AcceptanceCheck, PlanRequirement, TaskDetail } from "@real-bot/protocol";
import { attentionCount, planAttention } from "./plan-attention.ts";

function aCheck(over: Partial<AcceptanceCheck>): AcceptanceCheck {
  return {
    id: "check", task_id: "task-1", ticket_id: null, item: "有对比表", kind: "exists", path: "report.md", pattern: null, negate: false,
    command: null, cwd: null, expect_exit: null, expect_stdout: null, timeout_sec: null, source: "user",
    created_at: "2026-09-24T08:00:00.000Z", updated_at: "2026-09-24T08:00:00.000Z", defined_at: "2026-09-24T08:00:00.000Z",
    first_passed_at: null, last_run: null, running: false, ...over,
  };
}

function failed(id: string, ticket: string | null): AcceptanceCheck {
  return aCheck({
    id, ticket_id: ticket,
    last_run: { id: `run-${id}`, check_id: id, task_id: "task-1", cause: "settle", started_at: "2026-09-24T08:00:00.000Z", finished_at: "2026-09-24T08:00:01.000Z", outcome: "fail", exit_code: 1, detail: "没找到", output: null },
  });
}

function plan(over: Partial<TaskDetail>): Pick<TaskDetail, "checks" | "requirements" | "spec" | "tickets"> {
  return { checks: [], requirements: [], spec: null, tickets: [], ...over };
}

test("a quiet plan needs nothing of you", () => {
  const quiet = planAttention(plan({}));
  expect(quiet.needsYou).toBe(false);
  expect(attentionCount(quiet)).toBe(0);
});

test("failed checks come worst first, by their ticket's number; blocked progress and waiting requirements count too", () => {
  const tickets = [{ id: "tk-1", seq: 1 }, { id: "tk-2", seq: 2 }] as TaskDetail["tickets"];
  const attention = planAttention(plan({
    tickets,
    checks: [failed("late", "tk-2"), failed("early", "tk-1"), aCheck({ id: "never" })],
    spec: { kind: "调研", goal: "比出高下", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: ["缺素材"] }, status: "active" },
    requirements: [
      { id: "r1", status: "proposed", excluded: false } as PlanRequirement,
      { id: "r2", status: "open", excluded: false } as PlanRequirement,
      { id: "r3", status: "unverified", excluded: true } as PlanRequirement,
    ],
  }));
  expect(attention.failing.map((check) => check.id)).toEqual(["early", "late"]);
  expect(attention.blocked).toBe(1);
  expect(attention.waitingRequirements).toBe(1);
  expect(attention.needsYou).toBe(true);
  expect(attentionCount(attention)).toBe(4);
});
