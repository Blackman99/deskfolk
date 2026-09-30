import type { ControlOffer, ControlScope, Hold, MessageControl } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";

/** One button under a line about your stops or a restart. `taskId` names the plan a widen or narrow button is about. */
export type ControlButton = { action: ControlOffer; taskId?: string; label: string; primary: boolean };

/**
 * What a line's control row shows now: the question and its buttons; what you pressed on it; or
 * nothing, once there is nothing left to press (its stops were lifted some other way).
 */
export type ControlBar =
  | { state: "ask"; prompt: string | null; buttons: ControlButton[] }
  | { state: "done"; note: string }
  | { state: "none" };

type Names = { bot: (id: string) => string };

/** A restart notice's 继续 that a stop of yours kept from some of its turns: how many went on, and how many it holds. */
export type RestartPartial = { continued: number; held: number };

/** The partial 继续 a press came back with (`{ partial }`), or null for a refusal or nothing. */
export function partialOf(value: unknown): RestartPartial | null {
  if (!value || typeof value !== "object" || !("partial" in value)) return null;
  const partial = (value as { partial: unknown }).partial;
  if (!partial || typeof partial !== "object") return null;
  const { continued, held } = partial as Record<string, unknown>;
  return typeof continued === "number" && typeof held === "number" ? { continued, held } : null;
}

/**
 * The row for a line's `control`, read against the stops in force now. The daemon offered the
 * buttons when it wrote the line; this only leaves out the ones the present has made pointless —
 * undo once its stops are lifted, 「扩大到所有 Bot」 while everything is stopped — so a press
 * never asks for something already so. One press answers the line: after it, the row says what
 * was done.
 */
export function controlBar(control: MessageControl | undefined, holds: readonly Hold[], names: Names, t: Copy["control"]): ControlBar {
  if (!control) return { state: "none" };
  const acted = control.acted ?? [];
  if (acted.length > 0) return { state: "done", note: t.acted[acted[acted.length - 1]!] };
  // A restart notice (ADR 0041): go on with what the restart cut off, or leave it. Stops play no part.
  if (control.kind === "restart") {
    const buttons = control.offer.flatMap((action): ControlButton[] => {
      if (action === "resume") return [{ action, label: t.resume, primary: true }];
      if (action === "leave") return [{ action, label: t.leave, primary: false }];
      return [];
    });
    return buttons.length > 0 ? { state: "ask", prompt: null, buttons } : { state: "none" };
  }
  const inForce = new Set(holds.map((hold) => hold.id));
  const everything = holds.some((hold) => hold.scope === "global");
  const who = whoOf(control.scopes, names, t);

  if (control.kind === "possible_control") {
    const buttons = control.offer.flatMap((action): ControlButton[] => {
      if (action === "stop") return [{ action, label: who ? t.stopWho(who) : t.stop, primary: true }];
      if (action === "continue") return [{ action, label: t.continue, primary: !control.offer.includes("stop") }];
      if (action === "cancel") return [{ action, label: t.cancel, primary: false }];
      return [];
    });
    if (buttons.length === 0) return { state: "none" };
    const prompt = control.offer.includes("cancel")
      ? t.hintAbandon
      : control.offer.includes("stop") && control.offer.includes("continue")
        ? t.hintEither
        : control.offer.includes("continue")
          ? t.hintContinue(who ?? "")
          : t.hintStop(who ?? "");
    return { state: "ask", prompt, buttons };
  }

  if (control.kind === "receipt" && control.verb === "stop") {
    const mine = holds.filter((hold) => control.hold_ids.includes(hold.id));
    // Lifted some other way — 「继续」, the list's lift — and nothing on it is left to do.
    if (mine.length === 0) return control.hold_ids.length > 0 ? { state: "done", note: t.spent } : { state: "none" };
    const buttons: ControlButton[] = [];
    for (const action of control.offer) {
      if (action === "undo") buttons.push({ action, label: t.undo, primary: false });
      else if (action === "stop_all" && !everything) buttons.push({ action, label: t.stopAll, primary: false });
      else if (action === "cancel" && mine.some((hold) => hold.action !== "cancel")) buttons.push({ action, label: t.cancel, primary: false });
    }
    for (const plan of control.plans ?? []) {
      if (plan.offer === "stop_plan" && !holds.some((hold) => hold.scope === "plan" && hold.scope_id === plan.task_id)) {
        buttons.push({ action: "stop_plan", taskId: plan.task_id, label: t.stopPlan(plan.title), primary: false });
      }
      if (plan.offer === "only_plan" && mine.some((hold) => hold.scope === "bot")) {
        buttons.push({ action: "only_plan", taskId: plan.task_id, label: t.onlyPlan(plan.title), primary: false });
      }
    }
    return buttons.length > 0 ? { state: "ask", prompt: null, buttons } : { state: "none" };
  }

  // A go on a wider stop held back, or a status answer: its buttons stand while those stops do.
  const about = control.kind === "status" ? control.hold_ids : control.kind === "receipt" ? (control.held_ids ?? []) : [];
  const stillHeld = about.some((id) => inForce.has(id));
  const buttons = control.offer.flatMap((action): ControlButton[] => {
    if (action === "stop") return [{ action, label: who ? t.stopWho(who) : t.stop, primary: true }];
    if (action === "continue_only" && stillHeld) return [{ action, label: who ? t.continueOnly(who) : t.continueOnlyHere, primary: true }];
    if (action === "continue_all" && stillHeld) return [{ action, label: t.continueAll, primary: false }];
    return [];
  });
  return buttons.length > 0 ? { state: "ask", prompt: null, buttons } : { state: "none" };
}

/** Whom the buttons are about, in words: the Bots a line named; null when it named a place or everything. */
function whoOf(scopes: readonly ControlScope[], names: Names, t: Copy["control"]): string | null {
  const bots = scopes.flatMap((scope) => (scope.scope === "bot" ? [names.bot(scope.id)] : []));
  if (bots.length > 0) return bots.join(t.join);
  if (scopes.some((scope) => scope.scope === "global")) return t.scope.global;
  return null;
}
