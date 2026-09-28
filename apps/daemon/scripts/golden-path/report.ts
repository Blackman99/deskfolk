/**
 * One benchmark run's result, the completion rate over many, and the Markdown summary. Pure.
 *
 * A run is **completed** when the job settled on its own (not timed out, not blocked on you, not
 * failed to form a team), the goal-coverage judge scored it at or above the pass mark, and every
 * deterministic check passed (deliverables there and non-empty, content checks, verify commands).
 * Aborted runs (Ctrl-C) are listed but left out of every rate.
 */
import { formatCoverageReport, type GoalCoverage } from "../../src/goal-coverage-eval";
import type { CheckResult } from "./checks";
import type { Interventions } from "./interventions";
import type { Setup } from "./tasks";

export const OUTCOMES = ["settled", "blocked_on_user", "timeout", "setup_failed", "error", "aborted"] as const;
export type RunOutcome = (typeof OUTCOMES)[number];

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
};

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
  /** Coordinator setup: from your message to the group being ready. Null for manual. */
  team_ms: number | null;
  team: { group_id: string | null; group_name: string | null; bots: string[]; speakers: Record<string, number> };
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
};

export function isCompleted(run: Pick<RunResult, "outcome" | "score" | "checks_ok">, minPass: number): boolean {
  return run.outcome === "settled" && run.score !== null && run.score >= minPass && run.checks_ok;
}

export type Bucket = {
  runs: number;
  completed: number;
  rate: number;
  mean_interventions: number;
  /** Over the runs the judge scored. */
  mean_score: number | null;
  mean_wall_ms: number;
};

export type Aggregate = {
  overall: Bucket;
  by_setup: Record<string, Bucket>;
  by_task: Record<string, Bucket>;
  outcomes: Record<RunOutcome, number>;
  interventions: { approvals: number; asks: number; stalls: number; plan_nudges: number };
};

function bucket(runs: readonly RunResult[]): Bucket {
  const scored = runs.filter((run) => run.score !== null);
  const completed = runs.filter((run) => run.completed).length;
  const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  return {
    runs: runs.length,
    completed,
    rate: runs.length ? completed / runs.length : 0,
    mean_interventions: mean(runs.map((run) => run.interventions.total)),
    mean_score: scored.length ? mean(scored.map((run) => run.score!)) : null,
    mean_wall_ms: mean(runs.map((run) => run.wall_ms)),
  };
}

function groupBy(runs: readonly RunResult[], key: (run: RunResult) => string): Record<string, Bucket> {
  const groups = new Map<string, RunResult[]>();
  for (const run of runs) groups.set(key(run), [...(groups.get(key(run)) ?? []), run]);
  return Object.fromEntries([...groups].map(([name, list]) => [name, bucket(list)]));
}

export function aggregate(all: readonly RunResult[]): Aggregate {
  const runs = all.filter((run) => run.outcome !== "aborted");
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<RunOutcome, number>;
  for (const run of all) outcomes[run.outcome] += 1;
  const sum = (pick: (run: RunResult) => number): number => runs.reduce((total, run) => total + pick(run), 0);
  return {
    overall: bucket(runs),
    by_setup: groupBy(runs, (run) => run.setup),
    by_task: groupBy(runs, (run) => run.task),
    outcomes,
    interventions: {
      approvals: sum((run) => run.interventions.approvals),
      asks: sum((run) => run.interventions.asks),
      stalls: sum((run) => run.interventions.stalls),
      plan_nudges: sum((run) => run.interventions.plan_nudges),
    },
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
  const lines = [`| ${title} | 完成 | 完成率 | 平均介入 | 平均覆盖率 | 平均用时 |`, "|---|---|---|---|---|---|"];
  for (const [name, value] of Object.entries(buckets)) {
    lines.push(
      `| ${cell(name)} | ${value.completed} / ${value.runs} | ${percent(value.rate)} | ${value.mean_interventions.toFixed(1)} | ${percent(value.mean_score)} | ${formatDuration(value.mean_wall_ms)} |`,
    );
  }
  return lines;
}

function runLabel(run: RunResult): string {
  return `${run.task} · ${run.setup} · #${run.run}`;
}

export function formatSummary(input: { meta: SummaryMeta; aggregate: Aggregate; runs: readonly RunResult[] }): string {
  const { meta, aggregate: agg, runs } = input;
  const lines: string[] = [
    `# 黄金路径基准 — ${meta.model}`,
    "",
    `- 时间：${meta.started_at} → ${meta.finished_at}`,
    `- 团队模型：${meta.model}；评判模型：${meta.judge_model}；端点：${meta.base_url}`,
    `- 每次墙钟上限 ${meta.timeout_min} 分钟；批准一律 ${meta.approvals}；覆盖率及格线 ${percent(meta.min_pass)}`,
    `- 任务集：\`${meta.tasks_file}\`${meta.commit ? `；提交 ${meta.commit}` : ""}`,
    "",
    "## 结论",
    "",
    `**完成 ${agg.overall.completed} / ${agg.overall.runs}（${percent(agg.overall.rate)}）**，平均每次人工介入 ${agg.overall.mean_interventions.toFixed(1)} 次（共批准 ${agg.interventions.approvals} · 提问 ${agg.interventions.asks} · 停下 ${agg.interventions.stalls}；另有应用自己叫回 ${agg.interventions.plan_nudges} 次，不算介入）。`,
    "",
    `完成 = 这件事自己静下来（不是超时、不是停在等你、不是没组成班），覆盖率 ≥ ${percent(meta.min_pass)}，交付检查全过。介入 = 出现过的批准卡 + 问你的问题 + 「这件事停下了」通知。`,
    "",
  ];
  const outcomes = Object.entries(agg.outcomes).filter(([, n]) => n > 0).map(([name, n]) => `${OUTCOME_LABEL[name as RunOutcome]} ${n}`);
  if (outcomes.length) lines.push(`结局：${outcomes.join(" · ")}`, "");
  lines.push(...bucketRows("组班方式", agg.by_setup), "", ...bucketRows("任务", agg.by_task), "");
  lines.push(
    "## 每次运行",
    "",
    "| 任务 | 组班 | # | 结局 | 完成 | 覆盖率 | 检查 | 介入（批/问/停） | 叫回 | 用时 | 轮 | 跳 | 工具错 | 花费行 | tokens 入/出 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const run of runs) {
    const passed = run.checks.filter((check) => check.ok).length;
    const i = run.interventions;
    lines.push(
      `| ${cell(run.task)} | ${run.setup} | ${run.run} | ${OUTCOME_LABEL[run.outcome]} | ${run.completed ? "✅" : "❌"} | ${percent(run.score)} | ${passed}/${run.checks.length} | ${i.total}（${i.approvals}/${i.asks}/${i.stalls}） | ${i.plan_nudges} | ${formatDuration(run.wall_ms)} | ${run.stats.turns} | ${run.stats.hops} | ${run.stats.tool_errors} | ${run.stats.spend_rows} | ${run.stats.input_tokens}/${run.stats.output_tokens} |`,
    );
  }
  lines.push("", "## 明细", "");
  for (const run of runs) {
    lines.push(`### ${runLabel(run)}`, "");
    lines.push(`- 结局：${OUTCOME_LABEL[run.outcome]}${run.outcome_detail ? `（${cell(run.outcome_detail)}）` : ""}；用时 ${formatDuration(run.wall_ms)}${run.team_ms !== null ? `，组班 ${formatDuration(run.team_ms)}` : ""}`);
    const speakers = Object.entries(run.team.speakers).map(([name, n]) => `${name} ${n}`).join("、");
    lines.push(`- 群：${run.team.group_name ?? "（没有）"}；名册：${run.team.bots.join("、") || "（空）"}；群里发过言：${speakers || "没有人"}`);
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
    const cost = run.stats.cost_usd === null ? "" : `，约 $${run.stats.cost_usd.toFixed(4)}`;
    lines.push(`- 用量：${run.stats.turns} 轮、${run.stats.hops} 跳、${run.stats.tool_calls} 次工具调用（错 ${run.stats.tool_errors}）、${run.stats.spend_rows} 行花费、tokens ${run.stats.input_tokens} 入 / ${run.stats.output_tokens} 出${cost}`);
    lines.push(`- 交出的文件：${run.files.written.length ? run.files.written.map((path) => `\`${path}\``).join("、") : "没有"}`);
    if (run.pending_check_backs) lines.push(`- 还约着 ${run.pending_check_backs} 次回看（在截止之后）`);
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
