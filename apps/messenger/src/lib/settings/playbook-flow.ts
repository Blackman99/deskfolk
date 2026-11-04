/**
 * The engine map on Roles (ADR 0085), laid out like the flow board: one round per thing that sets
 * steps off (your line, a group line, a Bot's turn, a hand-in…), its root card on top and its steps
 * under it, each joined to the root by a curve. Where every round's steps fit across, each round
 * fans out in a row under its root; otherwise every round hangs its steps down a spine on the left,
 * as an outline does — one way for the whole map. Pure: sizes in, boxes and paths out, so it is
 * tested without a DOM.
 */
import {
  BUILTIN_MODEL_ROLES,
  PLAYBOOK_HOOKS,
  PLAYBOOK_STEPS,
  playbookStep,
  isCustomStepId,
  type BuiltinModelRole,
  type CustomStepAt,
  type CustomStepView,
  type PlaybookHook,
  type PlaybookParamSpec,
  type PlaybookResolved,
  type PlaybookStepId,
} from "@real-bot/protocol";

/** The id of a step of your own (ADR 0105). */
export type CustomNodeId = `u_${string}`;

/** A node of the map: an engine step, a step of your own, or a Bot's turn itself (its model ladder). */
export type PlaybookNodeId = PlaybookStepId | "turn" | CustomNodeId;

export function isCustomNode(node: unknown): node is CustomNodeId {
  return isCustomStepId(node);
}

/** The round a step of your own hangs in, by the moment it runs at. */
export function hookOfMoment(at: CustomStepAt): PlaybookHook {
  return at === "before_effect" || at === "after_effect" || at === "turn_end" ? "turn" : at;
}

/** The rounds a step of your own can be added to, in the map's order. */
export const CUSTOM_HOOKS: readonly PlaybookHook[] = ["turn", "handed_in", "accepted", "overturned"];

export const PLAYBOOK_ROUNDS: ReadonlyArray<{ hook: PlaybookHook; steps: readonly PlaybookStepId[] }> = PLAYBOOK_HOOKS.map((hook) => ({
  hook,
  steps: PLAYBOOK_STEPS.filter((step) => step.hook === hook).map((step) => step.id),
}));

/** The ids of an engine's steps of your own that hang in a round, in the order given. */
function ownIn(own: readonly Pick<CustomStepView, "id" | "at">[], hook: PlaybookHook): CustomNodeId[] {
  return own.filter((step) => hookOfMoment(step.at) === hook).map((step) => step.id as CustomNodeId);
}

/** Every node of an engine in the order ↑ and ↓ walk them: each round's root that can be picked, then its steps, its own after the built-in. */
export function playbookOrder(own: readonly Pick<CustomStepView, "id" | "at">[] = []): PlaybookNodeId[] {
  return PLAYBOOK_ROUNDS.flatMap((round) => [
    ...(round.hook === "turn" ? (["turn"] as const) : []),
    ...round.steps,
    ...ownIn(own, round.hook),
  ]);
}

/** The order for an engine with no steps of its own. */
export const PLAYBOOK_ORDER: readonly PlaybookNodeId[] = playbookOrder();

export const ROOT_W = 196;
export const ROOT_H = 38;
export const STEP_W = 184;
export const STEP_H = 54;
const GAP_X = 14;
const GAP_Y = 30;
const ROW_GAP = 12;
const ROUND_GAP = 26;
const PAD = 16;
/** How far right of the spine a step hangs when the round does not fit across. */
const INDENT = 26;
/** How wide a step hung down the spine grows with the room it has, and how far it gives way. */
const SPINE_STEP_MAX = 320;
const SPINE_STEP_MIN = 150;

export type PlaybookCard = {
  id: string;
  /** The node it stands for; null for a root that is only a label (your line, a hand-in…). */
  node: PlaybookNodeId | null;
  hook: PlaybookHook;
  /** `add` is the round's last card, which starts a step of your own. */
  kind: "root" | "step" | "add";
  x: number;
  y: number;
  w: number;
  h: number;
};
export type PlaybookEdge = { from: string; to: string; d: string };
export type PlaybookLayout = {
  width: number;
  height: number;
  /** Where each round starts. */
  rounds: Array<{ hook: PlaybookHook; y: number }>;
  cards: PlaybookCard[];
  edges: PlaybookEdge[];
};

const down = (x1: number, y1: number, x2: number, y2: number): string => {
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
};
const elbow = (x1: number, y1: number, x2: number, y2: number): string => `M ${x1} ${y1} L ${x1} ${y2 - 8} Q ${x1} ${y2}, ${x1 + 8} ${y2} L ${x2} ${y2}`;

/**
 * The map for a canvas `available` px wide. `own` are the engine's steps of your own, each in the
 * round of its moment after the built-in steps; `addable` ends the rounds that can take one with a
 * card to add another.
 */
export function layPlaybookFlow(available: number, own: readonly Pick<CustomStepView, "id" | "at">[] = [], addable = false): PlaybookLayout {
  const width = Math.max(available, ROOT_W + 2 * PAD, SPINE_STEP_MIN + INDENT + 2 * PAD);
  const inner = width - 2 * PAD;
  const across = Math.max(1, Math.floor((inner + GAP_X) / (STEP_W + GAP_X)));
  const rowsOf = PLAYBOOK_ROUNDS.map((round) => {
    const cards: Array<{ id: string; node: PlaybookNodeId | null; kind: "step" | "add" }> = [
      ...round.steps.map((id) => ({ id: id as string, node: id as PlaybookNodeId, kind: "step" as const })),
      ...ownIn(own, round.hook).map((id) => ({ id: id as string, node: id as PlaybookNodeId, kind: "step" as const })),
    ];
    if (addable && CUSTOM_HOOKS.includes(round.hook)) cards.push({ id: `add:${round.hook}`, node: null, kind: "add" });
    return cards;
  });
  const fans = rowsOf.every((row) => row.length <= across);
  const cards: PlaybookCard[] = [];
  const edges: PlaybookEdge[] = [];
  const rounds: PlaybookLayout["rounds"] = [];
  let y = PAD;
  for (const [at, round] of PLAYBOOK_ROUNDS.entries()) {
    const row = rowsOf[at]!;
    rounds.push({ hook: round.hook, y });
    const rootX = fans ? PAD + (inner - ROOT_W) / 2 : PAD;
    // The Bot's turn says what it runs on under its name: as tall as a step.
    const rootH = round.hook === "turn" ? STEP_H : ROOT_H;
    const root: PlaybookCard = {
      id: round.hook === "turn" ? "turn" : `root:${round.hook}`,
      node: round.hook === "turn" ? "turn" : null,
      hook: round.hook,
      kind: "root",
      x: rootX,
      y,
      w: ROOT_W,
      h: rootH,
    };
    cards.push(root);
    y += rootH + GAP_Y;
    if (fans) {
      const span = row.length * STEP_W + (row.length - 1) * GAP_X;
      let x = PAD + (inner - span) / 2;
      for (const step of row) {
        cards.push({ id: step.id, node: step.node, hook: round.hook, kind: step.kind, x, y, w: STEP_W, h: STEP_H });
        if (step.kind === "step") edges.push({ from: root.id, to: step.id, d: down(root.x + ROOT_W / 2, root.y + rootH, x + STEP_W / 2, y) });
        x += STEP_W + GAP_X;
      }
      if (row.length > 0) y += STEP_H;
      else y -= GAP_Y;
    } else {
      const spine = root.x + 14;
      y -= GAP_Y - ROW_GAP;
      for (const step of row) {
        const x = PAD + INDENT;
        cards.push({ id: step.id, node: step.node, hook: round.hook, kind: step.kind, x, y, w: Math.max(SPINE_STEP_MIN, Math.min(SPINE_STEP_MAX, width - PAD - x)), h: STEP_H });
        if (step.kind === "step") edges.push({ from: root.id, to: step.id, d: elbow(spine, root.y + rootH, x, y + STEP_H / 2) });
        y += STEP_H + ROW_GAP;
      }
      y -= ROW_GAP;
    }
    y += ROUND_GAP;
  }
  return { width, height: y - ROUND_GAP + PAD, rounds, cards, edges };
}

/** The built-in call a step makes, for its model and prompts; null when it makes none of its own. */
export function stepRole(node: PlaybookNodeId): BuiltinModelRole | null {
  if (node === "turn" || isCustomNode(node)) return null;
  return PLAYBOOK_STEPS.find((step) => step.id === node)?.role ?? null;
}

/** The step a call belongs to, for a link that names the call (「改这个调用」 on the flow); null for the call a step of your own makes, which belongs to every such step. */
export function stepOfRole(role: BuiltinModelRole): PlaybookStepId | null {
  return PLAYBOOK_STEPS.find((step) => step.role === role)?.id ?? null;
}

export function isBuiltinRole(value: unknown): value is BuiltinModelRole {
  return typeof value === "string" && (BUILTIN_MODEL_ROLES as readonly string[]).includes(value);
}

/**
 * Whether a step, as an engine runs it, differs from its built-in: its switch, or any of its numbers.
 * A step that only follows what it stands on has not been changed itself, and nothing here would reset it.
 */
export function stepDiffers(step: PlaybookStepId, resolved: PlaybookResolved, builtin: PlaybookResolved): boolean {
  const mine = resolved[step];
  const theirs = builtin[step];
  const follows = playbookStep(step).requires?.some((id) => resolved[id].on !== builtin[id].on) ?? false;
  return (!follows && mine.on !== theirs.on) || Object.keys(mine.params).some((key) => mine.params[key] !== theirs.params[key]);
}

/** Whether a step that is running cannot be switched off here: it is locked, or another step that stays on cannot do without it. */
export function stepLocked(step: PlaybookStepId, resolved: PlaybookResolved): boolean {
  const spec = playbookStep(step);
  return resolved[step].on && (!spec.switchable || (spec.onWhile !== undefined && resolved[spec.onWhile].on));
}

/** A number as the map and the panel say it: the value and its unit. */
export function paramText(param: Pick<PlaybookParamSpec, "unit">, value: number, units: Record<string, string>): string {
  const unit = units[param.unit] ?? "";
  return unit ? `${value} ${unit}` : String(value);
}
