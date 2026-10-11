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
  type BuiltinModelRole,
  type PlaybookHook,
  type PlaybookParamSpec,
  type PlaybookResolved,
  type PlaybookStepId,
} from "@real-bot/protocol";

/** A node of the map: an engine step, or a Bot's turn itself (its model ladder). */
export type PlaybookNodeId = PlaybookStepId | "turn";

export const PLAYBOOK_ROUNDS: ReadonlyArray<{ hook: PlaybookHook; steps: readonly PlaybookStepId[] }> = PLAYBOOK_HOOKS.map((hook) => ({
  hook,
  steps: PLAYBOOK_STEPS.filter((step) => step.hook === hook).map((step) => step.id),
}));

/** Every node in the order ↑ and ↓ walk them: each round's root that can be picked, then its steps. */
export const PLAYBOOK_ORDER: readonly PlaybookNodeId[] = PLAYBOOK_ROUNDS.flatMap((round) => [
  ...(round.hook === "turn" ? (["turn"] as const) : []),
  ...round.steps,
]);

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
  kind: "root" | "step";
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

/** The map for a canvas `available` px wide. */
export function layPlaybookFlow(available: number): PlaybookLayout {
  const width = Math.max(available, ROOT_W + 2 * PAD, SPINE_STEP_MIN + INDENT + 2 * PAD);
  const inner = width - 2 * PAD;
  const across = Math.max(1, Math.floor((inner + GAP_X) / (STEP_W + GAP_X)));
  const fans = PLAYBOOK_ROUNDS.every((round) => round.steps.length <= across);
  const cards: PlaybookCard[] = [];
  const edges: PlaybookEdge[] = [];
  const rounds: PlaybookLayout["rounds"] = [];
  let y = PAD;
  for (const round of PLAYBOOK_ROUNDS) {
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
      const row = round.steps.length * STEP_W + (round.steps.length - 1) * GAP_X;
      let x = PAD + (inner - row) / 2;
      for (const step of round.steps) {
        cards.push({ id: step, node: step, hook: round.hook, kind: "step", x, y, w: STEP_W, h: STEP_H });
        edges.push({ from: root.id, to: step, d: down(root.x + ROOT_W / 2, root.y + rootH, x + STEP_W / 2, y) });
        x += STEP_W + GAP_X;
      }
      y += STEP_H;
    } else {
      const spine = root.x + 14;
      y -= GAP_Y - ROW_GAP;
      for (const step of round.steps) {
        const x = PAD + INDENT;
        cards.push({ id: step, node: step, hook: round.hook, kind: "step", x, y, w: Math.max(SPINE_STEP_MIN, Math.min(SPINE_STEP_MAX, width - PAD - x)), h: STEP_H });
        edges.push({ from: root.id, to: step, d: elbow(spine, root.y + rootH, x, y + STEP_H / 2) });
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
  if (node === "turn") return null;
  return PLAYBOOK_STEPS.find((step) => step.id === node)?.role ?? null;
}

/** The step a call belongs to, for a link that names the call (「改这个调用」 on the flow). */
export function stepOfRole(role: BuiltinModelRole): PlaybookStepId {
  return PLAYBOOK_STEPS.find((step) => step.role === role)!.id;
}

export function isBuiltinRole(value: unknown): value is BuiltinModelRole {
  return typeof value === "string" && (BUILTIN_MODEL_ROLES as readonly string[]).includes(value);
}

/** Whether a step, as an engine runs it, differs from its built-in: its switch, or any of its numbers. */
export function stepDiffers(step: PlaybookStepId, resolved: PlaybookResolved, builtin: PlaybookResolved): boolean {
  const mine = resolved[step];
  const theirs = builtin[step];
  return mine.on !== theirs.on || Object.keys(mine.params).some((key) => mine.params[key] !== theirs.params[key]);
}

/** A number as the map and the panel say it: the value and its unit. */
export function paramText(param: Pick<PlaybookParamSpec, "unit">, value: number, units: Record<string, string>): string {
  const unit = units[param.unit] ?? "";
  return unit ? `${value} ${unit}` : String(value);
}
