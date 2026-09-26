/**
 * The shape of a plan's spec (要点): what the organizer writes, what the user edits, what every
 * turn reads. A leaf module on purpose — `tasks.ts` needs the type and the parser, and
 * `plan-spec.ts` needs `tasks.ts` — so it imports nothing from the store.
 */
import { takeCodePoints } from "../text";

export type PlanStatus = "active" | "done" | "parked";
export const PLAN_STATUSES: readonly PlanStatus[] = ["active", "done", "parked"];

export type PlanSpec = {
  /** A short label for finding precedents: plans of the same kind. */
  kind: string | null;
  /** What the plan is for now, as the organizer last understood it. */
  goal: string;
  /** What counts as done. */
  acceptance: string[];
  /** Standing constraints and the user's stated preferences. */
  rules: string[];
  /** How the team decided to go about it, and who does which part. */
  process: string[];
  progress: { done: string[]; open: string[]; blocked: string[] };
  status: PlanStatus;
};

export const SPEC_GOAL_MAX = 300;
export const SPEC_KIND_MAX = 40;
export const SPEC_LIST_MAX = 20;
export const SPEC_ITEM_MAX = 200;

function oneLine(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return takeCodePoints(value.replace(/\s+/g, " ").trim(), limit).text;
}

function lines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = oneLine(item, SPEC_ITEM_MAX);
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= SPEC_LIST_MAX) break;
  }
  return out;
}

/**
 * A spec the store will keep: trimmed, clipped, blanks dropped, unknown status read as active.
 * Null when there is no goal to speak of — a plan without a goal is not a plan.
 */
export function normalizePlanSpec(raw: unknown): PlanSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const goal = oneLine(row.goal, SPEC_GOAL_MAX);
  if (!goal) return null;
  const kind = oneLine(row.kind, SPEC_KIND_MAX) || null;
  const progressRaw =
    row.progress && typeof row.progress === "object" && !Array.isArray(row.progress)
      ? (row.progress as Record<string, unknown>)
      : {};
  const statusRaw = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  const status = (PLAN_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as PlanStatus) : "active";
  return {
    kind,
    goal,
    acceptance: lines(row.acceptance),
    rules: lines(row.rules),
    process: lines(row.process),
    progress: { done: lines(progressRaw.done), open: lines(progressRaw.open), blocked: lines(progressRaw.blocked) },
    status,
  };
}

/** The stored JSON read back. Never throws: a row a bug wrote badly reads as "no spec yet". */
export function parsePlanSpec(json: string | null | undefined): PlanSpec | null {
  if (!json) return null;
  try {
    return normalizePlanSpec(JSON.parse(json));
  } catch {
    return null;
  }
}

/** What a plan looks like before the organizer has said anything: its opening request as the goal. */
export function emptyPlanSpec(brief: string): PlanSpec {
  return {
    kind: null,
    goal: oneLine(brief, SPEC_GOAL_MAX) || "…",
    acceptance: [],
    rules: [],
    process: [],
    progress: { done: [], open: [], blocked: [] },
    status: "active",
  };
}

export function specEquals(a: PlanSpec | null, b: PlanSpec | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
