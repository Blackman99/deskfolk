/**
 * The goal-coverage judge call, shared by `goal-coverage-eval.ts` (jobs already in a database) and
 * `golden-path-eval.ts` (jobs it just ran). The prompt, payload, parser and score live in
 * `src/goal-coverage-eval.ts`; this is the one completion and what to make of its answer.
 */
import { USER_MEMBER } from "@real-bot/protocol";
import type { CompletionsClient, MappedUsage } from "../src/completions";
import {
  COVERAGE_MESSAGES,
  coverageScore,
  GOAL_COVERAGE_SYSTEM,
  parseGoalCoverage,
  type CoveragePayload,
  type GoalCoverage,
} from "../src/goal-coverage-eval";
import type { Store } from "../src/store";

/**
 * Room for one verdict per requirement with its evidence. Without it the short-call default of
 * 256 tokens applies, which cuts any real answer off partway through its JSON.
 */
export const COVERAGE_JUDGE_MAX_TOKENS = 4096;

export type CoverageVerdict = {
  coverage: GoalCoverage | null;
  score: number | null;
  error: string | null;
  usage: MappedUsage | null;
};

export async function judgeCoverage(input: {
  client: CompletionsClient;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  payload: CoveragePayload;
}): Promise<CoverageVerdict> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs * 3);
  let raw: string | null = null;
  let error: string | null = null;
  let usage: MappedUsage | null = null;
  try {
    const answer = await input.client.judge({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      messages: [
        { role: "system", content: GOAL_COVERAGE_SYSTEM },
        { role: "user", content: JSON.stringify(input.payload) },
      ],
      signal: controller.signal,
      timeoutMs: input.timeoutMs,
      maxTokens: COVERAGE_JUDGE_MAX_TOKENS,
    });
    usage = answer.usage;
    if (answer.failKind && answer.failKind !== "incomplete") error = `completion failed: ${answer.failKind}`;
    else if (answer.truncated) error = `the answer stopped at the ${COVERAGE_JUDGE_MAX_TOKENS}-token cap`;
    raw = answer.content;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timer);
  }
  const coverage = !error && raw ? parseGoalCoverage(raw) : null;
  if (!coverage && !error) error = "the judge did not answer in the expected shape";
  return { coverage, score: coverage ? coverageScore(coverage) : null, error, usage };
}

/** The last few Bot messages of a job (by plan) or of a session, oldest first, authors by name. */
export function lastBotWords(store: Store, where: { taskId: string } | { sessionId: string }): Array<{ author: string; body: string }> {
  const [column, value] = "taskId" in where ? ["task_id", where.taskId] : ["session_id", where.sessionId];
  const rows = store.db
    .query<{ author: string; body: string }, [string, number]>(
      `SELECT author, body FROM messages WHERE ${column} = ? AND kind = 'bot'
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(value, COVERAGE_MESSAGES)
    .reverse();
  return rows.map((row) => {
    if (row.author === USER_MEMBER) return row;
    try {
      return { author: store.getBot(row.author).name, body: row.body };
    } catch {
      return row;
    }
  });
}
