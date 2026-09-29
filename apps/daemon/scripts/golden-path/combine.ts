/**
 * Combines several golden-path `results.json` files into one comparison: rows grouped by
 * (model, setup, ablation[, task]), a Wilson interval on the completion rate, and deltas against
 * the same model+setup(+task)'s "none" ablation row. Pure — `scripts/golden-path-combine.ts` is
 * the thin CLI that reads files from disk and calls this.
 */
import { basename, dirname } from "node:path";
import type { SideCall } from "../../src/ablation";
import { bucketOf, classifyFailure, formatDuration, isCompleted, type FailureKind, type RunResult } from "./report";

export type ResultsMeta = {
  model: string;
  judge_model?: unknown;
  base_url?: unknown;
  min_pass?: unknown;
  timeout_min?: unknown;
  approvals?: unknown;
  tasks_file?: unknown;
  commit?: unknown;
  [key: string]: unknown;
};

export type ResultsFile = { meta: ResultsMeta; runs: RunResult[] };

/**
 * Normalizes a parsed `results.json`: an older file (or a hand-built fixture) missing a field this
 * benchmark grew later reads with that field's default — `ablation` "none", `ablated` `[]`,
 * `session_kind` null, `failure`/`failure_detail` derived with `classifyFailure` — instead of
 * throwing or silently carrying `undefined` into `bucketOf`.
 */
export function readResults(raw: unknown, path: string): ResultsFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: not a results.json object`);
  const root = raw as Record<string, unknown>;
  const meta = root.meta;
  if (!meta || typeof meta !== "object" || typeof (meta as Record<string, unknown>).model !== "string") {
    throw new Error(`${path}: missing meta.model`);
  }
  const rawRuns = root.runs;
  if (!Array.isArray(rawRuns)) throw new Error(`${path}: missing runs[]`);
  const metaObj = meta as ResultsMeta;
  const minPass = typeof metaObj.min_pass === "number" ? metaObj.min_pass : 0.8;
  return { meta: metaObj, runs: rawRuns.map((item) => normalizeRun(item as Record<string, unknown>, minPass, path)) };
}

function normalizeRun(raw: Record<string, unknown>, minPass: number, path: string): RunResult {
  const rawTeam = (raw.team as Record<string, unknown> | undefined) ?? {};
  const rawStats = (raw.stats as Record<string, unknown> | undefined) ?? {};
  if (typeof raw.task !== "string" || typeof raw.setup !== "string" || typeof raw.outcome !== "string") {
    throw new Error(`${path}: a run is missing task/setup/outcome`);
  }
  const run = {
    ...raw,
    team: {
      group_id: (rawTeam.group_id as string | null | undefined) ?? null,
      group_name: (rawTeam.group_name as string | null | undefined) ?? null,
      bots: (rawTeam.bots as string[] | undefined) ?? [],
      speakers: (rawTeam.speakers as Record<string, number> | undefined) ?? {},
      session_kind: (rawTeam.session_kind as "group" | "direct" | null | undefined) ?? null,
    },
    stats: {
      ...rawStats,
      spend_by_kind: (rawStats.spend_by_kind as RunResult["stats"]["spend_by_kind"] | undefined) ?? {},
      thinking_levels: (rawStats.thinking_levels as Record<string, number> | undefined) ?? {},
    },
    ended_stalled: (raw.ended_stalled as boolean | undefined) ?? false,
    ablation: (raw.ablation as string | undefined) ?? "none",
    ablated: (raw.ablated as SideCall[] | undefined) ?? [],
    ablation_leaks: (raw.ablation_leaks as string[] | undefined) ?? [],
  } as RunResult;
  run.failure = raw.failure !== undefined ? (raw.failure as FailureKind | null) : classifyFailure(run, minPass);
  run.failure_detail = (raw.failure_detail as string | null | undefined) ?? null;
  return run;
}

/** 95% Wilson score interval on `k` successes out of `n` trials; `[0, 1]` clamped. */
export function wilson(k: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const z = 1.959963984540054;
  const phat = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return {
    low: Math.max(0, (center - margin) / denominator),
    high: Math.min(1, (center + margin) / denominator),
  };
}

export type ComparisonRow = {
  key: string;
  model: string;
  setup: string;
  ablation: string;
  /** Only set when `--by-task`. */
  task: string | null;
  runs: number;
  completed: number;
  rate: number;
  wilson: { low: number; high: number };
  mean_score: number | null;
  mean_interventions: number;
  mean_wall_ms: number;
  mean_cost_usd: number | null;
  /** Share of this group's spend that was not a `turn` bucket (organize, closing check, route pick, …); null with no cost data. */
  side_call_cost_share: number | null;
  failures: Partial<Record<FailureKind, number>>;
  /** vs. this model+setup(+task)'s "none" ablation row; null for the "none" row itself, or when there is no baseline to compare against. */
  delta_rate: number | null;
  delta_cost_usd: number | null;
};

export type CombineResult = { rows: ComparisonRow[]; warnings: string[] };

const META_FIELDS = ["judge_model", "min_pass", "timeout_min", "approvals", "tasks_file", "commit"] as const;

function metaWarnings(files: readonly { path: string; data: ResultsFile }[]): string[] {
  if (files.length < 2) return [];
  const warnings: string[] = [];
  for (const field of META_FIELDS) {
    const byValue = new Map<string, string[]>();
    for (const file of files) {
      const key = JSON.stringify(file.data.meta[field] ?? null);
      byValue.set(key, [...(byValue.get(key) ?? []), file.path]);
    }
    if (byValue.size > 1) {
      const parts = [...byValue.entries()].map(([value, paths]) => `${value === "null" ? "（无）" : value}：${paths.join("、")}`);
      warnings.push(`meta.${field} 在文件间不一致 — ${parts.join("；")}`);
    }
  }
  return warnings;
}

/** The directory a results.json (or its containing folder, passed directly) lives in — the unit a run's `run_dir` is relative to. */
function resultsDir(path: string): string {
  return basename(path) === "results.json" ? dirname(path) : path;
}

function sideCallCostShare(runs: readonly RunResult[]): number | null {
  let total = 0;
  let side = 0;
  let any = false;
  for (const run of runs) {
    for (const [bucket, stats] of Object.entries(run.stats.spend_by_kind ?? {})) {
      if (stats.cost_usd === null) continue;
      any = true;
      total += stats.cost_usd;
      if (bucket !== "turn") side += stats.cost_usd;
    }
  }
  if (!any || total <= 0) return null;
  return side / total;
}

/**
 * Groups the runs of every file by (model, setup, ablation[, task]), de-duping by
 * `(results directory, run_dir)` so the same output folder read twice (e.g. via both a bare
 * directory and its `results.json`) counts once. With `minPass`, completion and failure are
 * re-derived at that pass mark instead of trusting each run's own `completed`/`failure`.
 */
export function combine(files: readonly { path: string; data: ResultsFile }[], opts: { byTask?: boolean; minPass?: number } = {}): CombineResult {
  const warnings = metaWarnings(files);
  const groups = new Map<string, { model: string; setup: string; ablation: string; task: string | null; runs: RunResult[] }>();
  const seenRuns = new Set<string>();
  for (const file of files) {
    const dir = resultsDir(file.path);
    const model = file.data.meta.model;
    const fileMinPass = typeof file.data.meta.min_pass === "number" ? file.data.meta.min_pass : 0.8;
    const minPass = opts.minPass ?? fileMinPass;
    for (const run of file.data.runs) {
      if (run.outcome === "aborted") continue; // excluded from every rate, same as aggregate()
      const dedupeKey = `${dir}\u0000${run.run_dir}`;
      if (seenRuns.has(dedupeKey)) continue;
      seenRuns.add(dedupeKey);
      const effective: RunResult =
        opts.minPass !== undefined ? { ...run, completed: isCompleted(run, minPass), failure: classifyFailure(run, minPass) } : run;
      const task = opts.byTask ? effective.task : null;
      const key = [model, effective.setup, effective.ablation, task ?? ""].join("\u0000");
      const group = groups.get(key) ?? { model, setup: effective.setup, ablation: effective.ablation, task, runs: [] };
      group.runs.push(effective);
      groups.set(key, group);
    }
  }
  const rows: ComparisonRow[] = [...groups.values()].map((group) => {
    const b = bucketOf(group.runs);
    return {
      key: `${group.model} · ${group.setup} · ${group.ablation}${group.task ? ` · ${group.task}` : ""}`,
      model: group.model,
      setup: group.setup,
      ablation: group.ablation,
      task: group.task,
      runs: b.runs,
      completed: b.completed,
      rate: b.rate,
      wilson: wilson(b.completed, b.runs),
      mean_score: b.mean_score,
      mean_interventions: b.mean_interventions,
      mean_wall_ms: b.mean_wall_ms,
      mean_cost_usd: b.mean_cost_usd,
      side_call_cost_share: sideCallCostShare(group.runs),
      failures: b.failures,
      delta_rate: null,
      delta_cost_usd: null,
    };
  });
  for (const row of rows) {
    if (row.ablation === "none") continue;
    const baseline = rows.find((other) => other.model === row.model && other.setup === row.setup && other.task === row.task && other.ablation === "none");
    if (!baseline) continue;
    row.delta_rate = row.rate - baseline.rate;
    row.delta_cost_usd = row.mean_cost_usd !== null && baseline.mean_cost_usd !== null ? row.mean_cost_usd - baseline.mean_cost_usd : null;
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return { rows, warnings };
}

const percent = (value: number | null): string => (value === null ? "—" : `${Math.round(value * 100)}%`);
const pp = (value: number | null): string => (value === null ? "—" : `${value >= 0 ? "+" : ""}${Math.round(value * 100)}pp`);
const usd = (value: number | null): string => (value === null ? "—" : `$${value.toFixed(4)}`);
const deltaUsd = (value: number | null): string => (value === null ? "—" : `${value >= 0 ? "+" : ""}$${value.toFixed(4)}`);

/** Markdown comparison table, in the same Chinese style as `formatSummary`. */
export function formatComparison(result: CombineResult): string {
  const lines: string[] = ["# 黄金路径对比", ""];
  if (result.warnings.length > 0) {
    lines.push("## 警告", "", ...result.warnings.map((warning) => `- ⚠️ ${warning}`), "");
  }
  lines.push(
    "| 模型 | 组班 | 消融 | 任务 | 完成 | 完成率 | 95% 区间 | Δ完成率 | 平均花费 | Δ花费 | 旁支花费占比 | 平均覆盖率 | 平均介入 | 平均用时 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const row of result.rows) {
    lines.push(
      `| ${row.model} | ${row.setup} | ${row.ablation} | ${row.task ?? "（全部）"} | ${row.completed} / ${row.runs} | ${percent(row.rate)} | ${percent(row.wilson.low)}–${percent(row.wilson.high)} | ${pp(row.delta_rate)} | ${usd(row.mean_cost_usd)} | ${deltaUsd(row.delta_cost_usd)} | ${percent(row.side_call_cost_share)} | ${percent(row.mean_score)} | ${row.mean_interventions.toFixed(1)} | ${formatDuration(row.mean_wall_ms)} |`,
    );
  }
  if (result.rows.length === 0) lines.push("（没有可比的运行）");
  return `${lines.join("\n").trimEnd()}\n`;
}
