/**
 * 引擎 (Playbook, ADR 0085): which of the app's own calls run around a conversation, and their
 * thresholds. The skeleton — lines taken in order, a stop that is a stop, filing before waking, the
 * work items — stays code; an engine only says which steps hung on it run and with what numbers.
 * Prompts and models stay global (ADR 0064, ADR 0077), shown beside the steps that use them.
 *
 * Three engines are built in. What you change is kept as a diff from the built-in it is based on,
 * so a field you never touched follows a new default when the app is updated, and "differs from
 * built-in" and resetting a step come straight from the diff. Not the same thing as the engine
 * level (`engine_level`, ADR 0040), which is how far a data folder has been migrated.
 */
import type { BuiltinModelRole } from "./models.ts";

/** Where a step hangs: what sets it off, in the order Roles draws them. */
export const PLAYBOOK_HOOKS = ["line", "group", "turn", "handed_in", "accepted", "overturned", "compose"] as const;
export type PlaybookHook = (typeof PLAYBOOK_HOOKS)[number];

export const PLAYBOOK_STEP_IDS = [
  "intake",
  "reader",
  "scribe",
  "judgement",
  "pacing",
  "compaction",
  "closing",
  "settle",
  "check_backs",
  "pickup",
  "checks",
  "escalation",
  "ceiling",
  "retrospective",
  "reflection",
  "composer",
] as const;
export type PlaybookStepId = (typeof PLAYBOOK_STEP_IDS)[number];

export type PlaybookParamUnit = "s" | "min" | "count" | "hops";

/** One number a step runs with: an integer in [min, max]. */
export type PlaybookParamSpec = { key: string; unit: PlaybookParamUnit; min: number; max: number; step: number; default: number };

export type PlaybookStepSpec = {
  id: PlaybookStepId;
  hook: PlaybookHook;
  /** The built-in call it makes, whose model and prompts are set on Roles; null when it makes none of its own. */
  role: BuiltinModelRole | null;
  /** Whether an engine may switch it off. A locked step always runs; its numbers can still change. */
  switchable: boolean;
  params: readonly PlaybookParamSpec[];
};

/** Every step an engine has, in the order Roles walks them; defaults are what the app ran before engines. */
export const PLAYBOOK_STEPS: readonly PlaybookStepSpec[] = [
  { id: "intake", hook: "line", role: null, switchable: false, params: [{ key: "cap_s", unit: "s", min: 5, max: 300, step: 5, default: 45 }] },
  { id: "reader", hook: "line", role: "reader", switchable: false, params: [] },
  { id: "scribe", hook: "line", role: "scribe", switchable: true, params: [{ key: "adds_max", unit: "count", min: 1, max: 20, step: 1, default: 8 }] },
  { id: "judgement", hook: "group", role: "judgement", switchable: false, params: [] },
  {
    id: "pacing", hook: "turn", role: null, switchable: false, params: [
      { key: "check_in_hops", unit: "hops", min: 10, max: 200, step: 5, default: 40 },
      { key: "hop_limit", unit: "hops", min: 20, max: 400, step: 10, default: 160 },
    ],
  },
  { id: "compaction", hook: "turn", role: "compaction", switchable: false, params: [] },
  { id: "closing", hook: "turn", role: null, switchable: true, params: [] },
  { id: "settle", hook: "turn", role: "organizer", switchable: true, params: [{ key: "quiet_s", unit: "s", min: 10, max: 600, step: 10, default: 30 }] },
  {
    id: "check_backs", hook: "turn", role: null, switchable: false, params: [
      { key: "min_minutes", unit: "min", min: 1, max: 120, step: 1, default: 5 },
      { key: "per_hour", unit: "count", min: 1, max: 20, step: 1, default: 6 },
    ],
  },
  {
    id: "pickup", hook: "turn", role: null, switchable: false, params: [
      { key: "orphan_quiet_min", unit: "min", min: 1, max: 60, step: 1, default: 2 },
      { key: "pickups_per_hour", unit: "count", min: 1, max: 12, step: 1, default: 3 },
    ],
  },
  { id: "checks", hook: "handed_in", role: "judge", switchable: true, params: [] },
  { id: "escalation", hook: "handed_in", role: null, switchable: true, params: [{ key: "after_failures", unit: "count", min: 1, max: 10, step: 1, default: 2 }] },
  {
    id: "ceiling", hook: "handed_in", role: null, switchable: false, params: [
      { key: "streak", unit: "count", min: 2, max: 10, step: 1, default: 3 },
      { key: "attempts", unit: "count", min: 2, max: 20, step: 1, default: 6 },
    ],
  },
  { id: "retrospective", hook: "accepted", role: "retrospective", switchable: true, params: [] },
  { id: "reflection", hook: "overturned", role: "reflection", switchable: true, params: [] },
  { id: "composer", hook: "compose", role: "composer", switchable: false, params: [] },
];

export function playbookStep(id: PlaybookStepId): PlaybookStepSpec {
  return PLAYBOOK_STEPS.find((step) => step.id === id)!;
}

export function isPlaybookStepId(value: unknown): value is PlaybookStepId {
  return typeof value === "string" && (PLAYBOOK_STEP_IDS as readonly string[]).includes(value);
}

/** One step as an engine runs it. */
export type PlaybookStepSetting = { on: boolean; params: Record<string, number> };
export type PlaybookResolved = Record<PlaybookStepId, PlaybookStepSetting>;

/** What an engine changes from what it is based on; only what differs. */
export type PlaybookStepDiff = { on?: boolean; params?: Record<string, number> };
export type PlaybookDiff = { v: 1; steps: Partial<Record<PlaybookStepId, PlaybookStepDiff>> };

export const BUILTIN_PLAYBOOK_IDS = ["general", "video", "coding"] as const;
export type BuiltinPlaybookId = (typeof BUILTIN_PLAYBOOK_IDS)[number];
/** The engine a conversation runs when neither it nor Settings names one. */
export const DEFAULT_PLAYBOOK_ID: BuiltinPlaybookId = "general";

export function isBuiltinPlaybookId(value: unknown): value is BuiltinPlaybookId {
  return typeof value === "string" && (BUILTIN_PLAYBOOK_IDS as readonly string[]).includes(value);
}

export function emptyPlaybookDiff(): PlaybookDiff {
  return { v: 1, steps: {} };
}

/** The three built-in engines, each as what it changes from the defaults above. */
export const BUILTIN_PLAYBOOKS: Record<BuiltinPlaybookId, PlaybookDiff> = {
  general: emptyPlaybookDiff(),
  video: emptyPlaybookDiff(),
  coding: emptyPlaybookDiff(),
};

/** What every step runs with before any engine changes it. */
export function playbookDefaults(): PlaybookResolved {
  const out = {} as PlaybookResolved;
  for (const step of PLAYBOOK_STEPS) {
    out[step.id] = { on: true, params: Object.fromEntries(step.params.map((param) => [param.key, param.default])) };
  }
  return out;
}

function applyDiff(base: PlaybookResolved, diff: PlaybookDiff | null | undefined): PlaybookResolved {
  const out = {} as PlaybookResolved;
  for (const step of PLAYBOOK_STEPS) {
    const from = base[step.id];
    const change = diff?.steps[step.id];
    out[step.id] = {
      on: step.switchable && typeof change?.on === "boolean" ? change.on : from.on,
      params: { ...from.params, ...(change?.params ?? {}) },
    };
  }
  return out;
}

/** What a built-in engine runs. */
export function builtinPlaybook(id: BuiltinPlaybookId): PlaybookResolved {
  return applyDiff(playbookDefaults(), BUILTIN_PLAYBOOKS[id]);
}

/** What an engine runs: its built-in, with your changes over it. */
export function resolvePlaybook(base: BuiltinPlaybookId, diff: PlaybookDiff | null | undefined): PlaybookResolved {
  return applyDiff(builtinPlaybook(base), diff);
}

export class PlaybookDiffError extends Error {}

/**
 * A diff as the API takes it: known steps only, `on` only on a step that can be switched off, known
 * numbers only, each an integer in its range; the check-in comes before the hop limit. Throws
 * {@link PlaybookDiffError} with what is wrong.
 */
export function validatePlaybookDiff(value: unknown, base: BuiltinPlaybookId): PlaybookDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlaybookDiffError("diff must be an object");
  const raw = value as { v?: unknown; steps?: unknown };
  if (raw.v !== undefined && raw.v !== 1) throw new PlaybookDiffError("diff.v must be 1");
  const steps = raw.steps ?? {};
  if (!steps || typeof steps !== "object" || Array.isArray(steps)) throw new PlaybookDiffError("diff.steps must be an object");
  const out: PlaybookDiff = emptyPlaybookDiff();
  for (const [id, change] of Object.entries(steps as Record<string, unknown>)) {
    if (!isPlaybookStepId(id)) throw new PlaybookDiffError(`unknown step: ${id}`);
    const spec = playbookStep(id);
    if (!change || typeof change !== "object" || Array.isArray(change)) throw new PlaybookDiffError(`${id} must be an object`);
    const { on, params, ...rest } = change as { on?: unknown; params?: unknown };
    if (Object.keys(rest).length > 0) throw new PlaybookDiffError(`${id}: unknown field ${Object.keys(rest)[0]}`);
    const kept: PlaybookStepDiff = {};
    if (on !== undefined) {
      if (typeof on !== "boolean") throw new PlaybookDiffError(`${id}.on must be true or false`);
      if (!spec.switchable) throw new PlaybookDiffError(`${id} always runs; it cannot be switched off`);
      kept.on = on;
    }
    if (params !== undefined) {
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new PlaybookDiffError(`${id}.params must be an object`);
      const numbers: Record<string, number> = {};
      for (const [key, number] of Object.entries(params as Record<string, unknown>)) {
        const param = spec.params.find((candidate) => candidate.key === key);
        if (!param) throw new PlaybookDiffError(`${id}: unknown number ${key}`);
        if (typeof number !== "number" || !Number.isInteger(number) || number < param.min || number > param.max) {
          throw new PlaybookDiffError(`${id}.${key} must be a whole number from ${param.min} to ${param.max}`);
        }
        numbers[key] = number;
      }
      if (Object.keys(numbers).length > 0) kept.params = numbers;
    }
    if (kept.on !== undefined || kept.params) out.steps[id] = kept;
  }
  const resolved = resolvePlaybook(base, out);
  if (resolved.pacing.params.check_in_hops! >= resolved.pacing.params.hop_limit!) {
    throw new PlaybookDiffError("pacing.check_in_hops must be below pacing.hop_limit");
  }
  return compactPlaybookDiff(base, out);
}

/** A diff with only what differs from the built-in left in it. */
export function compactPlaybookDiff(base: BuiltinPlaybookId, diff: PlaybookDiff): PlaybookDiff {
  const builtin = builtinPlaybook(base);
  const out = emptyPlaybookDiff();
  for (const step of PLAYBOOK_STEPS) {
    const change = diff.steps[step.id];
    if (!change) continue;
    const kept: PlaybookStepDiff = {};
    if (change.on !== undefined && change.on !== builtin[step.id].on) kept.on = change.on;
    const params = Object.fromEntries(Object.entries(change.params ?? {}).filter(([key, value]) => builtin[step.id].params[key] !== value));
    if (Object.keys(params).length > 0) kept.params = params;
    if (kept.on !== undefined || kept.params) out.steps[step.id] = kept;
  }
  return out;
}

/** An engine as the API shows it. */
export type Playbook = {
  /** A built-in's own id (`general`, `video`, `coding`), or a custom engine's. */
  id: string;
  builtin: boolean;
  /** The built-in it is based on: itself for a built-in. */
  base_id: BuiltinPlaybookId;
  /** A custom engine's name; null for a built-in, which the app names. */
  name: string | null;
  /** How many times it has been changed; 0 is as built in. */
  revision: number;
  /** The latest change, for `if_revision`; null when never changed. */
  revision_id: string | null;
  /** What you changed from the built-in. */
  diff: PlaybookDiff;
  /** What it runs. */
  resolved: PlaybookResolved;
  updated_at: string | null;
};

export type PlaybookRevisionOp = "create" | "edit" | "reset" | "rename" | "delete";

/** One change to an engine, kept for its history; never rewritten. */
export type PlaybookRevision = {
  id: string;
  playbook_id: string;
  revision: number;
  op: PlaybookRevisionOp;
  /** `user`, `app`, or the id of the Bot that proposed it. */
  actor: string;
  bot_id: string | null;
  turn_id: string | null;
  approval_id: string | null;
  message_id: string | null;
  reason: string | null;
  before: { name: string | null; diff: PlaybookDiff } | null;
  after: { name: string | null; diff: PlaybookDiff } | null;
  created_at: string;
};

export type PlaybookList = {
  /** The engine a conversation runs unless it names one (Settings). */
  default_id: string;
  items: Playbook[];
};
