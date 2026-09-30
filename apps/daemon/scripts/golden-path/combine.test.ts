import { describe, expect, test } from "bun:test";
import type { Interventions } from "./interventions";
import { combine, formatComparison, readResults, wilson, type ResultsFile } from "./combine";
import { classifyFailure, failureDetail, isCompleted, type RunResult } from "./report";

function interventions(overrides: Partial<Interventions> = {}): Interventions {
  const base = { approvals: 0, asks: 0, stalls: 0, ...overrides };
  return { approval_kinds: {}, plan_nudges: 0, turn_failures: 0, interrupted: 0, ...base, total: base.approvals + base.asks + base.stalls };
}

function run(overrides: Partial<RunResult> = {}): RunResult {
  const task = overrides.task ?? "research";
  const setup = overrides.setup ?? "manual";
  const ablation = overrides.ablation ?? "none";
  const index = overrides.run ?? 1;
  const defaultRunDir = `runs/${task}--${setup}${ablation === "none" ? "" : `--${ablation}`}--${index}`;
  const result: RunResult = {
    task,
    title: "调研",
    setup,
    run: index,
    outcome: "settled",
    outcome_detail: null,
    completed: false,
    wall_ms: 120_000,
    team_ms: null,
    team: { group_id: "g", group_name: "渠道调研", bots: ["Researcher", "Writer"], speakers: {}, session_kind: "group" },
    plan: null,
    coverage: null,
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
      spend_rows: 2,
      input_tokens: 1000,
      output_tokens: 200,
      cost_usd: 0.01,
      judge_input_tokens: 10,
      judge_output_tokens: 5,
      spend_by_kind: { turn: { rows: 2, input_tokens: 1000, output_tokens: 200, cost_usd: 0.01 } },
      thinking_levels: {},
    },
    files: { cited: [], written: ["report.md"] },
    pending_check_backs: 0,
    run_dir: defaultRunDir,
    key_leak: false,
    ended_stalled: false,
    ablation,
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

function resultsFile(runs: RunResult[], metaOverrides: Partial<ResultsFile["meta"]> = {}): ResultsFile {
  return {
    meta: {
      model: "model-a",
      judge_model: "judge-model",
      base_url: "http://127.0.0.1:17947/v1",
      min_pass: 0.8,
      timeout_min: 30,
      approvals: "deny",
      tasks_file: "apps/daemon/eval/golden-path/tasks.json",
      commit: "abc1234",
      ...metaOverrides,
    },
    runs,
  };
}

describe("wilson", () => {
  test("0/3 and 3/3 land at the edges, everything stays inside [0, 1]", () => {
    const zero = wilson(0, 3);
    expect(zero.low).toBeCloseTo(0, 5);
    expect(zero.high).toBeGreaterThan(0);
    expect(zero.high).toBeLessThanOrEqual(1);

    const three = wilson(3, 3);
    expect(three.high).toBeCloseTo(1, 5);
    expect(three.low).toBeLessThan(1);
    expect(three.low).toBeGreaterThanOrEqual(0);

    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });

  test("a coin-flip rate has a symmetric-ish interval around 0.5", () => {
    const half = wilson(5, 10);
    expect(half.low).toBeGreaterThan(0.2);
    expect(half.high).toBeLessThan(0.8);
    expect(half.low).toBeLessThan(0.5);
    expect(half.high).toBeGreaterThan(0.5);
  });
});

describe("readResults", () => {
  test("a current-shape file reads through unchanged", () => {
    const data = readResults(resultsFile([run()]), "a/results.json");
    expect(data.meta.model).toBe("model-a");
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0]!.ablation).toBe("none");
  });

  test("an old file (no ablation/ablated/failure/session_kind) still reads, with defaults filled", () => {
    const old = JSON.parse(JSON.stringify(resultsFile([run({ outcome: "timeout", score: null })]))) as Record<string, unknown>;
    const rawRun = (old.runs as Record<string, unknown>[])[0]!;
    delete rawRun.ablation;
    delete rawRun.ablated;
    delete rawRun.ablation_leaks;
    delete rawRun.failure;
    delete rawRun.failure_detail;
    delete rawRun.ended_stalled;
    delete (rawRun.team as Record<string, unknown>).session_kind;
    delete (rawRun.stats as Record<string, unknown>).spend_by_kind;
    delete (rawRun.stats as Record<string, unknown>).thinking_levels;

    const data = readResults(old, "old/results.json");
    expect(data.runs[0]!.ablation).toBe("none");
    expect(data.runs[0]!.ablated).toEqual([]);
    expect(data.runs[0]!.team.session_kind).toBeNull();
    expect(data.runs[0]!.stats.spend_by_kind).toEqual({});
    // outcome was "timeout": classifyFailure derives it since the file carried no `failure`.
    expect(data.runs[0]!.failure).toBe("timeout");
  });

  test("rejects something that is not a results.json", () => {
    expect(() => readResults({ not: "this" }, "bad.json")).toThrow("missing meta.model");
    expect(() => readResults(null, "bad.json")).toThrow();
    expect(() => readResults({ meta: { model: "m" } }, "bad.json")).toThrow("missing runs");
  });
});

describe("combine", () => {
  test("two files with different ablations produce rows with a Δ against the none baseline", () => {
    const baseline = resultsFile([run({ score: 1 }), run({ run: 2, score: 1 })], { model: "model-a" });
    const ablated = resultsFile(
      [
        run({ ablation: "bare", ablated: ["organize-message"], outcome: "timeout", score: null, stats: { ...run().stats, cost_usd: 0.02 } }),
        run({ run: 2, ablation: "bare", ablated: ["organize-message"], score: 1, stats: { ...run().stats, cost_usd: 0.02 } }),
      ],
      { model: "model-a" },
    );
    const result = combine([
      { path: "/out/baseline/results.json", data: baseline },
      { path: "/out/ablated/results.json", data: ablated },
    ]);
    expect(result.warnings).toEqual([]);
    const noneRow = result.rows.find((row) => row.ablation === "none")!;
    const bareRow = result.rows.find((row) => row.ablation === "bare")!;
    expect(noneRow.rate).toBe(1);
    expect(bareRow.rate).toBe(0.5);
    expect(bareRow.delta_rate).toBeCloseTo(-0.5);
    expect(bareRow.delta_cost_usd).not.toBeNull();
    expect(noneRow.delta_rate).toBeNull();
  });

  test("--by-task splits rows by task; without it, tasks are merged under task: null", () => {
    const data = resultsFile([run({ task: "research" }), run({ run: 2, task: "small-tool" })]);
    const merged = combine([{ path: "/out/results.json", data }]);
    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0]!.runs).toBe(2);

    const byTask = combine([{ path: "/out/results.json", data }], { byTask: true });
    expect(byTask.rows).toHaveLength(2);
    expect(byTask.rows.map((row) => row.task).sort()).toEqual(["research", "small-tool"]);
  });

  test("--min-pass re-derives completion and failure instead of trusting the file's own", () => {
    const data = resultsFile([run({ score: 0.7 })]); // completed under 0.8, not under 0.6
    const strict = combine([{ path: "/out/results.json", data }], { minPass: 0.8 });
    const loose = combine([{ path: "/out/results.json", data }], { minPass: 0.6 });
    expect(strict.rows[0]!.completed).toBe(0);
    expect(loose.rows[0]!.completed).toBe(1);
  });

  test("de-dupes the same run_dir under the same results directory, from either a dir or its results.json", () => {
    const data = resultsFile([run()]);
    const result = combine([
      { path: "/out/a/results.json", data },
      { path: "/out/a", data }, // the same folder, given the other way
    ]);
    expect(result.rows[0]!.runs).toBe(1);
  });

  test("warns when meta fields differ across files", () => {
    const a = resultsFile([run()], { judge_model: "judge-1" });
    const b = resultsFile([run({ run: 2 })], { judge_model: "judge-2" });
    const result = combine([
      { path: "/out/a/results.json", data: a },
      { path: "/out/b/results.json", data: b },
    ]);
    expect(result.warnings.some((w) => w.includes("judge_model"))).toBe(true);
  });

  test("an old file without ablation/failure still combines", () => {
    const old = JSON.parse(JSON.stringify(resultsFile([run({ outcome: "error", score: null })]))) as Record<string, unknown>;
    delete (old.runs as Record<string, unknown>[])[0]!.ablation;
    delete (old.runs as Record<string, unknown>[])[0]!.failure;
    const data = readResults(old, "old/results.json");
    const result = combine([{ path: "old/results.json", data }]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.ablation).toBe("none");
    expect(result.rows[0]!.failures.error).toBe(1);
  });
});

describe("formatComparison", () => {
  test("a Markdown table with warnings first, one row per group", () => {
    const a = resultsFile([run()], { judge_model: "judge-1" });
    const b = resultsFile([run({ run: 2, ablation: "bare", ablated: ["organize-message"] })], { judge_model: "judge-2" });
    const result = combine([
      { path: "/out/a/results.json", data: a },
      { path: "/out/b/results.json", data: b },
    ]);
    const text = formatComparison(result);
    expect(text).toStartWith("# 黄金路径对比\n");
    expect(text).toContain("## 警告");
    expect(text).toContain("judge_model");
    expect(text).toContain("| 模型 | 组班 | 消融 |");
    expect(text).toContain("model-a | manual | none |");
    expect(text).toContain("model-a | manual | bare |");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("no rows still renders a table shell", () => {
    const text = formatComparison({ rows: [], warnings: [] });
    expect(text).toContain("没有可比的运行");
  });
});
