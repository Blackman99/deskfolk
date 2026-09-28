/**
 * One benchmark run's result, the completion rate over many, and the Markdown summary. Pure.
 *
 * A run is **completed** when the job settled on its own (not timed out, not blocked on you, not
 * failed to form a team), the goal-coverage judge scored it at or above the pass mark, and every
 * deterministic check passed (deliverables there and non-empty, content checks, verify commands).
 * Aborted runs (Ctrl-C) are listed but left out of every rate.
 *
 * A run that did **not** complete gets one `FailureKind`, in `FAILURE_KINDS` precedence order —
 * `classifyFailure` returns `null` exactly when `isCompleted` is true, and only one reason each.
 *
 * Every function here also tolerates a `RunResult` written before this file grew these fields (an
 * older `results.json`, or a hand-built test fixture): a missing field reads as its default rather
 * than throwing, so `combine.ts` can mix old and new result files.
 */
import type { SideCall } from "../../src/ablation";
import { formatCoverageReport, type GoalCoverage } from "../../src/goal-coverage-eval";
import type { CheckResult } from "./checks";
import type { Interventions } from "./interventions";
import type { Setup } from "./tasks";

export const OUTCOMES = ["settled", "blocked_on_user", "timeout", "setup_failed", "error", "aborted"] as const;
export type RunOutcome = (typeof OUTCOMES)[number];

/** `spend.kind` (plus `route_pick` / `route_review` / `route_learn` are already spend kinds) rolled up to what an ablation switch turns off. */
export type SpendBucketStats = { rows: number; input_tokens: number; output_tokens: number; cost_usd: number | null };

export type RunStats = {
  turns: number;
  hops: number;
  tool_calls: number;
  tool_errors: number;
  messages: number;
  spend_rows: number;
  input_tokens: number;
  output_tokens: number;
  /** Reported plus estimated USD, when any row carried either; null when none did. */
  cost_usd: number | null;
  judge_input_tokens: number | null;
  judge_output_tokens: number | null;
  /** `spend` grouped by `spendBucket(kind, thinking_level)`. */
  spend_by_kind: Record<string, SpendBucketStats>;
  /** `turn_route_decisions.thinking_level` histogram; empty when the column could not be read. */
  thinking_levels: Record<string, number>;
};

export const FAILURE_KINDS = [
  "aborted",
  "setup_failed",
  "error",
  "timeout",
  "stalled",
  "blocked_on_user",
  "no_delivery",
  "checks_failed",
  "not_judged",
  "coverage_below",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export type RunResult = {
  task: string;
  title: string;
  setup: Setup;
  run: number;
  outcome: RunOutcome;
  outcome_detail: string | null;
  completed: boolean;
  /** From your first message of the run to settle (or timeout). */
  wall_ms: number;
  /** Coordinator setup: from your message to the group being ready. Null for manual and solo. */
  team_ms: number | null;
  team: { group_id: string | null; group_name: string | null; bots: string[]; speakers: Record<string, number>; session_kind: "group" | "direct" | null };
  plan: {
    id: string;
    title: string;
    dir: string;
    status: string;
    tickets: Array<{ seq: number; title: string; status: string; worker: string | null }>;
  } | null;
  coverage: GoalCoverage | null;
  score: number | null;
  judge_error: string | null;
  checks: CheckResult[];
  checks_ok: boolean;
  interventions: Interventions;
  stats: RunStats;
  files: { cited: string[]; written: string[] };
  /** Check-backs still booked at the end, all due after the deadline. */
  pending_check_backs: number;
  /** Relative to the output folder. */
  run_dir: string;
  /** The key turned up in the kept data or workspace. Should never be true. */
  key_leak: boolean;
  /** The plan ended on the app telling you it stopped, and nothing moved after (ADR 0031). */
  ended_stalled: boolean;
  /** `ablationLabel` of the switches this run turned off; "none" when none were. */
  ablation: string;
  /** The switches this run turned off, in `SIDE_CALLS` order. */
  ablated: SideCall[];
  /** Rows that turned up in `spend` for a call this run's ablation switched off (see `ablationLeaks`). */
  ablation_leaks: string[];
  /** Why this run did not count as completed; null exactly when it did. */
  failure: FailureKind | null;
  /** What the failure was, e.g. which check failed or the coverage score. */
  failure_detail: string | null;
};

export function isCompleted(run: Pick<RunResult, "outcome" | "score" | "checks_ok">, minPass: number): boolean {
  return run.outcome === "settled" && run.score !== null && run.score >= minPass && run.checks_ok;
}

/** `spend.kind = 'turn'` splits into an ordinary turn and the closing check (a turn-shaped call with no thinking level). */
export function spendBucket(kind: string, thinkingLevel: string | null): string {
  if (kind === "turn") return thinkingLevel === null ? "closing_check" : "turn";
  return kind;
}

/**
 * Whether a run did not complete: `null` exactly when `isCompleted` is true. `FAILURE_KINDS` is
 * precedence order — a run gets the first reason that applies, never more than one.
 */
export function classifyFailure(run: Pick<RunResult, "outcome" | "score" | "checks_ok" | "ended_stalled" | "checks">, minPass: number): FailureKind | null {
  if (isCompleted(run, minPass)) return null;
  if (run.outcome === "aborted") return "aborted";
  if (run.outcome === "setup_failed") return "setup_failed";
  if (run.outcome === "error") return "error";
  if (run.outcome === "timeout") return "timeout";
  if (run.outcome === "blocked_on_user") return run.ended_stalled ? "stalled" : "blocked_on_user";
  const noDelivery = run.checks.some((check) => !check.ok && check.kind === "deliverable");
  if (noDelivery) return "no_delivery";
  if (!run.checks_ok) return "checks_failed";
  if (run.score === null) return "not_judged";
  if (run.score < minPass) return "coverage_below";
  // outcome is "settled" and every isCompleted condition holds: unreachable, isCompleted already returned null above.
  return null;
}

/** What a run's failure was about: which check(s) failed, or the coverage score. */
export function failureDetail(run: Pick<RunResult, "checks" | "score" | "outcome_detail">, failure: FailureKind | null): string | null {
  switch (failure) {
    case "no_delivery":
      return run.checks.filter((check) => !check.ok && check.kind === "deliverable").map((check) => check.name).join("; ") || null;
    case "checks_failed":
      return run.checks.filter((check) => !check.ok).map((check) => check.name).join("; ") || null;
    case "coverage_below":
      return run.score === null ? null : `coverage ${Math.round(run.score * 100)}%`;
    case null:
    case "not_judged":
      return null;
    default:
      return run.outcome_detail ?? null;
  }
}

/**
 * Warn when a switched-off call still produced `spend` rows: the engine side did not actually
 * respect the ablation for this run (or has not landed it yet). Keyed off the same buckets
 * `spendBucket` produces, so a leak line names something `spend_by_kind` really has rows under.
 */
export function ablationLeaks(ablated: readonly SideCall[], spendByKind: Record<string, SpendBucketStats>): string[] {
  const off = new Set(ablated);
  const rows = (bucket: string): number => spendByKind[bucket]?.rows ?? 0;
  const warnings: string[] = [];
  if (off.has("route-pick") && rows("route_pick") > 0) warnings.push(`route-pick 关了，但仍有 ${rows("route_pick")} 行 route_pick 花费`);
  if (off.has("organize-message") && off.has("organize-settle") && rows("organize") > 0) {
    warnings.push(`organize-message 和 organize-settle 都关了，但仍有 ${rows("organize")} 行 organize 花费`);
  }
  if (off.has("closing-check") && rows("closing_check") > 0) warnings.push(`closing-check 关了，但仍有 ${rows("closing_check")} 行 closing_check 花费`);
  if (off.has("review") && rows("route_review") > 0) warnings.push(`review 关了，但仍有 ${rows("route_review")} 行 route_review 花费`);
  if (off.has("learning") && rows("route_learn") > 0) warnings.push(`learning 关了，但仍有 ${rows("route_learn")} 行 route_learn 花费`);
  if (off.has("judgement") && rows("judgement") > 0) warnings.push(`judgement 关了，但仍有 ${rows("judgement")} 行 judgement 花费`);
  return warnings;
}

// --- defaults for a RunResult that predates one of the fields above -------------------------

const DEFAULT_MIN_PASS = 0.8;
const EMPTY_SPEND_BY_KIND: Record<string, SpendBucketStats> = {};

export function ablationOf(run: RunResult): string {
  return run.ablation ?? "none";
}

export function ablatedOf(run: RunResult): readonly SideCall[] {
  return run.ablated ?? [];
}

export function sessionKindOf(run: RunResult): "group" | "direct" | null {
  return run.team.session_kind ?? null;
}

export function spendByKindOf(run: RunResult): Record<string, SpendBucketStats> {
  return run.stats.spend_by_kind ?? EMPTY_SPEND_BY_KIND;
}

export function leaksOf(run: RunResult): readonly string[] {
  return run.ablation_leaks ?? [];
}

export function endedStalledOf(run: RunResult): boolean {
  return run.ended_stalled ?? false;
}

/** `run.failure` when the run carries one; classified on the fly (at the CLI's default pass mark) otherwise. */
export function failureOf(run: RunResult): FailureKind | null {
  if (run.failure !== undefined) return run.failure;
  return classifyFailure({ ...run, ended_stalled: endedStalledOf(run) }, DEFAULT_MIN_PASS);
}

export type Bucket = {
  runs: number;
  completed: number;
  rate: number;
  mean_interventions: number;
  /** Over the runs the judge scored. */
  mean_score: number | null;
  mean_wall_ms: number;
  /** Over the runs that carried a cost; null when none did. */
  mean_cost_usd: number | null;
  mean_tokens: { input: number; output: number };
  failures: Partial<Record<FailureKind, number>>;
};

export type Aggregate = {
  overall: Bucket;
  by_setup: Record<string, Bucket>;
  by_task: Record<string, Bucket>;
  by_ablation: Record<string, Bucket>;
  /** Keyed `${setup} · ${ablation}`. */
  by_cell: Record<string, Bucket>;
  outcomes: Record<RunOutcome, number>;
  interventions: { approvals: number; asks: number; stalls: number; plan_nudges: number };
  spend_by_kind: Record<string, SpendBucketStats>;
};

/** Builds one `Bucket` from a group of runs. Exported so `combine.ts` can reuse it across result files. */
export function bucketOf(runs: readonly RunResult[]): Bucket {
  const scored = runs.filter((run) => run.score !== null);
  const completed = runs.filter((run) => run.completed).length;
  const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const costs = runs.map((run) => run.stats.cost_usd).filter((cost): cost is number => cost !== null && cost !== undefined);
  const failures: Partial<Record<FailureKind, number>> = {};
  for (const run of runs) {
    const failure = failureOf(run);
    if (failure) failures[failure] = (failures[failure] ?? 0) + 1;
  }
  return {
    runs: runs.length,
    completed,
    rate: runs.length ? completed / runs.length : 0,
    mean_interventions: mean(runs.map((run) => run.interventions.total)),
    mean_score: scored.length ? mean(scored.map((run) => run.score!)) : null,
    mean_wall_ms: mean(runs.map((run) => run.wall_ms)),
    mean_cost_usd: costs.length ? mean(costs) : null,
    mean_tokens: { input: mean(runs.map((run) => run.stats.input_tokens)), output: mean(runs.map((run) => run.stats.output_tokens)) },
    failures,
  };
}

function groupBy(runs: readonly RunResult[], key: (run: RunResult) => string): Record<string, Bucket> {
  const groups = new Map<string, RunResult[]>();
  for (const run of runs) groups.set(key(run), [...(groups.get(key(run)) ?? []), run]);
  return Object.fromEntries([...groups].map(([name, list]) => [name, bucketOf(list)]));
}

function sumSpendByKind(runs: readonly RunResult[]): Record<string, SpendBucketStats> {
  const out: Record<string, SpendBucketStats> = {};
  for (const run of runs) {
    for (const [bucket, value] of Object.entries(spendByKindOf(run))) {
      const acc = out[bucket] ?? { rows: 0, input_tokens: 0, output_tokens: 0, cost_usd: null };
      acc.rows += value.rows;
      acc.input_tokens += value.input_tokens;
      acc.output_tokens += value.output_tokens;
      if (value.cost_usd !== null) acc.cost_usd = (acc.cost_usd ?? 0) + value.cost_usd;
      out[bucket] = acc;
    }
  }
  return out;
}

export function aggregate(all: readonly RunResult[]): Aggregate {
  const runs = all.filter((run) => run.outcome !== "aborted");
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<RunOutcome, number>;
  for (const run of all) outcomes[run.outcome] += 1;
  const sum = (pick: (run: RunResult) => number): number => runs.reduce((total, run) => total + pick(run), 0);
  return {
    overall: bucketOf(runs),
    by_setup: groupBy(runs, (run) => run.setup),
    by_task: groupBy(runs, (run) => run.task),
    by_ablation: groupBy(runs, (run) => ablationOf(run)),
    by_cell: groupBy(runs, (run) => `${run.setup} · ${ablationOf(run)}`),
    outcomes,
    interventions: {
      approvals: sum((run) => run.interventions.approvals),
      asks: sum((run) => run.interventions.asks),
      stalls: sum((run) => run.interventions.stalls),
      plan_nudges: sum((run) => run.interventions.plan_nudges),
    },
    spend_by_kind: sumSpendByKind(runs),
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

const percent = (value: number | null): string => (value === null ? "—" : `${Math.round(value * 100)}%`);

/** One line of Markdown: pipes escaped for tables, backticks escaped (a plan named after `brief.md` must not open a code span). */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/`/g, "\\`").replace(/\s+/g, " ").trim();
}

const OUTCOME_LABEL: Record<RunOutcome, string> = {
  settled: "静下来",
  blocked_on_user: "等你处理",
  timeout: "超时",
  setup_failed: "没组成班",
  error: "出错",
  aborted: "中止",
};

const FAILURE_LABEL: Record<FailureKind, string> = {
  aborted: "中止",
  setup_failed: "没组成班",
  error: "出错",
  timeout: "超时",
  stalled: "停下了",
  blocked_on_user: "等你处理",
  no_delivery: "没交付",
  checks_failed: "检查没过",
  not_judged: "未评判",
  coverage_below: "覆盖率不够",
};

export type SummaryMeta = {
  model: string;
  judge_model: string;
  base_url: string;
  started_at: string;
  finished_at: string;
  timeout_min: number;
  approvals: string;
  min_pass: number;
  commit: string | null;
  tasks_file: string;
};

function bucketRows(title: string, buckets: Record<string, Bucket>): string[] {
  const lines = [`| ${title} | 完成 | 完成率 | 平均介入 | 平均覆盖率 | 平均用时 | 平均花费 |`, "|---|---|---|---|---|---|---|"];
  for (const [name, value] of Object.entries(buckets)) {
    const cost = value.mean_cost_usd === null ? "—" : `$${value.mean_cost_usd.toFixed(4)}`;
    lines.push(
      `| ${cell(name)} | ${value.completed} / ${value.runs} | ${percent(value.rate)} | ${value.mean_interventions.toFixed(1)} | ${percent(value.mean_score)} | ${formatDuration(value.mean_wall_ms)} | ${cost} |`,
    );
  }
  return lines;
}

function spendRows(byKind: Record<string, SpendBucketStats>): string[] {
  const entries = Object.entries(byKind).sort((a, b) => b[1].rows - a[1].rows);
  const total = entries.reduce((sum, [, value]) => sum + (value.cost_usd ?? 0), 0);
  const lines = ["| 类别 | 行数 | tokens 入/出 | 花费 | 占比 |", "|---|---|---|---|---|"];
  for (const [name, value] of entries) {
    const cost = value.cost_usd === null ? "—" : `$${value.cost_usd.toFixed(4)}`;
    const share = total > 0 && value.cost_usd !== null ? `${Math.round((value.cost_usd / total) * 100)}%` : "—";
    lines.push(`| ${cell(name)} | ${value.rows} | ${value.input_tokens}/${value.output_tokens} | ${cost} | ${share} |`);
  }
  return lines;
}

function runLabel(run: RunResult): string {
  return `${run.task} · ${run.setup} · #${run.run}`;
}

export function formatSummary(input: { meta: SummaryMeta; aggregate: Aggregate; runs: readonly RunResult[] }): string {
  const { meta, aggregate: agg, runs } = input;
  const setupsSeen = [...new Set(runs.map((run) => run.setup))];
  const ablationsSeen = [...new Set(runs.map((run) => ablationOf(run)))];
  const lines: string[] = [
    `# 黄金路径基准 — ${meta.model}`,
    "",
    `- 时间：${meta.started_at} → ${meta.finished_at}`,
    `- 团队模型：${meta.model}；评判模型：${meta.judge_model}；端点：${meta.base_url}`,
    `- 每次墙钟上限 ${meta.timeout_min} 分钟；批准一律 ${meta.approvals}；覆盖率及格线 ${percent(meta.min_pass)}`,
    `- 任务集：\`${meta.tasks_file}\`${meta.commit ? `；提交 ${meta.commit}` : ""}`,
    `- 组班：${setupsSeen.join("、") || "（无）"}`,
  ];
  if (ablationsSeen.length > 1 || ablationsSeen.some((label) => label !== "none")) {
    lines.push(`- 消融：${ablationsSeen.join("、")}`);
  }
  lines.push(
    "",
    "## 结论",
    "",
    `**完成 ${agg.overall.completed} / ${agg.overall.runs}（${percent(agg.overall.rate)}）**，平均每次人工介入 ${agg.overall.mean_interventions.toFixed(1)} 次（共批准 ${agg.interventions.approvals} · 提问 ${agg.interventions.asks} · 停下 ${agg.interventions.stalls}；另有应用自己叫回 ${agg.interventions.plan_nudges} 次，不算介入）。`,
    "",
    `完成 = 这件事自己静下来（不是超时、不是停在等你、不是没组成班），覆盖率 ≥ ${percent(meta.min_pass)}，交付检查全过。介入 = 出现过的批准卡 + 问你的问题 + 「这件事停下了」通知。`,
    "",
  );
  const outcomes = Object.entries(agg.outcomes).filter(([, n]) => n > 0).map(([name, n]) => `${OUTCOME_LABEL[name as RunOutcome]} ${n}`);
  if (outcomes.length) lines.push(`结局：${outcomes.join(" · ")}`, "");
  lines.push(...bucketRows("组班方式", agg.by_setup), "", ...bucketRows("任务", agg.by_task), "");
  if (Object.keys(agg.by_ablation).length > 1) {
    lines.push(...bucketRows("消融", agg.by_ablation), "");
  }
  lines.push("### 花费构成", "", ...spendRows(agg.spend_by_kind), "");
  lines.push(
    "## 每次运行",
    "",
    "| 任务 | 组班 | 消融 | # | 结局 | 失败 | 完成 | 覆盖率 | 检查 | 介入（批/问/停） | 叫回 | 用时 | 轮 | 跳 | 工具错 | 花费行 | tokens 入/出 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const run of runs) {
    const passed = run.checks.filter((check) => check.ok).length;
    const i = run.interventions;
    const failure = failureOf(run);
    lines.push(
      `| ${cell(run.task)} | ${run.setup} | ${cell(ablationOf(run))} | ${run.run} | ${OUTCOME_LABEL[run.outcome]} | ${failure ? FAILURE_LABEL[failure] : "—"} | ${run.completed ? "✅" : "❌"} | ${percent(run.score)} | ${passed}/${run.checks.length} | ${i.total}（${i.approvals}/${i.asks}/${i.stalls}） | ${i.plan_nudges} | ${formatDuration(run.wall_ms)} | ${run.stats.turns} | ${run.stats.hops} | ${run.stats.tool_errors} | ${run.stats.spend_rows} | ${run.stats.input_tokens}/${run.stats.output_tokens} |`,
    );
  }
  lines.push("", "## 明细", "");
  for (const run of runs) {
    lines.push(`### ${runLabel(run)}`, "");
    lines.push(`- 结局：${OUTCOME_LABEL[run.outcome]}${run.outcome_detail ? `（${cell(run.outcome_detail)}）` : ""}；用时 ${formatDuration(run.wall_ms)}${run.team_ms !== null ? `，组班 ${formatDuration(run.team_ms)}` : ""}`);
    if (ablationOf(run) !== "none") lines.push(`- 消融：${cell(ablationOf(run))}（关：${ablatedOf(run).join("、") || "（无）"}）`);
    if (sessionKindOf(run) === "direct") {
      lines.push(`- 私聊：${run.team.bots.join("、") || "（没有）"}`);
    } else {
      const speakers = Object.entries(run.team.speakers).map(([name, n]) => `${name} ${n}`).join("、");
      lines.push(`- 群：${run.team.group_name ?? "（没有）"}；名册：${run.team.bots.join("、") || "（空）"}；群里发过言：${speakers || "没有人"}`);
    }
    if (run.plan) {
      const tickets = run.plan.tickets.map((t) => `${String(t.seq).padStart(2, "0")} ${t.title}（${t.status}${t.worker ? ` · ${t.worker}` : ""}）`).join("；");
      lines.push(`- 规划：${cell(run.plan.title)}（${run.plan.status}）${tickets ? `；任务：${cell(tickets)}` : ""}`);
    } else {
      lines.push(run.outcome === "setup_failed" ? "- 规划：没组成班，任务没有发出" : "- 规划：任务消息没有被整理进规划（整理跳没答或答得不成形）");
    }
    const i = run.interventions;
    lines.push(
      `- 介入：批准 ${i.approvals}${i.approvals ? `（${Object.entries(i.approval_kinds).map(([k, n]) => `${k} ${n}`).join("、")}）` : ""} · 提问 ${i.asks} · 停下 ${i.stalls}；叫回 ${i.plan_nudges}；失败的轮 ${i.turn_failures}；中断 ${i.interrupted}`,
    );
    lines.push(`- 检查：${run.checks.map((check) => `${check.ok ? "✅" : "❌"} ${cell(check.name)}${check.ok ? "" : `（${cell(check.detail)}）`}`).join(" · ") || "无"}`);
    const failure = failureOf(run);
    if (failure) {
      const detail = run.failure_detail ?? failureDetail(run, failure);
      lines.push(`- 失败：${FAILURE_LABEL[failure]}${detail ? `（${cell(detail)}）` : ""}`);
    }
    const cost = run.stats.cost_usd === null ? "" : `，约 $${run.stats.cost_usd.toFixed(4)}`;
    lines.push(`- 用量：${run.stats.turns} 轮、${run.stats.hops} 跳、${run.stats.tool_calls} 次工具调用（错 ${run.stats.tool_errors}）、${run.stats.spend_rows} 行花费、tokens ${run.stats.input_tokens} 入 / ${run.stats.output_tokens} 出${cost}`);
    lines.push(`- 交出的文件：${run.files.written.length ? run.files.written.map((path) => `\`${path}\``).join("、") : "没有"}`);
    if (run.pending_check_backs) lines.push(`- 还约着 ${run.pending_check_backs} 次回看（在截止之后）`);
    if (run.setup === "solo" && run.team.bots.length > 1) lines.push(`- ⚠️ 单干时另建了 Bot（${run.team.bots.join("、")}）`);
    const leaks = leaksOf(run);
    if (leaks.length > 0) lines.push(`- ⚠️ 消融没生效：${leaks.join("；")}`);
    if (run.key_leak) lines.push("- ⚠️ 密钥出现在保留的数据里");
    lines.push(`- 数据：\`${run.run_dir}\``, "");
    if (run.coverage) {
      // The dir goes inside a code span there; a backtick in it (plans are named after your line) would end it early.
      const dir = (run.plan?.dir ?? "—").replace(/`/g, "'");
      lines.push(
        formatCoverageReport({ title: `覆盖率 · ${runLabel(run)}`, dir, model: meta.judge_model, coverage: run.coverage }).replace(/^## /, "#### "),
        "",
      );
    } else {
      lines.push(`- 未评判：${run.judge_error ?? "unknown"}`, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
