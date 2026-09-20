import type { Routine, RoutineSchedule } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type RoutineDraft = {
  title: string;
  instruction: string;
  kind: "daily" | "weekly";
  time: string;
  weekdays: string[];
  enabled: boolean;
};

export function routineDraft(row?: Routine): RoutineDraft {
  return {
    title: row?.title ?? "", instruction: row?.instruction ?? "",
    kind: row?.schedule.kind ?? "daily", time: row?.schedule.time ?? "09:00",
    weekdays: row?.schedule.kind === "weekly" ? [...row.schedule.weekdays] : [],
    enabled: row?.enabled ?? true,
  };
}

export function routineDirty(draft: RoutineDraft, row: Routine): boolean {
  return JSON.stringify(draft) !== JSON.stringify(routineDraft(row));
}

export function planRoutine(draft: RoutineDraft, t: Copy) {
  const errors: { title?: string; time?: string; weekdays?: string } = {};
  if (!draft.title.trim()) errors.title = t.routines.nameRequired;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) errors.time = t.routines.timeInvalid;
  if (draft.kind === "weekly" && (!draft.weekdays.length || draft.weekdays.some((day) => !WEEKDAYS.includes(day as typeof WEEKDAYS[number])))) {
    errors.weekdays = t.routines.daysRequired;
  }
  const schedule: RoutineSchedule = draft.kind === "daily"
    ? { kind: "daily", time: draft.time }
    : { kind: "weekly", time: draft.time, weekdays: WEEKDAYS.filter((day) => draft.weekdays.includes(day)) };
  return { errors, body: { title: draft.title.trim(), instruction: draft.instruction, schedule, enabled: draft.enabled } };
}

export function routineError(status: number, t: Copy): string {
  if (status === 409) return t.routines.conflict;
  if (status === 404) return t.routines.missing;
  if (status === 422) return t.routines.invalid;
  if (status === 0) return t.routines.disconnected;
  return t.routines.failed;
}

export function routineScheduleLabel(schedule: RoutineSchedule, t: Copy): string {
  const days = schedule.kind === "daily" ? t.routines.daily : WEEKDAYS.filter((day) => schedule.weekdays.includes(day)).map((day) => t.routines.days[day]).join(", ");
  return `${days} · ${schedule.time}`;
}
