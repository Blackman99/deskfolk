/**
 * The app's lines about the requirements ledger (ADR 0040 P3), as they were put up in a plan's
 * conversation until 2026-10-04, each with its buttons. Two kinds:
 * - `legacy`: the plan bore old rules the app found none of your words for (taken in from before
 *   the ledger, `unverified`): 「这些是你说的吗」 with 都是 (they are in force from then) and 逐条看
 *   (the messenger opens the board, where each has its own buttons). Settled once none of its rules
 *   is unverified any more (`REQUIREMENT_CARD_TRIGGERS`).
 * - `standing`: craft requirements of one category you had raised in two or more video jobs of one
 *   conversation: 升为常设 makes them hold for every video job, 不用 leaves them where they are.
 * Neither asked about anything you had to decide — old rules stay reference-only until you take
 * them up on the board, and a requirement holds for the conversation it was said in without one —
 * so none is put up any more. Those already out still take their buttons, here.
 */
import type { ControlActionResult, Message } from "@real-bot/protocol";
import { HttpError } from "../errors";
import type { Store } from "../store";

export type RequirementCardsDeps = {
  store: Store;
};

export type RequirementCards = {
  /** A button on one of these lines. */
  act: (message: Message, input: { action: unknown }) => ControlActionResult;
};

export function createRequirementCards(deps: RequirementCardsDeps): RequirementCards {
  const { store } = deps;

  function act(message: Message, input: { action: unknown }): ControlActionResult {
    const control = message.control;
    if (control?.kind !== "requirement") throw new HttpError(422, "invalid_args", "this line is not about requirements");
    const action = input.action;
    const served = action === "confirm_requirements" || action === "make_standing" || action === "keep_project";
    if (!served || !control.offer.includes(action)) throw new HttpError(422, "invalid_args", "this line does not offer that button");
    // One press per line, as on every line with buttons; none once you went through its old rules on the board.
    if ((control.acted ?? []).length > 0 || control.settled_at) return { made: [], lifted: [] };
    store.transaction(() => {
      for (const id of control.requirement_ids) {
        let entry;
        try {
          entry = store.getRequirement(id);
        } catch {
          continue; // purged since
        }
        // Each only where it still applies: one you took up or turned down on the board is left as you
        // left it, and 升为常设 widens only what such a card may name now (a craft entry of this
        // conversation, still in force), whatever the line lists.
        if (action === "confirm_requirements" && entry.status === "unverified") store.confirmRequirement(id, { taskId: control.task_id });
        if (action === "make_standing" && store.mayMakeStanding(id, { taskId: control.task_id, category: control.category ?? null })) {
          store.widenRequirement(id, { to: "standing", taskId: control.task_id, domain: control.domain ?? null });
        }
      }
      store.setMessageControl(message.id, { ...control, acted: [action] });
    });
    return { made: [], lifted: [] };
  }

  return { act };
}
