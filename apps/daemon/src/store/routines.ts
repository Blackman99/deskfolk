import { type Routine } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { dueIso, isWeekday, latestDueAt, parseClockTime } from "../schedule";
import {
  aliveBot,
  requireNonEmpty,
  requireString,
  type BotRow,
  type RoutineRow,
  type StoreContext,
} from "./shared";

export function toRoutine(row: RoutineRow): Routine {
  const schedule: Routine["schedule"] =
    row.schedule_kind === "weekly"
      ? { kind: "weekly", time: row.schedule_time, weekdays: JSON.parse(row.weekdays ?? "[]") }
      : { kind: "daily", time: row.schedule_time };
  return {
    id: row.id,
    bot_id: row.bot_id,
    title: row.title,
    instruction: row.instruction,
    schedule,
    enabled: row.enabled === 1,
    last_fired_for_due_at: row.last_fired_for_due_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function parseSchedule(schedule: Routine["schedule"] | undefined): Routine["schedule"] {
  if (!schedule || (schedule.kind !== "daily" && schedule.kind !== "weekly")) {
    throw new HttpError(422, "invalid_args", "schedule.kind must be daily or weekly");
  }
  if (!parseClockTime(schedule.time)) {
    throw new HttpError(422, "invalid_args", "schedule.time must be HH:MM");
  }
  if (schedule.kind === "weekly") {
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) {
      throw new HttpError(422, "invalid_args", "weekly schedule needs weekdays");
    }
    const weekdays = [...new Set(schedule.weekdays)];
    if (!weekdays.every(isWeekday)) {
      throw new HttpError(422, "invalid_args", "weekdays must be mon..sun");
    }
    return { kind: "weekly", time: schedule.time, weekdays };
  }
  return { kind: "daily", time: schedule.time };
}

export function listRoutines(ctx: StoreContext): Routine[] {
  return ctx.db
    .query<RoutineRow, []>(`SELECT * FROM routines ORDER BY created_at ASC`)
    .all()
    .map(toRoutine);
}

export function createRoutine(
  ctx: StoreContext,
  input: {
    bot_id: string;
    title: string;
    instruction: string;
    schedule: Routine["schedule"];
    enabled?: boolean;
  },
): Routine {
  aliveBot(ctx, input.bot_id);
  const title = requireNonEmpty("title", input.title);
  const instruction = requireString("instruction", input.instruction);
  const schedule = parseSchedule(input.schedule);
  const now = isoNow();
  const id = ulid();
  ctx.db.run(
    `INSERT INTO routines
      (id, bot_id, title, instruction, schedule_kind, schedule_time, weekdays, enabled, last_fired_for_due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      input.bot_id,
      title,
      instruction,
      schedule.kind,
      schedule.time,
      schedule.kind === "weekly" ? JSON.stringify(schedule.weekdays) : null,
      input.enabled === false ? 0 : 1,
      now,
      now,
    ],
  );
  return listRoutines(ctx).find((r) => r.id === id)!;
}

export function patchRoutine(
  ctx: StoreContext,
  id: string,
  patch: Partial<{ title: string; instruction: string; schedule: Routine["schedule"]; enabled: boolean }>,
): Routine {
  const current = ctx.db.query<RoutineRow, [string]>(`SELECT * FROM routines WHERE id = ?`).get(id);
  if (!current) throw new HttpError(404, "not_found", "routine not found");
  const title = patch.title !== undefined ? requireNonEmpty("title", patch.title) : current.title;
  const instruction =
    patch.instruction !== undefined ? requireString("instruction", patch.instruction) : current.instruction;
  const schedule = patch.schedule ? parseSchedule(patch.schedule) : toRoutine(current).schedule;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
  const now = isoNow();
  ctx.db.run(
    `UPDATE routines SET title = ?, instruction = ?, schedule_kind = ?, schedule_time = ?, weekdays = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    [
      title,
      instruction,
      schedule.kind,
      schedule.time,
      schedule.kind === "weekly" ? JSON.stringify(schedule.weekdays) : null,
      enabled,
      now,
      id,
    ],
  );
  return listRoutines(ctx).find((r) => r.id === id)!;
}

export function deleteRoutine(ctx: StoreContext, id: string): void {
  const deleted = ctx.db.query("DELETE FROM routines WHERE id = ? RETURNING id").get(id);
  if (!deleted) throw new HttpError(404, "not_found", "routine not found");
}

export function getRoutine(ctx: StoreContext, id: string): Routine {
  const row = ctx.db.query<RoutineRow, [string]>(`SELECT * FROM routines WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "routine not found");
  return toRoutine(row);
}

/**
 * If this routine is due and the cursor is behind that due, stamp
 * `last_fired_for_due_at` and return the claimed row. Concurrent ticks
 * lose the compare-and-set and skip.
 */
export function claimRoutineDue(ctx: StoreContext, id: string, now: Date = new Date()): Routine | null {
  const row = ctx.db.query<RoutineRow, [string]>(`SELECT * FROM routines WHERE id = ?`).get(id);
  if (!row || row.enabled !== 1) return null;
  const bot = ctx.db.query<BotRow, [string]>(`SELECT * FROM bots WHERE id = ?`).get(row.bot_id);
  if (!bot || bot.deleted_at || bot.archived_at) return null;
  const routine = toRoutine(row);
  const createdAt = new Date(row.created_at);
  if (Number.isNaN(createdAt.getTime())) return null;
  const due = latestDueAt(routine.schedule, now, createdAt);
  if (!due) return null;
  const dueAt = dueIso(due);
  if (row.last_fired_for_due_at && row.last_fired_for_due_at >= dueAt) return null;
  const stamped = isoNow();
  const claimed = ctx.db.query(
    `UPDATE routines SET last_fired_for_due_at = ?, updated_at = ?
     WHERE id = ? AND enabled = 1
       AND (last_fired_for_due_at IS NULL OR last_fired_for_due_at < ?) RETURNING id`,
  ).get(dueAt, stamped, id, dueAt);
  if (!claimed) return null;
  return getRoutine(ctx, id);
}
