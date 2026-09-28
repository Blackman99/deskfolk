import { describe, expect, test } from "bun:test";
import type { Interventions } from "./interventions";
import { aggregate, formatDuration, formatSummary, isCompleted, type RunResult, type SummaryMeta } from "./report";

function interventions(overrides: Partial<Interventions> = {}): Interventions {
  const base = { approvals: 0, asks: 0, stalls: 0, ...overrides };
  return {
    approval_kinds: {},
    plan_nudges: 0,
    turn_failures: 0,
    interrupted: 0,
    ...base,
    total: base.approvals + base.asks + base.stalls,
  };
}

function run(overrides: Partial<RunResult> = {}): RunResult {
  const result: RunResult = {
    task: "research",
    title: "调研",
    setup: "manual",
    run: 1,
    outcome: "settled",
    outcome_detail: null,
    completed: false,
    wall_ms: 120_000,
    team_ms: null,
    team: { group_id: "g", group_name: "渠道调研", bots: ["Researcher", "Writer"], speakers: { Researcher: 2 } },
    plan: { id: "p", title: "分发渠道", dir: "work/分发渠道-ab12", status: "active", tickets: [{ seq: 1, title: "初稿", status: "review", worker: "Writer" }] },
    coverage: { requirements: [{ text: "交到 report.md", status: "covered", evidence: "report.md | 第一段" }], summary: "做完了" },
    score: 1,
    judge_error: null,
    checks: [{ name: "report.md delivered", ok: true, detail: "10 bytes" }],
    checks_ok: true,
    interventions: interventions(),
    stats: { turns: 3, hops: 9, tool_calls: 6, tool_errors: 0, messages: 5, spend_rows: 12, input_tokens: 1000, output_tokens: 200, cost_usd: null, judge_input_tokens: 10, judge_output_tokens: 5 },
    files: { cited: ["report.md"], written: ["report.md"] },
    pending_check_backs: 0,
    run_dir: "runs/research--manual--1",
    key_leak: false,
    ...overrides,
  };
  return { ...result, completed: overrides.completed ?? isCompleted(result, 0.8) };
}

const META: SummaryMeta = {
  model: "team-model",
  judge_model: "judge-model",
  base_url: "http://127.0.0.1:17947/v1",
  started_at: "2026-09-28T07:00:00.000Z",
  finished_at: "2026-09-28T07:40:00.000Z",
  timeout_min: 30,
  approvals: "deny",
  min_pass: 0.8,
  commit: "abc1234",
  tasks_file: "apps/daemon/eval/golden-path/tasks.json",
};

describe("completion", () => {
  test("needs a settled job, a score at the mark and every check passing", () => {
    expect(isCompleted({ outcome: "settled", score: 0.8, checks_ok: true }, 0.8)).toBe(true);
    expect(isCompleted({ outcome: "settled", score: 0.79, checks_ok: true }, 0.8)).toBe(false);
    expect(isCompleted({ outcome: "settled", score: 1, checks_ok: false }, 0.8)).toBe(false);
    expect(isCompleted({ outcome: "settled", score: null, checks_ok: true }, 0.8)).toBe(false);
    for (const outcome of ["timeout", "blocked_on_user", "setup_failed", "error"] as const) {
      expect(isCompleted({ outcome, score: 1, checks_ok: true }, 0.8)).toBe(false);
    }
  });
});

describe("aggregate", () => {
  test("rates and means by setup and by task; aborted runs count nowhere but in the outcomes", () => {
    const runs = [
      run({ setup: "manual", score: 1 }),
      run({ setup: "manual", run: 2, score: 0.5, interventions: interventions({ asks: 1, stalls: 1 }), wall_ms: 240_000 }),
      run({ setup: "coordinator", task: "small-tool", outcome: "timeout", score: 0.9, interventions: interventions({ approvals: 1 }), team_ms: 30_000 }),
      run({ setup: "coordinator", task: "small-tool", run: 2, outcome: "aborted", score: null }),
    ];
    const agg = aggregate(runs);
    expect(agg.overall).toMatchObject({ runs: 3, completed: 1, rate: 1 / 3, mean_interventions: 1 });
    expect(agg.overall.mean_score).toBeCloseTo(0.8);
    expect(agg.by_setup.manual).toMatchObject({ runs: 2, completed: 1, rate: 0.5, mean_interventions: 1, mean_wall_ms: 180_000 });
    expect(agg.by_setup.coordinator).toMatchObject({ runs: 1, completed: 0, rate: 0 });
    expect(agg.by_task.research).toMatchObject({ runs: 2, completed: 1 });
    expect(agg.outcomes).toMatchObject({ settled: 2, timeout: 1, aborted: 1, error: 0 });
    expect(agg.interventions).toEqual({ approvals: 1, asks: 1, stalls: 1, plan_nudges: 0 });
  });

  test("no runs is a zero rate, not a division by zero", () => {
    expect(aggregate([]).overall).toEqual({ runs: 0, completed: 0, rate: 0, mean_interventions: 0, mean_score: null, mean_wall_ms: 0 });
  });
});

describe("summary", () => {
  test("durations read at a glance", () => {
    expect(formatDuration(42_400)).toBe("42s");
    expect(formatDuration(192_000)).toBe("3m12s");
    expect(formatDuration(3_720_000)).toBe("1h02m");
  });

  test("leads with the rate and the intervention count, then tables and per-run detail", () => {
    const text = formatSummary({
      meta: META,
      aggregate: aggregate([run(), run({ setup: "coordinator", outcome: "setup_failed", score: null, coverage: null, judge_error: "no team, nothing to judge", team_ms: 600_000 })]),
      runs: [run(), run({ setup: "coordinator", outcome: "setup_failed", score: null, coverage: null, judge_error: "no team, nothing to judge", team_ms: 600_000 })],
    });
    expect(text).toStartWith("# 黄金路径基准 — team-model\n");
    expect(text).toContain("**完成 1 / 2（50%）**，平均每次人工介入 0.0 次");
    expect(text).toContain("| manual | 1 / 1 | 100% | 0.0 | 100% | 2m00s |");
    expect(text).toContain("| research | manual | 1 | 静下来 | ✅ | 100% | 1/1 | 0（0/0/0） | 0 | 2m00s | 3 | 9 | 0 | 12 | 1000/200 |");
    expect(text).toContain("| research | coordinator | 1 | 没组成班 | ❌ | — |");
    expect(text).toContain("### research · manual · #1");
    expect(text).toContain("#### 覆盖率 · research · manual · #1");
    // A pipe in a verdict must not break the table.
    expect(text).toContain("report.md \\| 第一段");
    expect(text).toContain("组班 10m00s");
    expect(text).toContain("- 未评判：no team, nothing to judge");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("a plan named after a line with backticks does not open a code span", () => {
    const named = run({ plan: { id: "p", title: "工作区根目录的 `brief.md` 是这次", dir: "work/工作区根目录的-`bri-v3rq", status: "active", tickets: [] } });
    const text = formatSummary({ meta: META, aggregate: aggregate([named]), runs: [named] });
    expect(text).toContain("- 规划：工作区根目录的 \\`brief.md\\` 是这次（active）");
    expect(text).toContain("- 工作目录：`work/工作区根目录的-'bri-v3rq`");
  });
});
