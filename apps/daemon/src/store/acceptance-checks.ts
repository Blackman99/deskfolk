/**
 * Acceptance checks (可执行验收): the app's own proof that one acceptance line holds, run on this
 * Mac, never on a Bot's say-so. A check lives here, in its own tables next to `turn_runs` — the
 * organizer rewrites `tasks.spec` whole, and a line dropped from the plan should not silently take
 * its check with it (see `rebindCheckItems`).
 *
 * Bots never write these (no tool). The user can create, redefine, remove and run one by hand;
 * pinning a check's source to `user` this way is what keeps a later organizer run from touching it.
 * Removing one is a tombstone (`removed_at`), never a delete: a run's history should still explain
 * itself after the check it proved is gone.
 */
import type { AcceptanceCheck, AcceptanceCheckKind, AcceptanceCheckOutcome, AcceptanceCheckRun, AcceptanceCheckRunCause } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { takeCodePoints } from "../text";
import { normalizeSpecLine } from "./plan-shape";
import { workspacePath, type StoreContext } from "./shared";
import { getTask, type Task } from "./tasks";
import { TURN_RUN_COMMAND_MAX } from "./turn-runs";
import { classifyPath, classifyShell } from "../workspace-paths";

export const CHECK_KINDS: readonly AcceptanceCheckKind[] = ["exists", "contains", "matches", "command"];

/** At most `limit` code points total, ellipsis included — a failing command's tail explains it, not its head. */
function tailCodePoints(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `…${chars.slice(-(limit - 1)).join("")}` : text;
}

/** Active checks a plan may hold; past this the plan is asking the app to run a test suite, not proving a line. */
export const CHECKS_MAX = 10;
/** New checks one organizer run may add; more than this is the organizer inventing a checklist. */
export const ORGANIZER_NEW_CHECKS_MAX = 3;
/** Runs kept per check; older ones are pruned once a newer one lands. */
export const CHECK_RUNS_KEPT = 5;
/** Code points of a run's captured output that are kept. */
export const CHECK_OUTPUT_MAX = 2000;
/** Code points of a run's one-line verdict. */
export const CHECK_DETAIL_MAX = 300;
export const CHECK_TIMEOUT_DEFAULT_SEC = 120;
export const CHECK_TIMEOUT_MIN_SEC = 1;
export const CHECK_TIMEOUT_MAX_SEC = 600;
export const CHECK_ITEM_MAX = 200;
export const CHECK_COMMAND_MAX = 1000;
export const CHECK_PATTERN_MAX = 300;
export const CHECK_EXPECT_STDOUT_MAX = 4000;
export const CHECK_PATH_MAX = 500;

type AcceptanceCheckRow = {
  id: string;
  task_id: string;
  ticket_id: string | null;
  item: string;
  kind: AcceptanceCheckKind;
  path: string | null;
  pattern: string | null;
  negate: number;
  command: string | null;
  cwd: string | null;
  expect_exit: number | null;
  expect_stdout: string | null;
  timeout_sec: number | null;
  source: "organizer" | "user";
  created_at: string;
  updated_at: string;
  defined_at: string;
  first_passed_at: string | null;
  removed_at: string | null;
};

type AcceptanceCheckRunRow = {
  id: string;
  check_id: string;
  task_id: string;
  cause: AcceptanceCheckRunCause;
  started_at: string;
  finished_at: string | null;
  outcome: AcceptanceCheckOutcome | null;
  exit_code: number | null;
  detail: string;
  output: string | null;
};

/** The fields that define what a check proves — as opposed to `item`/`ticket_id`, which only file it. */
export type CheckDefinition = {
  kind: AcceptanceCheckKind;
  path: string | null;
  pattern: string | null;
  negate: boolean;
  command: string | null;
  cwd: string | null;
  expect_exit: number | null;
  expect_stdout: string | null;
  timeout_sec: number | null;
};

/**
 * A canonical string of everything that makes a check *this* check rather than a differently
 * worded proof of the same line. Two checks with the same key are the same definition — used to
 * drop duplicates and to tell "the wording changed" (runs kept) from "what it proves changed"
 * (runs dropped, `defined_at` bumped).
 */
export function checkDefinitionKey(input: CheckDefinition): string {
  return JSON.stringify([
    input.kind,
    input.path ?? null,
    input.pattern ?? null,
    input.negate ? 1 : 0,
    input.command ?? null,
    input.cwd ?? null,
    input.expect_exit ?? null,
    input.expect_stdout ?? null,
    input.timeout_sec ?? null,
  ]);
}

function rowDefinition(row: AcceptanceCheckRow): CheckDefinition {
  return {
    kind: row.kind,
    path: row.path,
    pattern: row.pattern,
    negate: Boolean(row.negate),
    command: row.command,
    cwd: row.cwd,
    expect_exit: row.expect_exit,
    expect_stdout: row.expect_stdout,
    timeout_sec: row.timeout_sec,
  };
}

function checkRow(ctx: StoreContext, id: string): AcceptanceCheckRow {
  const row = ctx.db.query<AcceptanceCheckRow, [string]>(`SELECT * FROM acceptance_checks WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "check not found");
  return row;
}

function activeCheckRows(ctx: StoreContext, taskId: string): AcceptanceCheckRow[] {
  return ctx.db
    .query<AcceptanceCheckRow, [string]>(
      `SELECT * FROM acceptance_checks WHERE task_id = ? AND removed_at IS NULL ORDER BY created_at ASC, id ASC`,
    )
    .all(taskId);
}

function runRow(ctx: StoreContext, id: string): AcceptanceCheckRunRow {
  const row = ctx.db.query<AcceptanceCheckRunRow, [string]>(`SELECT * FROM acceptance_check_runs WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "check run not found");
  return row;
}

function toRun(row: AcceptanceCheckRunRow): AcceptanceCheckRun {
  return {
    id: row.id,
    check_id: row.check_id,
    task_id: row.task_id,
    cause: row.cause,
    started_at: row.started_at,
    finished_at: row.finished_at,
    outcome: row.outcome,
    exit_code: row.exit_code,
    detail: row.detail,
    output: row.output,
  };
}

function lastFinishedRun(ctx: StoreContext, checkId: string): AcceptanceCheckRunRow | null {
  return (
    ctx.db
      .query<AcceptanceCheckRunRow, [string]>(
        `SELECT * FROM acceptance_check_runs WHERE check_id = ? AND finished_at IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(checkId) ?? null
  );
}

function isRunning(ctx: StoreContext, checkId: string): boolean {
  return Boolean(
    ctx.db.query<{ id: string }, [string]>(`SELECT id FROM acceptance_check_runs WHERE check_id = ? AND finished_at IS NULL LIMIT 1`).get(checkId),
  );
}

function toAcceptanceCheck(ctx: StoreContext, row: AcceptanceCheckRow): AcceptanceCheck {
  const last = lastFinishedRun(ctx, row.id);
  return {
    id: row.id,
    task_id: row.task_id,
    ticket_id: row.ticket_id,
    item: row.item,
    kind: row.kind,
    path: row.path,
    pattern: row.pattern,
    negate: Boolean(row.negate),
    command: row.command,
    cwd: row.cwd,
    expect_exit: row.expect_exit,
    expect_stdout: row.expect_stdout,
    timeout_sec: row.timeout_sec,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
    defined_at: row.defined_at,
    first_passed_at: row.first_passed_at,
    last_run: last ? toRun(last) : null,
    running: isRunning(ctx, row.id),
  };
}

export function getCheck(ctx: StoreContext, id: string): AcceptanceCheck {
  return toAcceptanceCheck(ctx, checkRow(ctx, id));
}

export function getCheckRun(ctx: StoreContext, id: string): AcceptanceCheckRun {
  return toRun(runRow(ctx, id));
}

/** Active checks of a plan, each with its last finished run and whether one is running now. */
export function listChecks(ctx: StoreContext, taskId: string): AcceptanceCheck[] {
  return activeCheckRows(ctx, taskId).map((row) => toAcceptanceCheck(ctx, row));
}

function cleanItem(value: unknown, fallback: string | undefined): string {
  const item = value === undefined ? (fallback ?? "") : normalizeSpecLine(value);
  if (!item) throw new HttpError(422, "invalid_args", "item is required");
  return takeCodePoints(item, CHECK_ITEM_MAX).text;
}

function cleanKind(value: unknown, fallback: AcceptanceCheckKind | undefined): AcceptanceCheckKind {
  const kind = value === undefined ? fallback : value;
  if (typeof kind !== "string" || !(CHECK_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(422, "invalid_args", "kind must be exists, contains, matches, or command");
  }
  return kind as AcceptanceCheckKind;
}

function cleanOptionalString(value: unknown, fallback: string | null | undefined, max: number, field: string): string | null {
  const raw = value === undefined ? (fallback ?? null) : value;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new HttpError(422, "invalid_args", `${field} must be a string`);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return takeCodePoints(trimmed, max).text;
}

function cleanBool(value: unknown, fallback: boolean | undefined): boolean {
  return Boolean(value === undefined ? (fallback ?? false) : value);
}

function cleanNullableInt(value: unknown, fallback: number | null | undefined, field: string, min?: number, max?: number): number | null {
  const raw = value === undefined ? (fallback ?? null) : value;
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw)) throw new HttpError(422, "invalid_args", `${field} must be an integer`);
  if (min !== undefined && raw < min) throw new HttpError(422, "invalid_args", `${field} must be at least ${min}`);
  if (max !== undefined && raw > max) throw new HttpError(422, "invalid_args", `${field} must be at most ${max}`);
  return raw;
}

type NormalizedCheck = {
  item: string;
  ticket_id: string | null;
  kind: AcceptanceCheckKind;
  path: string | null;
  pattern: string | null;
  negate: boolean;
  command: string | null;
  cwd: string | null;
  expect_exit: number | null;
  expect_stdout: string | null;
  timeout_sec: number | null;
};

/**
 * Validates a check's fields against `task` (and, for a redefinition, `base`'s current values for
 * whatever `raw` leaves out). Nothing outside the workspace runs: file kinds need a `path` that
 * resolves inside it, and a command needs `classifyShell` to read it as jailed — both re-checked
 * again at run time, since the workspace can move between now and then.
 */
export function normalizeCheckInput(ctx: StoreContext, task: Task, raw: unknown, base?: AcceptanceCheckRow): NormalizedCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(422, "invalid_args", "body must be an object");
  const row = raw as Record<string, unknown>;

  const item = cleanItem(row.item, base?.item);
  const kind = cleanKind(row.kind, base?.kind);

  let ticketId: string | null;
  if (row.ticket_id === undefined) {
    ticketId = base?.ticket_id ?? null;
  } else if (row.ticket_id === null) {
    ticketId = null;
  } else if (typeof row.ticket_id === "string") {
    ticketId = row.ticket_id;
  } else {
    throw new HttpError(422, "invalid_args", "ticket_id must be a string or null");
  }
  if (ticketId) {
    const owns = ctx.db.query<{ id: string }, [string, string]>(`SELECT id FROM tickets WHERE id = ? AND task_id = ?`).get(ticketId, task.id);
    if (!owns) throw new HttpError(422, "invalid_args", "ticket_id must belong to this plan");
  }

  const path = cleanOptionalString(row.path, base?.path, CHECK_PATH_MAX, "path");
  const pattern = cleanOptionalString(row.pattern, base?.pattern, CHECK_PATTERN_MAX, "pattern");
  const negate = cleanBool(row.negate, base ? Boolean(base.negate) : undefined);
  const command = cleanOptionalString(row.command, base?.command, CHECK_COMMAND_MAX, "command");
  const cwdInput = cleanOptionalString(row.cwd, base?.cwd, CHECK_PATH_MAX, "cwd");
  const expectExit = cleanNullableInt(row.expect_exit, base?.expect_exit, "expect_exit");
  const expectStdout = cleanOptionalString(row.expect_stdout, base?.expect_stdout, CHECK_EXPECT_STDOUT_MAX, "expect_stdout");
  const timeoutSec = cleanNullableInt(row.timeout_sec, base?.timeout_sec, "timeout_sec", CHECK_TIMEOUT_MIN_SEC, CHECK_TIMEOUT_MAX_SEC);

  const root = workspacePath(ctx);

  if (kind === "exists" || kind === "contains" || kind === "matches") {
    if (!path) throw new HttpError(422, "invalid_args", "path is required for a file check");
    if (!root) throw new HttpError(422, "outside_workspace", "no workspace is open");
    let classified;
    try {
      classified = classifyPath(root, path);
    } catch {
      throw new HttpError(422, "outside_workspace", "path must stay inside the workspace");
    }
    if (classified.zone !== "inside") throw new HttpError(422, "outside_workspace", "path must stay inside the workspace");
  }
  if (kind === "contains" || kind === "matches") {
    if (!pattern) throw new HttpError(422, "invalid_args", `pattern is required for a ${kind} check`);
  }
  if (kind === "matches") {
    try {
      void new RegExp(pattern!, "mi");
    } catch {
      throw new HttpError(422, "invalid_args", "pattern does not compile as a regular expression");
    }
  }
  let cwd = cwdInput;
  if (kind === "command") {
    if (!command) throw new HttpError(422, "invalid_args", "command is required for a command check");
    if (!root) throw new HttpError(422, "outside_workspace", "no workspace is open");
    // Relative to the workspace root when not given, like a file check's path: what you see in the file tree.
    const effectiveCwd = cwd ?? ".";
    let classified;
    try {
      classified = classifyShell(root, command, effectiveCwd);
    } catch {
      throw new HttpError(422, "outside_workspace", "command must stay inside the workspace");
    }
    if (classified.kind !== "jailed") throw new HttpError(422, "outside_workspace", "command must stay inside the workspace");
  } else {
    cwd = null;
  }

  return {
    item,
    ticket_id: ticketId,
    kind,
    path: kind === "command" ? null : path,
    pattern: kind === "exists" || kind === "command" ? null : pattern,
    negate: kind === "contains" || kind === "matches" ? negate : false,
    command: kind === "command" ? command : null,
    cwd,
    expect_exit: kind === "command" ? expectExit : null,
    expect_stdout: kind === "command" ? expectStdout : null,
    timeout_sec: kind === "command" ? timeoutSec : null,
  };
}

function activeCount(ctx: StoreContext, taskId: string): number {
  const row = ctx.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM acceptance_checks WHERE task_id = ? AND removed_at IS NULL`).get(taskId);
  return row?.n ?? 0;
}

/** Your own check: create, redefine, remove, run. Source is always `user` — an organizer check you edit is pinned. */
export function createCheckByUser(ctx: StoreContext, taskId: string, raw: unknown, now: Date = new Date(isoNow())): AcceptanceCheck {
  const task = getTask(ctx, taskId);
  if (activeCount(ctx, taskId) >= CHECKS_MAX) throw new HttpError(422, "too_many_checks", `a plan holds at most ${CHECKS_MAX} active checks`);
  const fields = normalizeCheckInput(ctx, task, raw);
  const at = now.toISOString();
  const id = ulid(now.getTime());
  ctx.db.run(
    `INSERT INTO acceptance_checks
       (id, task_id, ticket_id, item, kind, path, pattern, negate, command, cwd, expect_exit, expect_stdout, timeout_sec, source, created_at, updated_at, defined_at, first_passed_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, NULL, NULL)`,
    [
      id,
      task.id,
      fields.ticket_id,
      fields.item,
      fields.kind,
      fields.path,
      fields.pattern,
      fields.negate ? 1 : 0,
      fields.command,
      fields.cwd,
      fields.expect_exit,
      fields.expect_stdout,
      fields.timeout_sec,
      at,
      at,
      at,
    ],
  );
  return getCheck(ctx, id);
}

/**
 * Your edit. Changing only `item` or `ticket_id` keeps the check's runs; changing what it actually
 * proves deletes them, resets `first_passed_at`, and bumps `defined_at` — the runner reads that as
 * "this has never passed yet". Always lands as `source: 'user'`, pinning it against a later
 * organizer run touching it.
 */
export function patchCheckByUser(ctx: StoreContext, checkId: string, raw: unknown, ifRevision?: unknown, now: Date = new Date(isoNow())): AcceptanceCheck {
  const row = checkRow(ctx, checkId);
  if (row.removed_at !== null) throw new HttpError(409, "check_gone", "this check was removed");
  if (ifRevision !== undefined && ifRevision !== null) {
    if (typeof ifRevision !== "string" || ifRevision !== row.updated_at) {
      throw new HttpError(409, "conflict", "check revision changed");
    }
  }
  const task = getTask(ctx, row.task_id);
  const fields = normalizeCheckInput(ctx, task, raw, row);
  const at = now.toISOString();
  const before = checkDefinitionKey(rowDefinition(row));
  const after = checkDefinitionKey(fields);
  const redefined = before !== after;
  ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE acceptance_checks
         SET ticket_id = ?, item = ?, kind = ?, path = ?, pattern = ?, negate = ?, command = ?, cwd = ?,
             expect_exit = ?, expect_stdout = ?, timeout_sec = ?, source = 'user', updated_at = ?,
             defined_at = ?, first_passed_at = ?
       WHERE id = ?`,
      [
        fields.ticket_id,
        fields.item,
        fields.kind,
        fields.path,
        fields.pattern,
        fields.negate ? 1 : 0,
        fields.command,
        fields.cwd,
        fields.expect_exit,
        fields.expect_stdout,
        fields.timeout_sec,
        at,
        redefined ? at : row.defined_at,
        redefined ? null : row.first_passed_at,
        checkId,
      ],
    );
    if (redefined) ctx.db.run(`DELETE FROM acceptance_check_runs WHERE check_id = ?`, [checkId]);
  })();
  return getCheck(ctx, checkId);
}

/** Tombstones the check; its runs stay, so their history still reads. */
export function removeCheckByUser(ctx: StoreContext, checkId: string, now: Date = new Date(isoNow())): void {
  const row = checkRow(ctx, checkId);
  if (row.removed_at !== null) throw new HttpError(409, "check_gone", "this check was already removed");
  const at = now.toISOString();
  ctx.db.run(`UPDATE acceptance_checks SET removed_at = ?, updated_at = ? WHERE id = ?`, [at, at, checkId]);
}

/**
 * Some active check has no finished run since its current definition, or a turn of this plan
 * moved after the newest run started — the quiet-stretch runner reads this to decide whether a
 * plan's checks are worth running again before it settles.
 */
export function checkStale(ctx: StoreContext, taskId: string): boolean {
  const checks = activeCheckRows(ctx, taskId);
  if (checks.length === 0) return false;
  for (const check of checks) {
    const since = ctx.db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM acceptance_check_runs WHERE check_id = ? AND finished_at IS NOT NULL AND started_at >= ? LIMIT 1`,
      )
      .get(check.id, check.defined_at);
    if (!since) return true;
  }
  const newestRun = ctx.db.query<{ at: string | null }, [string]>(`SELECT MAX(started_at) AS at FROM acceptance_check_runs WHERE task_id = ?`).get(taskId);
  const newestTurn = ctx.db.query<{ at: string | null }, [string]>(`SELECT MAX(updated_at) AS at FROM turns WHERE task_id = ?`).get(taskId);
  if (newestTurn?.at && (!newestRun?.at || newestTurn.at > newestRun.at)) return true;
  return false;
}

/** Opens a run: `finished_at` null until `finishCheckRun` closes it. */
export function beginCheckRun(ctx: StoreContext, checkId: string, cause: AcceptanceCheckRunCause, now: Date = new Date(isoNow())): AcceptanceCheckRun {
  const check = checkRow(ctx, checkId);
  const id = ulid(now.getTime());
  const at = now.toISOString();
  ctx.db.run(
    `INSERT INTO acceptance_check_runs (id, check_id, task_id, cause, started_at, finished_at, outcome, exit_code, detail, output)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, '', NULL)`,
    [id, checkId, check.task_id, cause, at],
  );
  return getCheckRun(ctx, id);
}

function pruneCheckRuns(ctx: StoreContext, checkId: string): void {
  const ids = ctx.db
    .query<{ id: string }, [string]>(`SELECT id FROM acceptance_check_runs WHERE check_id = ? ORDER BY started_at DESC, rowid DESC`)
    .all(checkId)
    .map((row) => row.id);
  const stale = ids.slice(CHECK_RUNS_KEPT);
  if (stale.length === 0) return;
  const marks = stale.map(() => "?").join(", ");
  ctx.db.run(`DELETE FROM acceptance_check_runs WHERE id IN (${marks})`, stale);
}

/**
 * Closes a run with its verdict. The first `pass` since the check's `defined_at` stamps
 * `first_passed_at`, once; every close prunes runs past {@link CHECK_RUNS_KEPT}.
 */
export function finishCheckRun(
  ctx: StoreContext,
  runId: string,
  verdict: { outcome: AcceptanceCheckOutcome; exitCode: number | null; detail: string; output: string | null },
  now: Date = new Date(isoNow()),
): AcceptanceCheckRun {
  const run = runRow(ctx, runId);
  const at = now.toISOString();
  const detail = takeCodePoints(verdict.detail, CHECK_DETAIL_MAX).text;
  const output = verdict.output === null || verdict.output === undefined ? null : tailCodePoints(verdict.output, CHECK_OUTPUT_MAX);
  ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE acceptance_check_runs SET finished_at = ?, outcome = ?, exit_code = ?, detail = ?, output = ? WHERE id = ?`,
      [at, verdict.outcome, verdict.exitCode, detail, output, runId],
    );
    if (verdict.outcome === "pass") {
      ctx.db.run(`UPDATE acceptance_checks SET first_passed_at = COALESCE(first_passed_at, ?) WHERE id = ? AND removed_at IS NULL`, [at, run.check_id]);
    }
    pruneCheckRuns(ctx, run.check_id);
  })();
  return getCheckRun(ctx, runId);
}

/**
 * Boot-time cleanup: a run still open (`finished_at` null) when the daemon starts was cut short by
 * the last shutdown, so it closes as `error` rather than staying open forever.
 */
export function recoverInterruptedCheckRuns(ctx: StoreContext): void {
  const now = isoNow();
  const open = ctx.db.query<{ id: string }, []>(`SELECT id FROM acceptance_check_runs WHERE finished_at IS NULL`).all();
  for (const row of open) {
    ctx.db.run(
      `UPDATE acceptance_check_runs SET finished_at = ?, outcome = 'error', detail = ? WHERE id = ?`,
      [now, takeCodePoints("daemon stopped mid-run", CHECK_DETAIL_MAX).text, row.id],
    );
  }
}

/**
 * A plan's `spec.acceptance` lines moved from `before` to `after` (same length): any active check
 * whose `item` was one of the lines that disappeared follows its line to the same position,
 * provided that position's new line was not already one of the old ones — that would be a
 * reshuffle, not a rewording, and the check should stay put (and read as an orphan) instead of
 * jumping to an unrelated line.
 */
export function rebindCheckItems(ctx: StoreContext, taskId: string, before: readonly string[], after: readonly string[], now: string = isoNow()): void {
  if (before.length !== after.length || before.length === 0) return;
  const afterSet = new Set(after);
  const beforeSet = new Set(before);
  for (const check of activeCheckRows(ctx, taskId)) {
    if (afterSet.has(check.item)) continue;
    const idx = before.indexOf(check.item);
    if (idx === -1) continue;
    const candidate = after[idx]!;
    if (beforeSet.has(candidate)) continue;
    ctx.db.run(`UPDATE acceptance_checks SET item = ?, updated_at = ? WHERE id = ?`, [candidate, now, check.id]);
  }
}

/**
 * Whether `command` (in `cwd`) is something the app has actual evidence for in this plan: a turn
 * of this plan ran it — as `shell`, successfully, exit 0, the same command whitespace-normalized,
 * in the same `cwd` (or a run that never recorded one) — or the user typed the exact command into
 * a message filed under the plan. Used by the organizer slice to keep it from inventing a command
 * check nobody actually ran.
 */
export function commandSeenInPlan(ctx: StoreContext, taskId: string, command: string, cwd: string | null): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const stored = takeCodePoints(normalized, TURN_RUN_COMMAND_MAX).text;
  const ran = ctx.db
    .query<{ id: string }, [string, string, string | null]>(
      `SELECT id FROM turn_runs WHERE task_id = ? AND tool = 'shell' AND ok = 1 AND exit_code = 0 AND command = ? AND (cwd = ? OR cwd IS NULL) LIMIT 1`,
    )
    .get(taskId, stored, cwd);
  if (ran) return true;
  const said = ctx.db.query<{ body: string }, [string]>(`SELECT body FROM messages WHERE task_id = ? AND kind = 'user'`).all(taskId);
  return said.some((row) => row.body.includes(command.trim()));
}

/**
 * A check the organizer may write into an answer's top-level `checks` array (see
 * `prompts/organizer.ts`). `id` is either an existing organizer check's id or `new-N`; every other
 * field is optional and, for an existing check, absent means "leave as it is" — the same shape
 * `OrganizerTicketInput` uses for tickets. `ticket` is a ticket id, `new-N`, or null; the store
 * resolves a `new-N` through the same placeholder map the ticket loop built.
 */
export type OrganizerCheckInput = {
  id: string;
  remove?: true;
  item?: string;
  ticket?: string | null;
  kind?: AcceptanceCheckKind;
  path?: string;
  pattern?: string;
  negate?: boolean;
  command?: string;
  cwd?: string;
  expect_exit?: number;
  expect_stdout?: string;
  timeout_sec?: number;
};

const NEW_CHECK = /^new-\d+$/;

/** `OrganizerCheckInput` → the raw shape `normalizeCheckInput` reads, `ticket` resolved and renamed. */
function organizerCheckRaw(entry: OrganizerCheckInput, ticketId: string | null | undefined): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (entry.item !== undefined) raw.item = entry.item;
  if (entry.kind !== undefined) raw.kind = entry.kind;
  if (entry.path !== undefined) raw.path = entry.path;
  if (entry.pattern !== undefined) raw.pattern = entry.pattern;
  if (entry.negate !== undefined) raw.negate = entry.negate;
  if (entry.command !== undefined) raw.command = entry.command;
  if (entry.cwd !== undefined) raw.cwd = entry.cwd;
  if (entry.expect_exit !== undefined) raw.expect_exit = entry.expect_exit;
  if (entry.expect_stdout !== undefined) raw.expect_stdout = entry.expect_stdout;
  if (entry.timeout_sec !== undefined) raw.timeout_sec = entry.timeout_sec;
  if (ticketId !== undefined) raw.ticket_id = ticketId;
  return raw;
}

/** `entry.ticket` resolved through the placeholders a `new-N` ticket got this run; else passed through. */
function resolveCheckTicket(entry: OrganizerCheckInput, placeholders: ReadonlyMap<string, string>): string | null | undefined {
  if (entry.ticket === undefined) return undefined;
  if (entry.ticket === null) return null;
  return placeholders.get(entry.ticket) ?? entry.ticket;
}

function definitionActiveElsewhere(ctx: StoreContext, taskId: string, key: string, excludeId?: string): boolean {
  return activeCheckRows(ctx, taskId).some((row) => row.id !== excludeId && checkDefinitionKey(rowDefinition(row)) === key);
}

/** A definition the user tombstoned on purpose: the organizer must not quietly bring it back. */
function definitionTombstonedByUser(ctx: StoreContext, taskId: string, key: string): boolean {
  return ctx.db
    .query<AcceptanceCheckRow, [string]>(`SELECT * FROM acceptance_checks WHERE task_id = ? AND source = 'user' AND removed_at IS NOT NULL`)
    .all(taskId)
    .some((row) => checkDefinitionKey(rowDefinition(row)) === key);
}

/**
 * What one organizer run does to a plan's checks — new ones proposed, existing organizer checks
 * updated or removed by id — in the same transaction the spec and tickets land in. User checks and
 * ids from another plan are silently dropped, as is anything the store's own validation refuses
 * (`normalizeCheckInput`) or a command with no evidence in this plan (`commandSeenInPlan`). Caps:
 * {@link ORGANIZER_NEW_CHECKS_MAX} new checks per run, {@link CHECKS_MAX} active per plan.
 */
export function applyOrganizerChecks(
  ctx: StoreContext,
  input: { task: Task; entries: readonly OrganizerCheckInput[]; placeholders: ReadonlyMap<string, string>; now: Date },
): void {
  if (input.entries.length === 0) return;
  const at = input.now.toISOString();
  let opened = 0;
  for (const entry of input.entries) {
    const isNew = NEW_CHECK.test(entry.id);
    if (!isNew) {
      let row: AcceptanceCheckRow;
      try {
        row = checkRow(ctx, entry.id);
      } catch {
        continue; // no such check
      }
      if (row.task_id !== input.task.id || row.source !== "organizer" || row.removed_at !== null) continue;
      if (entry.remove) {
        ctx.db.run(`UPDATE acceptance_checks SET removed_at = ?, updated_at = ? WHERE id = ?`, [at, at, row.id]);
        continue;
      }
      const ticketId = resolveCheckTicket(entry, input.placeholders);
      let fields: NormalizedCheck;
      try {
        fields = normalizeCheckInput(ctx, input.task, organizerCheckRaw(entry, ticketId), row);
      } catch {
        continue;
      }
      if (fields.kind === "command" && fields.command && !commandSeenInPlan(ctx, input.task.id, fields.command, fields.cwd)) continue;
      const before = checkDefinitionKey(rowDefinition(row));
      const after = checkDefinitionKey(fields);
      const redefined = before !== after;
      ctx.db.run(
        `UPDATE acceptance_checks
           SET ticket_id = ?, item = ?, kind = ?, path = ?, pattern = ?, negate = ?, command = ?, cwd = ?,
               expect_exit = ?, expect_stdout = ?, timeout_sec = ?, updated_at = ?, defined_at = ?, first_passed_at = ?
         WHERE id = ?`,
        [
          fields.ticket_id,
          fields.item,
          fields.kind,
          fields.path,
          fields.pattern,
          fields.negate ? 1 : 0,
          fields.command,
          fields.cwd,
          fields.expect_exit,
          fields.expect_stdout,
          fields.timeout_sec,
          at,
          redefined ? at : row.defined_at,
          redefined ? null : row.first_passed_at,
          row.id,
        ],
      );
      if (redefined) ctx.db.run(`DELETE FROM acceptance_check_runs WHERE check_id = ?`, [row.id]);
      continue;
    }
    // new-N: an organizer-proposed check, capped both per run and per plan.
    if (entry.remove) continue;
    if (opened >= ORGANIZER_NEW_CHECKS_MAX || activeCount(ctx, input.task.id) >= CHECKS_MAX) continue;
    const ticketId = resolveCheckTicket(entry, input.placeholders);
    let fields: NormalizedCheck;
    try {
      fields = normalizeCheckInput(ctx, input.task, organizerCheckRaw(entry, ticketId));
    } catch {
      continue;
    }
    if (fields.kind === "command" && fields.command && !commandSeenInPlan(ctx, input.task.id, fields.command, fields.cwd)) continue;
    const key = checkDefinitionKey(fields);
    if (definitionActiveElsewhere(ctx, input.task.id, key) || definitionTombstonedByUser(ctx, input.task.id, key)) continue;
    const newId = ulid(input.now.getTime());
    ctx.db.run(
      `INSERT INTO acceptance_checks
         (id, task_id, ticket_id, item, kind, path, pattern, negate, command, cwd, expect_exit, expect_stdout, timeout_sec, source, created_at, updated_at, defined_at, first_passed_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'organizer', ?, ?, ?, NULL, NULL)`,
      [
        newId,
        input.task.id,
        fields.ticket_id,
        fields.item,
        fields.kind,
        fields.path,
        fields.pattern,
        fields.negate ? 1 : 0,
        fields.command,
        fields.cwd,
        fields.expect_exit,
        fields.expect_stdout,
        fields.timeout_sec,
        at,
        at,
        at,
      ],
    );
    opened += 1;
  }
}

/** A check with no finished run at or after its current definition: the runner has not proven it either way yet. */
export function checkNeverRanSinceDefinition(check: Pick<AcceptanceCheck, "defined_at" | "last_run">): boolean {
  return !check.last_run || check.last_run.started_at < check.defined_at;
}

/**
 * Active checks that would keep a plan the organizer called `done` open: ones that failed, or that
 * have not run since their current definition — the same evidence a `done` ticket needs, applied to
 * checks. Used by `applyOrganizerResult` alongside `ticketsHoldingPlanOpen`.
 */
export function checksHoldingPlanOpen(ctx: StoreContext, taskId: string): AcceptanceCheck[] {
  return listChecks(ctx, taskId).filter((check) => checkNeverRanSinceDefinition(check) || check.last_run?.outcome === "fail");
}
