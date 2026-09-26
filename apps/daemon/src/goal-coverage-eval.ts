/**
 * Goal-coverage evaluation: did a finished job deliver what its opening request asked for?
 *
 * The pure parts live here so they can be unit-tested; `scripts/goal-coverage-eval.ts` reads a
 * job out of a copy of the database and drives a real endpoint. The judge sees the job's brief,
 * an excerpt of every file it handed over, and the Bots' last words, and answers per requirement.
 * A Bot saying "done" is not evidence; only what is in the files and messages counts.
 */
import { extractJsonObject } from "./route-agent";
import { takeCodePoints } from "./text";

export const GOAL_COVERAGE_SYSTEM = `你在核对一件事做完了没有，不是接着做它。没有工具，不能发言，不能读工作区。

根据用户消息这份 JSON 里的 brief、deliveries、final_messages 决定。brief 是这件事开头那条要求的原文；deliveries 是这件事交出的文件，每条有 path 和 excerpt（长文件只给开头，二进制文件没有 excerpt）；final_messages 是 Bot 最后说的几句。

只输出一个 JSON 对象。不要 markdown 围栏，不要前言后语，不要 tool-call。

- requirements：从 brief 里拆出的每一条可验收的要求，按 brief 里出现的顺序，不多不少。每条有：
  - text：原话，或紧贴原话的一句概括。
  - status：covered（交出的东西里看得到它做到了）、partial（做了一部分，或做了但不是要求的形态）、missing（没看到）之一。
  - evidence：一句话，说明在哪个文件或哪句话里看到的；没看到就写「没有」。
- summary：一句话，这件事整体做没做完。

策略：只认 deliveries 和 final_messages 里看得见的证据，Bot 说「已完成」不算证据。brief 里没提的不要补成要求；brief 里点名了路径的，路径不对就是 partial。拿不准就 partial，不要硬判 covered。`;

/** How much of one handed-over file the judge reads. */
export const COVERAGE_EXCERPT_LIMIT = 4000;
/** How much of one closing message the judge reads. */
export const COVERAGE_MESSAGE_LIMIT = 2000;
/** How many of the job's last Bot messages the judge sees. */
export const COVERAGE_MESSAGES = 6;

export const COVERAGE_STATUSES = ["covered", "partial", "missing"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export type CoverageRequirement = { text: string; status: CoverageStatus; evidence: string };
export type GoalCoverage = { requirements: CoverageRequirement[]; summary: string };

export type CoveragePayload = {
  brief: string;
  deliveries: Array<{ path: string; excerpt: string | null; truncated?: true }>;
  final_messages: Array<{ author: string; body: string; truncated?: true }>;
};

export function goalCoveragePayload(input: {
  brief: string;
  deliveries: ReadonlyArray<{ path: string; excerpt: string | null }>;
  finalMessages: ReadonlyArray<{ author: string; body: string }>;
}): CoveragePayload {
  return {
    brief: input.brief,
    deliveries: input.deliveries.map((delivery) => {
      if (delivery.excerpt === null) return { path: delivery.path, excerpt: null };
      const clipped = takeCodePoints(delivery.excerpt, COVERAGE_EXCERPT_LIMIT);
      return clipped.truncated
        ? { path: delivery.path, excerpt: clipped.text, truncated: true as const }
        : { path: delivery.path, excerpt: clipped.text };
    }),
    final_messages: input.finalMessages.slice(-COVERAGE_MESSAGES).map((message) => {
      const clipped = takeCodePoints(message.body, COVERAGE_MESSAGE_LIMIT);
      return clipped.truncated
        ? { author: message.author, body: clipped.text, truncated: true as const }
        : { author: message.author, body: clipped.text };
    }),
  };
}

/** A verdict is only kept when every requirement carries a status this code knows. */
export function parseGoalCoverage(raw: string): GoalCoverage | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.requirements)) return null;
  const requirements: CoverageRequirement[] = [];
  for (const item of parsed.requirements) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const status = COVERAGE_STATUSES.find(
      (candidate) => typeof row.status === "string" && row.status.trim().toLowerCase() === candidate,
    );
    if (!text || !status) return null;
    const evidence = typeof row.evidence === "string" ? row.evidence.trim() : "";
    requirements.push({ text, status, evidence });
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  return { requirements, summary };
}

/** Covered counts whole, partial half, missing nothing. A brief with no requirements is trivially met. */
export function coverageScore(coverage: GoalCoverage): number {
  if (coverage.requirements.length === 0) return 1;
  let total = 0;
  for (const requirement of coverage.requirements) {
    total += requirement.status === "covered" ? 1 : requirement.status === "partial" ? 0.5 : 0;
  }
  return total / coverage.requirements.length;
}

const STATUS_MARK: Record<CoverageStatus, string> = { covered: "✅", partial: "◐", missing: "❌" };

export function formatCoverageReport(input: {
  title: string;
  dir: string;
  model: string;
  coverage: GoalCoverage;
}): string {
  const score = coverageScore(input.coverage);
  const lines = [
    `## ${input.title}`,
    "",
    `- 工作目录：\`${input.dir}\``,
    `- 评判模型：${input.model}`,
    `- 覆盖率：${(score * 100).toFixed(0)}%（${input.coverage.requirements.length} 条要求）`,
    "",
    "| # | 要求 | 结果 | 依据 |",
    "|---|------|------|------|",
  ];
  input.coverage.requirements.forEach((requirement, index) => {
    lines.push(
      `| ${index + 1} | ${cell(requirement.text)} | ${STATUS_MARK[requirement.status]} ${requirement.status} | ${cell(requirement.evidence || "没有")} |`,
    );
  });
  if (input.coverage.summary) lines.push("", input.coverage.summary);
  return lines.join("\n");
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
