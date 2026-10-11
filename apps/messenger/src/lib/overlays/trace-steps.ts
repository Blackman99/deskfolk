/**
 * Where the app's own calls sit on the flow board (ADR 0083): each call's use is a step, hung in
 * the round it belongs to, between the cards it came between.
 *
 * - What was asked about a line of yours — its reading, where it was filed, what the scribe wrote
 *   down — runs down from your card in the order it happened, and the turns your line woke hang
 *   from the end of that run, since none of them was woken before it.
 * - A group line's judgements hang one per Bot from there too; a Bot that joined hangs from its own.
 * - What ran in or for a turn — a compaction, a reading of its words, a settle after it — hangs
 *   under that turn, one step per kind of call.
 * - What is only about the job (the picture judge, a reflection, a retrospective) hangs under the
 *   last card before it, so it reads where in the job it happened.
 *
 * Pure: it decides the shape, `task-trace.ts` lays it out.
 */
import { USER_MEMBER, type LineTrace, type TaskTrace, type TaskTraceNode, type TraceStep } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import { forgetStored, readStored, writeStored } from "../storage.ts";

/** One step on the board: a call's use, or several of one kind under the same card (a check run's batches). */
export type TraceStepGroup = {
  id: string;
  steps: TraceStep[];
  /** Something in it went wrong or said no: shown in the warning colour, counted on the round. */
  anomalous: boolean;
  created_at: string;
};

export type StepAttachment = {
  groups: TraceStepGroup[];
  /**
   * The item each step hangs from, and each turn that hangs from a step instead of from the card
   * that woke it. Items are cards (`turn_id`) and steps (`TraceStepGroup.id`).
   */
  parent: Map<string, string>;
};

/** Steps the board never draws: a ✨ suggestion is about no line yet. */
const UNDRAWN = new Set(["composer"]);
/** What is asked about a line of yours before it wakes anyone, in this order when they tie. */
const LINE_ROLES = new Set(["reader", "scribe", "organizer"]);

export const stepId = (step: TraceStep) => `step:${step.id}`;

/** A use that went wrong, or a verdict that said no: what someone looking back wants to find first. */
export function stepAnomalous(step: TraceStep): boolean {
  if (step.outcome !== "ok") return true;
  const verdict = step.verdict;
  if (!verdict) return false;
  if (verdict.kind === "judge") return verdict.passed === false;
  if (verdict.kind === "organizer") return !verdict.applied;
  return false;
}

function byTime<T extends { created_at: string; id?: string }>(a: T, b: T): number {
  return a.created_at.localeCompare(b.created_at) || (a.id ?? "").localeCompare(b.id ?? "");
}

export function attachSteps(nodes: readonly TaskTraceNode[], steps: readonly TraceStep[]): StepAttachment {
  const parent = new Map<string, string>();
  const groups: TraceStepGroup[] = [];
  const shown = steps.filter((step) => !UNDRAWN.has(step.role)).slice().sort(byTime);
  if (shown.length === 0) return { groups, parent };

  const turns = new Map(nodes.map((node) => [node.turn_id, node]));
  // Your line's card, by the message it is: decisions are cards of yours too, but not a line that woke anyone.
  const cardOfLine = new Map<string, TaskTraceNode>();
  for (const node of nodes) {
    if (node.actor === USER_MEMBER && node.turn_id.startsWith("user:")) cardOfLine.set(node.trigger_message_id, node);
  }
  const single = (step: TraceStep): TraceStepGroup => ({ id: stepId(step), steps: [step], anomalous: stepAnomalous(step), created_at: step.created_at });

  // Under a card, one step per kind of call: a turn that read six of its lines shows one reading step.
  const underCard = new Map<string, TraceStepGroup>();
  const hangUnder = (cardId: string, step: TraceStep, key: string) => {
    const at = `${cardId}\u0000${key}`;
    const known = underCard.get(at);
    if (known) {
      known.steps.push(step);
      known.anomalous ||= stepAnomalous(step);
      return;
    }
    const group = single(step);
    underCard.set(at, group);
    groups.push(group);
    parent.set(group.id, cardId);
  };

  const lineRuns = new Map<string, TraceStepGroup[]>();
  const judgements = new Map<string, Map<string, TraceStepGroup>>();
  const loose: TraceStep[] = [];
  for (const step of shown) {
    const turn = step.turn_id ? turns.get(step.turn_id) : undefined;
    const line = step.message_id ? cardOfLine.get(step.message_id) : undefined;
    if (turn && step.role !== "judgement") {
      hangUnder(turn.turn_id, step, `${step.role}:${step.prompt_id ?? ""}`);
    } else if (line && step.role === "judgement") {
      const byBot = judgements.get(line.turn_id) ?? new Map<string, TraceStepGroup>();
      const group = single(step);
      byBot.set(step.bot_id ?? group.id, group);
      judgements.set(line.turn_id, byBot);
      groups.push(group);
    } else if (line && LINE_ROLES.has(step.role)) {
      const run = lineRuns.get(line.turn_id) ?? [];
      const group = single(step);
      run.push(group);
      lineRuns.set(line.turn_id, run);
      groups.push(group);
    } else {
      loose.push(step);
    }
  }

  // Your line, then what was asked about it, then who it woke.
  const runEnd = new Map<string, string>();
  for (const [cardId, run] of lineRuns) {
    run.forEach((group, index) => parent.set(group.id, index === 0 ? cardId : run[index - 1]!.id));
    runEnd.set(cardId, run.at(-1)!.id);
  }
  for (const [cardId, byBot] of judgements) {
    for (const group of byBot.values()) parent.set(group.id, runEnd.get(cardId) ?? cardId);
  }
  for (const node of nodes) {
    const from = node.woken_by_turn_id;
    if (!from?.startsWith("user:")) continue;
    const judged = judgements.get(from)?.get(node.actor);
    const end = judged?.id ?? runEnd.get(from);
    if (end) parent.set(node.turn_id, end);
  }

  // The rest under the last card before it, or the first card when it came before them all.
  const ordered = nodes.slice().sort(byTimeNode);
  for (const step of loose) {
    let card = ordered[0];
    for (const node of ordered) {
      if (node.created_at <= step.created_at) card = node;
      else break;
    }
    if (!card) continue;
    hangUnder(card.turn_id, step, `${step.role}:${step.check_run_id ?? step.prompt_id ?? ""}`);
  }
  groups.sort(byTime);
  return { groups, parent };
}

function byTimeNode(a: TaskTraceNode, b: TaskTraceNode): number {
  return a.created_at.localeCompare(b.created_at) || a.turn_id.localeCompare(b.turn_id);
}

/** The cards anything that went wrong hangs under, so lighting those keeps their rounds open. */
export function anomalousCards(nodes: readonly TaskTraceNode[], steps: readonly TraceStep[]): Set<string> {
  const { groups, parent } = attachSteps(nodes, steps);
  const cards = new Set(nodes.map((node) => node.turn_id));
  const out = new Set<string>();
  for (const group of groups) {
    if (!group.anomalous) continue;
    let at: string | null = group.id;
    for (let hops = 0; at && !cards.has(at) && hops < 64; hops++) at = parent.get(at) ?? null;
    if (at) out.add(at);
  }
  return out;
}

/** What a step is called on its card: the call, or which of its kinds when it has several. */
export function stepTitle(step: TraceStep, t: Copy): string {
  if (step.verdict?.kind === "organizer") return step.verdict.mode === "settle" ? t.traceSteps.organizerSettle : t.traceSteps.organizerMessage;
  return (step.prompt_id ? t.traceSteps.variant[step.prompt_id] : undefined) ?? t.builtinModels.roles[step.role].name;
}

/** What a step concluded; for one that came to nothing, why. */
export function stepSaid(step: TraceStep, t: Copy): string {
  return step.verdict ? t.traceSteps.verdict(step.verdict) : t.traceSteps.failed(step.fail_kind);
}

/** The board a line of its own is drawn as: the shape a job's is, named after the line. */
export function lineBoard(line: LineTrace): TaskTrace {
  const card = line.nodes.find((node) => node.turn_id === `user:${line.message_id}`);
  return { id: `line:${line.message_id}`, dir: "", title: card?.summary ?? "", session_id: line.session_id, closed_at: null, nodes: line.nodes, steps: line.steps };
}

const SHOWN_KEY = "real-bot-trace-steps";

/** Whether the board draws the app's calls; on unless you hid them, per browser like the minimap. */
export function loadTraceSteps(): boolean {
  return readStored(SHOWN_KEY) !== "off";
}

export function saveTraceSteps(shown: boolean): void {
  writeStored(SHOWN_KEY, shown ? "on" : "off");
}

export function forgetTraceSteps(): void {
  forgetStored(SHOWN_KEY);
}
