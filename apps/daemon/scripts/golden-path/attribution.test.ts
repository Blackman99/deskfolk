import { describe, expect, test } from "bun:test";
import { scoreAttribution } from "./attribution";

describe("scoreAttribution", () => {
  test("expect_plan kickoff, filed on the kickoff plan: a hit", () => {
    const result = scoreAttribution([{ step_id: "s1", expect_plan: "kickoff", actual_task_id: "P1", kickoff_task_id: "P1", actual_bots: ["Reviewer"] }]);
    expect(result).toEqual({
      total: 1,
      hits: 1,
      rows: [{ step_id: "s1", expect_plan: "kickoff", actual_task_id: "P1", kickoff_task_id: "P1", actual_bots: ["Reviewer"], hit: true }],
    });
  });

  test("expect_plan kickoff, but it landed on a different plan: a miss", () => {
    const result = scoreAttribution([{ step_id: "s1", expect_plan: "kickoff", actual_task_id: "P2", kickoff_task_id: "P1", actual_bots: [] }]);
    expect(result.rows[0]!.hit).toBe(false);
  });

  test("expect_plan new, and it did land on a different plan: a hit", () => {
    const result = scoreAttribution([{ step_id: "s1", expect_plan: "new", actual_task_id: "P2", kickoff_task_id: "P1", actual_bots: [] }]);
    expect(result.rows[0]!.hit).toBe(true);
  });

  test("expect_plan new, but it landed back on the kickoff plan: a miss", () => {
    const result = scoreAttribution([{ step_id: "s1", expect_plan: "new", actual_task_id: "P1", kickoff_task_id: "P1", actual_bots: [] }]);
    expect(result.rows[0]!.hit).toBe(false);
  });

  test("never filed to any plan (actual_task_id null) is a miss either way, not an error", () => {
    const kickoff = scoreAttribution([{ step_id: "s1", expect_plan: "kickoff", actual_task_id: null, kickoff_task_id: "P1", actual_bots: [] }]);
    expect(kickoff.rows[0]!.hit).toBe(false);
    const fresh = scoreAttribution([{ step_id: "s2", expect_plan: "new", actual_task_id: null, kickoff_task_id: "P1", actual_bots: [] }]);
    expect(fresh.rows[0]!.hit).toBe(false);
  });

  test("actual_bots rides along on the row but never decides the hit", () => {
    const result = scoreAttribution([{ step_id: "s1", expect_plan: "kickoff", actual_task_id: "P1", kickoff_task_id: "P1", actual_bots: [] }]);
    expect(result.rows[0]!.hit).toBe(true);
  });

  test("totals over several rows", () => {
    const result = scoreAttribution([
      { step_id: "s1", expect_plan: "kickoff", actual_task_id: "P1", kickoff_task_id: "P1", actual_bots: [] },
      { step_id: "s2", expect_plan: "new", actual_task_id: "P1", kickoff_task_id: "P1", actual_bots: [] },
      { step_id: "s3", expect_plan: "new", actual_task_id: "P3", kickoff_task_id: "P1", actual_bots: [] },
    ]);
    expect(result.total).toBe(3);
    expect(result.hits).toBe(2);
  });

  test("no rows: total and hits are both 0", () => {
    expect(scoreAttribution([])).toEqual({ total: 0, hits: 0, rows: [] });
  });
});
