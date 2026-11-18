import {
  BOT_BUILTIN_MODEL_ROLES,
  isReaderAgentModel,
  type BuiltinModelRole,
  type PromptSummary,
  type ReaderModel,
  type Settings,
} from "@real-bot/protocol";
import { agentLabelOf } from "../runner-choice.ts";
import { builtinModelsOf } from "./builtin-models.ts";
import { editedCount, failuresOf } from "./prompts-view.ts";

/**
 * The model and prompts of each of the app's own calls (ADR 0082) as Roles shows them beside the
 * engine step that makes it (ADR 0085). A node is one of the built-in calls (ADR 0077), or the Bot's
 * own turn, which is set elsewhere.
 */
export type RoutingNodeId = BuiltinModelRole | "turn";

/**
 * A question to the daemon asked once however many times it is asked: every call's picker asks for
 * the Claude Code and agent status when it shows, and the page hands them all the first answer.
 */
export function askOnce<T>(ask: () => Promise<T>): () => Promise<T> {
  let asked: Promise<T> | null = null;
  return () => (asked ??= ask());
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

