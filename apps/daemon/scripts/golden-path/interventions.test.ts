import { describe, expect, test } from "bun:test";
import { countInterventions, endedStalled, type InterventionRows } from "./interventions";

const NONE: InterventionRows = { approvals: [], asks: [], notifications: [], checkBacks: [], routes: [], turns: [] };

describe("interventions", () => {
  test("a clean run needed nobody", () => {
    expect(countInterventions(NONE)).toEqual({
      total: 0,
      approvals: 0,
      approval_kinds: {},
      asks: 0,
      stalls: 0,
      plan_nudges: 0,
      turn_failures: 0,
      interrupted: 0,
    });
  });

  test("every approval card counts, whatever became of it, and is broken down by kind", () => {
    const counted = countInterventions({
      ...NONE,
      approvals: [
        { status: "denied", kind_key: "outbound-network" },
        { status: "allowed_once", kind_key: "outbound-network" },
        { status: "voided", kind_key: null },
      ],
    });
    expect(counted.approvals).toBe(3);
    expect(counted.approval_kinds).toEqual({ "outbound-network": 2, unknown: 1 });
    expect(counted.total).toBe(3);
  });

  test("questions and stall notices count; other failures, nudges and interruptions are reported but not counted", () => {
    const counted = countInterventions({
      approvals: [],
      asks: [{ id: "a1" }, { id: "a2" }, { id: "a2" }],
      notifications: [
        { kind: "failure", fail_kind: "stalled_plan" },
        { kind: "failure", fail_kind: "refused" },
        { kind: "ask", fail_kind: null },
        { kind: "reply", fail_kind: null },
      ],
      checkBacks: [{ kind: "plan_nudge" }, { kind: null }, { kind: "plan_nudge" }],
      routes: [{ outcome: "failed" }, { outcome: "completed" }, { outcome: null }],
      turns: [{ status: "interrupted" }, { status: "completed" }],
    });
    expect(counted).toMatchObject({ asks: 2, stalls: 1, total: 3, plan_nudges: 2, turn_failures: 1, interrupted: 1 });
  });

  test("a plan ended stalled only when nothing moved after the stall notice", () => {
    expect(endedStalled([], "2026-09-28T10:00:00.000Z")).toBe(false);
    expect(endedStalled(["2026-09-28T10:05:00.000Z"], "2026-09-28T10:00:00.000Z")).toBe(true);
    expect(endedStalled(["2026-09-28T10:05:00.000Z"], "2026-09-28T10:07:00.000Z")).toBe(false);
    expect(endedStalled(["2026-09-28T10:05:00.000Z", "2026-09-28T10:09:00.000Z"], "2026-09-28T10:07:00.000Z")).toBe(true);
    expect(endedStalled(["2026-09-28T10:05:00.000Z"], null)).toBe(true);
  });
});
