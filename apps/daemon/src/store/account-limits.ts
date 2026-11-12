/**
 * What the app remembers about your accounts' plan limits (ADR 0110): which account's limit turned a
 * request away and until when, and the failure lines that pick up by themselves once a limit
 * resets. Kept in `settings` as two small JSON values, so a restart of the daemon keeps both; nothing
 * about an account is kept beyond its directory and the email its agent reported.
 */
import type { BotRunner } from "@real-bot/protocol";
import { setSetting, type StoreContext } from "./shared";

const OUT_KEY = "agent_accounts_out";
const RESUMES_KEY = "agent_limit_resumes";
const PROJECT_RESUMES_KEY = "project_limit_resumes";
/** More resumes than this are old ones nobody cleared; the oldest go first. */
const RESUMES_MAX = 64;

/**
 * One account out of usage. `dir`: the directory its agent reads, absolute (the daemon's own
 * environment resolved to the directory it means). `until`: when it can be used again, in ms;
 * `known` when the agent said so, otherwise a guess the picker uses but nothing is scheduled on.
 */
export type AccountOut = { runner: BotRunner; dir: string; email: string | null; until: number; known: boolean };

/** A failure line that continues by itself at `at` (ms): the turn it ended, for the staleness check. */
export type LimitResume = { message_id: string; turn_id: string; at: number };

function read(ctx: StoreContext, key: string): unknown {
  const raw = ctx.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? "";
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isOut(value: unknown): value is AccountOut {
  const row = value as Partial<AccountOut> | null;
  return Boolean(row) && typeof row!.runner === "string" && typeof row!.dir === "string" && typeof row!.until === "number"
    && typeof row!.known === "boolean" && (row!.email === null || typeof row!.email === "string");
}

/** The accounts still out at `now`. */
export function accountsOut(ctx: StoreContext, now: number = Date.now()): AccountOut[] {
  const value = read(ctx, OUT_KEY);
  return Array.isArray(value) ? value.filter(isOut).filter((row) => row.until > now) : [];
}

/** Notes an account out until `until`; an earlier note on the same directory is replaced. */
export function markAccountOut(ctx: StoreContext, entry: AccountOut, now: number = Date.now()): void {
  const kept = accountsOut(ctx, now).filter((row) => !(row.runner === entry.runner && row.dir === entry.dir));
  setSetting(ctx, OUT_KEY, JSON.stringify([...kept, entry]));
}

/** Forgets an account's note: a request on it went through after all. */
export function clearAccountOut(ctx: StoreContext, runner: BotRunner, dir: string, now: number = Date.now()): void {
  const all = accountsOut(ctx, now);
  const kept = all.filter((row) => !(row.runner === runner && row.dir === dir));
  if (kept.length !== all.length) setSetting(ctx, OUT_KEY, kept.length > 0 ? JSON.stringify(kept) : "");
}

function isResume(value: unknown): value is LimitResume {
  const row = value as Partial<LimitResume> | null;
  return Boolean(row) && typeof row!.message_id === "string" && typeof row!.turn_id === "string" && typeof row!.at === "number";
}

/** Every failure line waiting to continue by itself, soonest first. */
export function limitResumes(ctx: StoreContext): LimitResume[] {
  const value = read(ctx, RESUMES_KEY);
  return (Array.isArray(value) ? value.filter(isResume) : []).sort((a, b) => a.at - b.at);
}

export function addLimitResume(ctx: StoreContext, row: LimitResume): void {
  const kept = limitResumes(ctx).filter((entry) => entry.message_id !== row.message_id);
  setSetting(ctx, RESUMES_KEY, JSON.stringify([...kept, row].sort((a, b) => a.at - b.at).slice(-RESUMES_MAX)));
}

export function dropLimitResume(ctx: StoreContext, messageId: string): void {
  const all = limitResumes(ctx);
  const kept = all.filter((entry) => entry.message_id !== messageId);
  if (kept.length !== all.length) setSetting(ctx, RESUMES_KEY, kept.length > 0 ? JSON.stringify(kept) : "");
}

/**
 * Whether a failed turn's work has moved on since: the same Bot has a later turn in that
 * conversation, on the same job, that did not end out of usage again — you spoke and it got
 * through, you stopped it, or it is at work now. Such a resume is dropped, not fired.
 */
export function limitResumeStale(ctx: StoreContext, turnId: string): boolean {
  const cut = ctx.db.query<{ session_id: string; bot_id: string; task_id: string | null; created_at: string }, [string]>(
    "SELECT session_id, bot_id, task_id, created_at FROM turns WHERE id = ?").get(turnId);
  if (!cut) return true;
  const later = ctx.db.query<{ outcome: string | null; fail_kind: string | null }, [string, string, string, string, string | null]>(
    `SELECT d.outcome, d.fail_kind FROM turns t LEFT JOIN turn_route_decisions d ON d.turn_id = t.id
      WHERE t.session_id = ? AND t.bot_id = ? AND t.id != ? AND t.created_at >= ? AND t.task_id IS ?`,
  ).all(cut.session_id, cut.bot_id, turnId, cut.created_at, cut.task_id);
  return later.some((row) => !(row.outcome === "failed" && row.fail_kind === "agent_limit"));
}

/**
 * A project session that picks up by itself at `at` (ms), ADR 0110: the run that ran out, and your
 * lines it had not answered (message ids, read again when it fires). One per session.
 */
export type ProjectResume = { session_id: string; run_id: string; at: number; lines: string[] };

function isProjectResume(value: unknown): value is ProjectResume {
  const row = value as Partial<ProjectResume> | null;
  return Boolean(row) && typeof row!.session_id === "string" && typeof row!.run_id === "string" && typeof row!.at === "number"
    && Array.isArray(row!.lines) && row!.lines.every((id) => typeof id === "string");
}

/** Every project session waiting to pick up by itself, soonest first. */
export function projectResumes(ctx: StoreContext): ProjectResume[] {
  const value = read(ctx, PROJECT_RESUMES_KEY);
  return (Array.isArray(value) ? value.filter(isProjectResume) : []).sort((a, b) => a.at - b.at);
}

export function addProjectResume(ctx: StoreContext, row: ProjectResume): void {
  const kept = projectResumes(ctx).filter((entry) => entry.session_id !== row.session_id);
  setSetting(ctx, PROJECT_RESUMES_KEY, JSON.stringify([...kept, row].sort((a, b) => a.at - b.at).slice(-RESUMES_MAX)));
}

export function dropProjectResume(ctx: StoreContext, sessionId: string): void {
  const all = projectResumes(ctx);
  const kept = all.filter((entry) => entry.session_id !== sessionId);
  if (kept.length !== all.length) setSetting(ctx, PROJECT_RESUMES_KEY, kept.length > 0 ? JSON.stringify(kept) : "");
}
