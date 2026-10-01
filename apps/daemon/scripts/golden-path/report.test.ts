import { describe, expect, test } from "bun:test";
import type { Interventions } from "./interventions";
import {
  ablationLeaks,
  aggregate,
  classifyFailure,
  failureDetail,
  formatDuration,
  formatSummary,
  isCompleted,
  productChecksOf,
  scriptOf,
  spendBucket,
  type RunOutcome,
  type RunResult,
  type SpendBucketStats,
  type SummaryMeta,
} from "./report";

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
    team: { group_id: "g", group_name: "渠道调研", bots: ["Researcher", "Writer"], speakers: { Researcher: 2 }, session_kind: "group" },
    plan: { id: "p", title: "分发渠道", dir: "work/分发渠道-ab12", status: "active", tickets: [{ seq: 1, title: "初稿", status: "review", worker: "Writer" }] },
    coverage: { requirements: [{ text: "交到 report.md", status: "covered", evidence: "report.md | 第一段" }], summary: "做完了" },
    score: 1,
    judge_error: null,
    checks: [{ name: "report.md delivered", ok: true, detail: "10 bytes", kind: "deliverable" }],
    checks_ok: true,
    interventions: interventions(),
    stats: {
      turns: 3,
      hops: 9,
      tool_calls: 6,
      tool_errors: 0,
      messages: 5,
      spend_rows: 12,
      input_tokens: 1000,
      output_tokens: 200,
      cost_usd: null,
      judge_input_tokens: 10,
      judge_output_tokens: 5,
      spend_by_kind: {},
      thinking_levels: {},
    },
    files: { cited: ["report.md"], written: ["report.md"] },
    pending_check_backs: 0,
    run_dir: "runs/research--manual--1",
    key_leak: false,
    ended_stalled: false,
    ablation: "none",
    ablated: [],
    ablation_leaks: [],
    attribution: null,
    script: { fired: [], skipped: [], unfired: [] },
    failure: null,
    failure_detail: null,
    ...overrides,
  };
  result.completed = overrides.completed ?? isCompleted(result, 0.8);
  result.failure = overrides.failure ?? classifyFailure(result, 0.8);
  result.failure_detail = overrides.failure_detail ?? failureDetail(result, result.failure);
  return result;
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

describe("spendBucket", () => {
  test("a turn call with no thinking level is the closing check; everything else keeps its kind", () => {
    expect(spendBucket("turn", "medium")).toBe("turn");
    expect(spendBucket("turn", null)).toBe("closing_check");
    expect(spendBucket("judgement", null)).toBe("judgement");
    expect(spendBucket("route_pick", "low")).toBe("route_pick");
    expect(spendBucket("organize", null)).toBe("organize");
    // The scribe bills as the organizer's kind with a purpose of its own, and is counted apart.
    expect(spendBucket("organize", null, "scribe")).toBe("scribe");
  });
});

describe("classifyFailure", () => {
  test("one case per kind, FAILURE_KINDS precedence order", () => {
    expect(classifyFailure(run(), 0.8)).toBeNull();
    expect(classifyFailure(run({ outcome: "aborted" }), 0.8)).toBe("aborted");
    expect(classifyFailure(run({ outcome: "setup_failed" }), 0.8)).toBe("setup_failed");
    expect(classifyFailure(run({ outcome: "error" }), 0.8)).toBe("error");
    expect(classifyFailure(run({ outcome: "timeout" }), 0.8)).toBe("timeout");
    expect(classifyFailure(run({ outcome: "blocked_on_user", ended_stalled: true }), 0.8)).toBe("stalled");
    expect(classifyFailure(run({ outcome: "blocked_on_user", ended_stalled: false }), 0.8)).toBe("blocked_on_user");
    expect(
      classifyFailure(run({ checks: [{ name: "report.md delivered", ok: false, detail: "missing", kind: "deliverable" }], checks_ok: false }), 0.8),
    ).toBe("no_delivery");
    expect(
      classifyFailure(run({ checks: [{ name: "report.md content", ok: false, detail: "x", kind: "content" }], checks_ok: false }), 0.8),
    ).toBe("checks_failed");
    expect(classifyFailure(run({ score: null }), 0.8)).toBe("not_judged");
    expect(classifyFailure(run({ score: 0.5 }), 0.8)).toBe("coverage_below");
  });

  test("failureDetail names the failed check(s) or the coverage score", () => {
    const noDelivery = run({ checks: [{ name: "report.md delivered", ok: false, detail: "missing", kind: "deliverable" }], checks_ok: false });
    expect(failureDetail(noDelivery, "no_delivery")).toContain("report.md delivered");
    const below = run({ score: 0.42 });
    expect(failureDetail(below, "coverage_below")).toBe("coverage 42%");
    expect(failureDetail(run(), null)).toBeNull();
  });

  test("null exactly when isCompleted is true, over many synthetic runs", () => {
    const outcomes: RunOutcome[] = ["settled", "blocked_on_user", "timeout", "setup_failed", "error", "aborted"];
    const scores = [null, 0, 0.5, 0.79, 0.8, 1];
    const checksOptions: RunResult["checks"][] = [
      [],
      [{ name: "a", ok: true, detail: "ok", kind: "deliverable" }],
      [{ name: "a", ok: false, detail: "missing", kind: "deliverable" }],
      [{ name: "a", ok: false, detail: "bad", kind: "content" }],
    ];
    let cases = 0;
    for (const outcome of outcomes) {
      for (const score of scores) {
        for (const checks of checksOptions) {
          for (const ended_stalled of [true, false]) {
            const checks_ok = checks.every((c) => c.ok);
            const candidate = run({ outcome, score, checks, checks_ok, ended_stalled });
            expect(candidate.failure === null).toBe(candidate.completed);
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(100);
  });
});

describe("ablationLeaks", () => {
  const rows = (n: number): SpendBucketStats => ({ rows: n, input_tokens: 0, output_tokens: 0, cost_usd: null });

  test("only warns when a switched-off call still produced rows", () => {
    expect(ablationLeaks([], { route_pick: rows(3) })).toEqual([]);
    expect(ablationLeaks(["route-pick"], { route_pick: rows(0) })).toEqual([]);
    expect(ablationLeaks(["route-pick"], { route_pick: rows(2) })[0]).toContain("route-pick");
    // organize needs both halves off before an `organize` row counts as a leak.
    expect(ablationLeaks(["organize-message"], { organize: rows(1) })).toEqual([]);
    expect(ablationLeaks(["organize-message", "organize-settle"], { organize: rows(1) })[0]).toContain("organize-message");
    expect(ablationLeaks(["closing-check"], { closing_check: rows(1) })[0]).toContain("closing-check");
    expect(ablationLeaks(["review"], { route_review: rows(1) })[0]).toContain("review");
    expect(ablationLeaks(["learning"], { route_learn: rows(1) })[0]).toContain("learning");
    expect(ablationLeaks(["judgement"], { judgement: rows(1) })[0]).toContain("judgement");
  });
});

describe("productChecksOf", () => {
  test("reads the run's own product_checks; a run written before the field existed reads as all zero", () => {
    const withChecks = run({ stats: { ...run().stats, product_checks: { total: 3, pass: 1, fail: 1, blocked: 0, error: 1, organizer: 2, user: 1 } } });
    expect(productChecksOf(withChecks)).toEqual({ total: 3, pass: 1, fail: 1, blocked: 0, error: 1, organizer: 2, user: 1 });
    expect(productChecksOf(run())).toEqual({ total: 0, pass: 0, fail: 0, blocked: 0, error: 0, organizer: 0, user: 0 });
  });
});

describe("scriptOf", () => {
  test("reads the run's own script stats; a run written before the field existed reads as all empty", () => {
    const withScript = run({ script: { fired: ["a"], skipped: ["b"], unfired: ["c"] } });
    expect(scriptOf(withScript)).toEqual({ fired: ["a"], skipped: ["b"], unfired: ["c"] });
    expect(scriptOf(run())).toEqual({ fired: [], skipped: [], unfired: [] });
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
    expect(aggregate([]).overall).toEqual({
      runs: 0,
      completed: 0,
      rate: 0,
      mean_interventions: 0,
      mean_score: null,
      mean_wall_ms: 0,
      mean_cost_usd: null,
      mean_tokens: { input: 0, output: 0 },
      failures: {},
    });
  });

  test("by_ablation and by_cell group runs by ablation label (and setup · ablation); failures tally per bucket", () => {
    const runs = [
      run({ setup: "manual", score: 1 }),
      run({ setup: "manual", ablation: "bare", ablated: ["organize-message"], outcome: "timeout", score: null }),
      run({ setup: "solo", ablation: "bare", ablated: ["organize-message"], outcome: "blocked_on_user", ended_stalled: true, score: null }),
    ];
    const agg = aggregate(runs);
    expect(agg.by_ablation.none).toMatchObject({ runs: 1, completed: 1 });
    expect(agg.by_ablation.bare).toMatchObject({ runs: 2, completed: 0 });
    expect(agg.by_ablation.bare!.failures).toEqual({ timeout: 1, stalled: 1 });
    expect(agg.by_cell["manual · bare"]).toMatchObject({ runs: 1 });
    expect(agg.by_cell["solo · bare"]).toMatchObject({ runs: 1 });
  });

  test("spend_by_kind sums stats.spend_by_kind across runs", () => {
    const a = run({ stats: { ...run().stats, spend_by_kind: { turn: { rows: 2, input_tokens: 100, output_tokens: 10, cost_usd: 0.01 } } } });
    const b = run({ run: 2, stats: { ...run().stats, spend_by_kind: { turn: { rows: 1, input_tokens: 50, output_tokens: 5, cost_usd: null } } } });
    const agg = aggregate([a, b]);
    expect(agg.spend_by_kind.turn).toEqual({ rows: 3, input_tokens: 150, output_tokens: 15, cost_usd: 0.01 });
  });
});

describe("summary", () => {
  test("durations read at a glance", () => {
    expect(formatDuration(42_400)).toBe("42s");
    expect(formatDuration(192_000)).toBe("3m12s");
    expect(formatDuration(3_720_000)).toBe("1h02m");
  });

  test("leads with the rate and the intervention count, then tables and per-run detail (with 消融/失败 columns)", () => {
    const failed = run({ setup: "coordinator", outcome: "setup_failed", score: null, coverage: null, judge_error: "no team, nothing to judge", team_ms: 600_000 });
    const text = formatSummary({
      meta: META,
      aggregate: aggregate([run(), failed]),
      runs: [run(), failed],
    });
    expect(text).toStartWith("# 黄金路径基准 — team-model\n");
    expect(text).toContain("- 组班：manual、coordinator");
    expect(text).toContain("**完成 1 / 2（50%）**，平均每次人工介入 0.0 次");
    expect(text).toContain("| manual | 1 / 1 | 100% | 0.0 | 100% | 2m00s | — |");
    expect(text).toContain("| 任务 | 组班 | 消融 | # | 结局 | 失败 |");
    expect(text).toContain("| research | manual | none | 1 | 静下来 | — | ✅ | 100% |");
    expect(text).toContain("| research | coordinator | none | 1 | 没组成班 | 没组成班 | ❌ | — |");
    expect(text).toContain("### research · manual · #1");
    expect(text).toContain("#### 覆盖率 · research · manual · #1");
    // A pipe in a verdict must not break the table.
    expect(text).toContain("report.md \\| 第一段");
    expect(text).toContain("组班 10m00s");
    expect(text).toContain("- 未评判：no team, nothing to judge");
    expect(text).toContain("### 花费构成");
    expect(text).not.toContain("## 消融");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("more than one ablation condition gets its own 消融 table", () => {
    const runs = [run(), run({ ablation: "bare", ablated: ["organize-message"] })];
    const text = formatSummary({ meta: META, aggregate: aggregate(runs), runs });
    expect(text).toContain("消融 | 完成");
  });

  test("a plan named after a line with backticks does not open a code span", () => {
    const named = run({ plan: { id: "p", title: "工作区根目录的 `brief.md` 是这次", dir: "work/工作区根目录的-`bri-v3rq", status: "active", tickets: [] } });
    const text = formatSummary({ meta: META, aggregate: aggregate([named]), runs: [named] });
    expect(text).toContain("- 规划：工作区根目录的 \\`brief.md\\` 是这次（active）");
    expect(text).toContain("- 工作目录：`work/工作区根目录的-'bri-v3rq`");
  });

  test("a solo run prints 私聊 instead of the group line; hiring an extra Bot anyway warns", () => {
    const solo = run({ setup: "solo", team: { group_id: "d1", group_name: null, bots: ["Analyst"], speakers: {}, session_kind: "direct" } });
    const text = formatSummary({ meta: META, aggregate: aggregate([solo]), runs: [solo] });
    expect(text).toContain("- 私聊：Analyst");
    expect(text).not.toContain("- 群：");

    const hired = run({ setup: "solo", team: { group_id: "d1", group_name: null, bots: ["Analyst", "Helper"], speakers: {}, session_kind: "direct" } });
    const text2 = formatSummary({ meta: META, aggregate: aggregate([hired]), runs: [hired] });
    expect(text2).toContain("⚠️ 单干时另建了 Bot（Analyst、Helper）");
  });

  test("a non-empty ablation_leaks warns in the run's detail", () => {
    const leaked = run({ ablation: "bare", ablated: ["route-pick"], ablation_leaks: ["route-pick 关了，但仍有 2 行 route_pick 花费"] });
    const text = formatSummary({ meta: META, aggregate: aggregate([leaked]), runs: [leaked] });
    expect(text).toContain("⚠️ 消融没生效：route-pick 关了，但仍有 2 行 route_pick 花费");
  });

  test("a script that did not fire everything warns with the step ids; a fully-fired script says nothing", () => {
    const truncated = run({ script: { fired: ["a"], skipped: ["b"], unfired: ["c", "d"] } });
    const text = formatSummary({ meta: META, aggregate: aggregate([truncated]), runs: [truncated] });
    expect(text).toContain("⚠️ 脚本没发全：已发 1；跳过 1（b）；没发出 2（c、d）");

    const complete = run({ script: { fired: ["a", "b"], skipped: [], unfired: [] } });
    const text2 = formatSummary({ meta: META, aggregate: aggregate([complete]), runs: [complete] });
    expect(text2).not.toContain("脚本没发全");
  });

  test("old-shape run objects (missing every field this file added) do not crash aggregate or formatSummary", () => {
    const old = JSON.parse(JSON.stringify(run())) as Record<string, unknown>;
    for (const key of ["ablation", "ablated", "ablation_leaks", "failure", "failure_detail", "ended_stalled", "script"]) delete old[key];
    delete (old.team as Record<string, unknown>).session_kind;
    delete (old.stats as Record<string, unknown>).spend_by_kind;
    delete (old.stats as Record<string, unknown>).thinking_levels;
    const oldRun = old as unknown as RunResult;
    expect(() => aggregate([oldRun])).not.toThrow();
    expect(() => formatSummary({ meta: META, aggregate: aggregate([oldRun]), runs: [oldRun] })).not.toThrow();
  });
});
