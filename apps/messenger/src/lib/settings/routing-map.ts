import {
  BOT_BUILTIN_MODEL_ROLES,
  isReaderAgentModel,
  type BuiltinModelRole,
  type PromptSummary,
  type ReaderModel,
  type Settings,
} from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import { agentLabelOf } from "../runner-choice.ts";
import { builtinModelsOf } from "./builtin-models.ts";
import { editedCount, failuresOf } from "./prompts-view.ts";

/**
 * Settings › Roles (ADR 0082): every call the app makes on its own, drawn where it runs, with its
 * model and its prompts in one place. A node is one of the built-in calls (ADR 0077), or the Bot's
 * own turn, which is set elsewhere and only shown for where the calls sit around it.
 */
export type RoutingNodeId = BuiltinModelRole | "turn";

/** A word on the arrow into a step: when, or why, it runs. */
export type RoutingEdgeKey = keyof Copy["routing"]["edges"];
export type RoutingLaneKey = keyof Copy["routing"]["lanes"];

/** A call that branches off a step: it runs beside it, not after it. */
export type RoutingBranch = { node: RoutingNodeId; edge: RoutingEdgeKey };
/** One step along a lane, after the arrow named by `edge`, with the calls that run beside it. */
export type RoutingStep = { node: RoutingNodeId; edge: RoutingEdgeKey | null; branches: readonly RoutingBranch[] };
/** What sets a lane off, then its steps in order; `end` names where it goes on to, when elsewhere. */
export type RoutingLane = { key: RoutingLaneKey; steps: readonly RoutingStep[]; end: RoutingEdgeKey | null };

/**
 * Where each call runs, as the engine wires them (`turn-engine.ts`):
 * - a line of yours is read first (`reader.ts`), and wakes no Bot until it is read; once it is filed
 *   the scribe writes its requirements down beside the turn, holding none up (`scribe.ts`);
 * - the organizer settles the board once the work goes quiet (`organizer.ts`, `settleQuietMs`); a
 *   turn near its context window is compacted (`hop-loop.ts`); a part handed in is checked against
 *   the sample and at its seams (`seams-judge.ts`, `checks.ts`);
 * - a group line naming nobody is judged by each Bot first (`participation.ts`), and one that takes
 *   it up goes on to its turn;
 * - a delivery you accept is looked back over (`retrospective.ts`); an approval you overturn is
 *   reflected on (`reflection.ts`); ✨ asks the composer (`composer.ts`).
 */
export const ROUTING_LANES: readonly RoutingLane[] = [
  {
    key: "line",
    steps: [
      { node: "reader", edge: null, branches: [{ node: "scribe", edge: "aside" }] },
      { node: "turn", edge: "wakes", branches: [{ node: "compaction", edge: "nearFull" }, { node: "organizer", edge: "settle" }] },
      { node: "judge", edge: "handedIn", branches: [] },
    ],
    end: null,
  },
  { key: "group", steps: [{ node: "judgement", edge: null, branches: [] }], end: "joins" },
  { key: "accepted", steps: [{ node: "retrospective", edge: null, branches: [] }], end: null },
  { key: "overturned", steps: [{ node: "reflection", edge: null, branches: [] }], end: null },
  { key: "compose", steps: [{ node: "composer", edge: null, branches: [] }], end: null },
];

/**
 * A question to the daemon asked once however many times it is asked: every call's picker asks for
 * the Claude Code and agent status when it shows, and the page hands them all the first answer.
 */
export function askOnce<T>(ask: () => Promise<T>): () => Promise<T> {
  let asked: Promise<T> | null = null;
  return () => (asked ??= ask());
}

/** Every node the map draws, in its order: lane by lane, a step before what branches off it. */
export function routingNodes(lanes: readonly RoutingLane[] = ROUTING_LANES): RoutingNodeId[] {
  return lanes.flatMap((lane) => lane.steps.flatMap((step) => [step.node, ...step.branches.map((branch) => branch.node)]));
}

/** The app's own prompts a call runs on, by the call the daemon names (`PromptSummary.role`). */
export function promptsOfRole(items: readonly PromptSummary[], role: BuiltinModelRole): PromptSummary[] {
  return items.filter((item) => item.role === role);
}

/** The prompts the Prompts tab keeps: all but those a call on this page owns. */
export function promptsTabItems(items: readonly PromptSummary[]): PromptSummary[] {
  return items.filter((item) => !item.role);
}

/** A chosen model in a few words: its name, and the agent it runs on when it is not an endpoint's. */
export function modelShort(chosen: ReaderModel): string {
  if (!isReaderAgentModel(chosen)) return chosen.model;
  return `${chosen.model} · ${agentLabelOf(chosen.runner, chosen.custom_id ?? null, null)}`;
}

export type RoutingNodeView = {
  role: BuiltinModelRole;
  /** The model chosen for it, in a few words; null runs it as before. */
  model: string | null;
  /** What it runs on with none chosen: the default model, or the Bot's own. */
  follows: "default" | "bot";
  /** This daemon lets its model be chosen (an older one only has reading and organizing). */
  choosable: boolean;
  prompts: PromptSummary[];
  edited: number;
  conflict: boolean;
  /** Answers that did not read, over its prompts. */
  failures: number;
};

/** One call as its node and its page show it. */
export function routingNodeView(role: BuiltinModelRole, settings: Settings, items: readonly PromptSummary[]): RoutingNodeView {
  const view = builtinModelsOf(settings);
  const chosen = view.chosen[role] ?? null;
  const prompts = promptsOfRole(items, role);
  const counted = editedCount(prompts);
  return {
    role,
    model: chosen ? modelShort(chosen) : null,
    follows: BOT_BUILTIN_MODEL_ROLES.includes(role) ? "bot" : "default",
    choosable: view.roles.includes(role),
    prompts,
    edited: counted.edited,
    conflict: counted.conflict,
    failures: prompts.reduce((sum, item) => sum + failuresOf(item), 0),
  };
}

/**
 * The page's mark in the settings list: how many calls you changed (a model of their own, or an
 * edited prompt), and whether a prompt of theirs has a newer default it did not merge with.
 */
export function routingCounts(settings: Settings, items: readonly PromptSummary[]): { changed: number; conflict: boolean } {
  const { chosen, roles } = builtinModelsOf(settings);
  const changed = new Set<BuiltinModelRole>(roles.filter((role) => (chosen[role] ?? null) !== null));
  let conflict = false;
  for (const item of items) {
    if (!item.role) continue;
    const counted = editedCount([item]);
    if (counted.edited > 0) changed.add(item.role);
    conflict ||= counted.conflict;
  }
  return { changed: changed.size, conflict };
}
