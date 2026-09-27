/**
 * What a turn actually ran: each shell command with how it exited, and each MCP call. A Bot's
 * closing words say what it did; these rows say what it ran, so the closing check and the
 * organizer can tell "the tests pass" from a test run that passed. Written as each call finishes,
 * so a turn that is redirected or interrupted keeps its record.
 */
import { isoNow, ulid } from "../ids";
import { takeCodePoints } from "../text";
import { type StoreContext } from "./shared";

export type TurnRun = {
  id: string;
  turn_id: string;
  session_id: string;
  task_id: string | null;
  ticket_id: string | null;
  bot_id: string;
  /** `shell`, or the MCP tool's model-facing name. */
  tool: string;
  /** The command line, or the MCP call's arguments, clipped. */
  command: string;
  exit_code: number | null;
  ok: number;
  /** The tool error's code when it failed without an exit code (a timeout, a refusal). */
  error: string | null;
  created_at: string;
};

/** Rows one turn keeps; a turn past this is looping, and its first runs say more than its last. */
export const TURN_RUNS_PER_TURN = 80;
export const TURN_RUN_COMMAND_MAX = 300;

export function recordTurnRun(
  ctx: StoreContext,
  input: { turnId: string; tool: string; command: string; exitCode: number | null; ok: boolean; error?: string | null; now?: Date },
): void {
  const turn = ctx.db
    .query<{ session_id: string; task_id: string | null; ticket_id: string | null; bot_id: string }, [string]>(
      `SELECT session_id, task_id, ticket_id, bot_id FROM turns WHERE id = ?`,
    )
    .get(input.turnId);
  if (!turn) return;
  const count = ctx.db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM turn_runs WHERE turn_id = ?`)
    .get(input.turnId);
  if ((count?.n ?? 0) >= TURN_RUNS_PER_TURN) return;
  // The store's clock, not the wall's: `isoNow` runs a little ahead in a burst, and a run stamped
  // behind the spec revision it followed would drop out of "since the last version".
  const at = input.now ?? new Date(isoNow());
  const command = takeCodePoints(input.command.replace(/\s+/g, " ").trim(), TURN_RUN_COMMAND_MAX).text;
  ctx.db.run(
    `INSERT INTO turn_runs (id, turn_id, session_id, task_id, ticket_id, bot_id, tool, command, exit_code, ok, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ulid(at.getTime()),
      input.turnId,
      turn.session_id,
      turn.task_id,
      turn.ticket_id,
      turn.bot_id,
      input.tool,
      command,
      input.exitCode,
      input.ok ? 1 : 0,
      input.error ?? null,
      at.toISOString(),
    ],
  );
}

/** One turn's runs, oldest first. */
export function turnRuns(ctx: StoreContext, turnId: string, limit = TURN_RUNS_PER_TURN): TurnRun[] {
  return ctx.db
    .query<TurnRun, [string, number]>(`SELECT * FROM turn_runs WHERE turn_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?`)
    .all(turnId, limit);
}

/** A plan's runs after `since`, newest `limit` of them, oldest first. */
export function taskRunsSince(ctx: StoreContext, taskId: string, since: string, limit: number): TurnRun[] {
  return ctx.db
    .query<TurnRun, [string, string, number]>(
      `SELECT id, turn_id, session_id, task_id, ticket_id, bot_id, tool, command, exit_code, ok, error, created_at FROM (
         SELECT rowid AS seq_, * FROM turn_runs WHERE task_id = ? AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       ) ORDER BY created_at ASC, seq_ ASC`,
    )
    .all(taskId, since, limit);
}
