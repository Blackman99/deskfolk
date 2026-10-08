/** The buttons on the app's lines about your stops (`MessageControl`), carried out. */
import type { ControlActionResult, ControlOffer, Session, Message, ControlScope } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import { botPlanScopeId } from "../../store";
import type { StopDeps } from "../stop";
import type { StopReach } from "./reach";
import type { StopCarryOut } from "./carry-out";
import type { StopAnswers } from "./answers";
import type { StopGoOn } from "./go-on";

export function createStopButtons(deps: StopDeps, reach: StopReach, carry: StopCarryOut, answers: StopAnswers, goOn: StopGoOn) {
  const { store, publishMessage, redeliver } = deps;
  const { on, messageSession, directWithYou, botsNamed, heldAbout, isWide } = reach;
  const { carryOut, holdOn, splitHold } = carry;
  const { answerStatus } = answers;
  const { continueByLine, resumeLifted, continueReceiptLine, takeUp } = goOn;

  // ── Buttons ───────────────────────────────────────────────────────────────────────────────────

  function act(messageId: string, input: { action: unknown; taskId?: unknown }): ControlActionResult {
    if (!on()) throw new HttpError(409, "holds_unavailable", "holds are not on yet: the engine level has not reached them (GET /v1/capabilities)");
    const message = store.getMessage(messageId);
    const control = message.control;
    if (!control) throw new HttpError(422, "invalid_args", "this line has no control buttons");
    // A restart notice's buttons are the engine's restart module's (engine/restart.ts), a line about
    // checks from your words the derived-checks module's (engine/derived-checks.ts). A blocked job's
    // question is answered at its own endpoint, and the supervisor's lines offer nothing (ADR 0045).
    if (control.kind === "restart" || control.kind === "check" || control.kind === "requirement" || control.kind === "plan_opened"
      || control.kind === "work_question" || control.kind === "supervisor" || control.kind === "review_item" || control.kind === "rework" || control.kind === "ceiling" || control.kind === "model_default" || control.kind === "lesson") {
      throw new HttpError(422, "invalid_args", "this line's buttons are not about your stops");
    }
    const action = input.action as ControlOffer;
    const taskId = typeof input.taskId === "string" ? input.taskId : null;
    const offered =
      action === "stop_plan" || action === "only_plan"
        ? control.kind === "receipt" && (control.plans ?? []).some((plan) => plan.offer === action && plan.task_id === taskId)
        : control.offer.includes(action);
    if (!offered) throw new HttpError(422, "invalid_args", "this line does not offer that button");
    // One press per line: the buttons are answers to one question, and a second tap or a retried
    // request must not stop or lift a second time.
    if ((control.acted ?? []).length > 0) return { made: [], lifted: [] };
    const pressed = (): void => {
      store.setMessageControl(message.id, { ...control, acted: [...(control.acted ?? []), action] });
    };
    const here = message.session_id;
    switch (action) {
      case "stop":
      case "cancel": {
        if (action === "cancel" && control.kind === "receipt") {
          // 作废 on a stop's receipt: the stop stands, now recorded as dropping the job.
          const ids = control.hold_ids.filter((id) => !store.getHold(id).lifted_at);
          store.transaction(() => {
            store.cancelHolds(ids);
            pressed();
          });
          return { made: [], lifted: [] };
        }
        // Your line that only might have been a stop, or a status answer's button: the stop it
        // meant, made now, with a receipt like any other. The line's own words are quoted.
        const fromLine = control.kind === "possible_control" ? message.id : null;
        const { made } = carryOut(
          () => {
            pressed();
            return control.scopes.map((scope) => holdOn(scope, { source: "user_button", sourceMessageId: fromLine, action: action === "cancel" ? "cancel" : "pause" }));
          },
          { in: here, scopes: control.scopes },
        );
        return { made, lifted: [] };
      }
      case "continue": {
        // Your line that only might have been a go on: what it would have lifted, lifted now.
        let session: Session;
        try {
          session = store.getSession(here);
        } catch {
          throw new HttpError(422, "invalid_args", "the conversation is gone");
        }
        const before = new Set(store.listHolds({ inForce: true }).map((hold) => hold.id));
        store.transaction(pressed);
        if (!continueByLine(message, session, control.scopes, "user_button")) answerStatus(message, control.scopes, { offerStop: false });
        const lifted = [...before].map((id) => store.getHold(id)).filter((hold) => hold.lifted_at);
        return { made: [], lifted };
      }
      case "undo":
        return undo(message, control.kind === "possible_control" ? [] : control.hold_ids, pressed);
      case "stop_all": {
        const { made } = carryOut(
          () => {
            pressed();
            return [holdOn({ scope: "global", id: null }, { source: "user_button" })];
          },
          { in: here, scopes: [{ scope: "global", id: null }] },
        );
        return { made, lifted: [] };
      }
      case "stop_plan": {
        const { made } = carryOut(
          () => {
            pressed();
            return [holdOn({ scope: "plan", id: taskId }, { source: "user_button" })];
          },
          { in: here, scopes: [{ scope: "plan", id: taskId! }] },
        );
        return { made, lifted: [] };
      }
      case "only_plan":
        return onlyPlan(message, control.kind === "possible_control" ? [] : control.hold_ids, taskId!, pressed);
      case "continue_only":
      case "continue_all": {
        const listed = control.kind === "status" ? control.hold_ids : control.kind === "receipt" ? (control.held_ids ?? []) : [];
        const line = control.kind === "status" ? control.unanswered : undefined;
        return goOnByButton(message, control.scopes, listed, action === "continue_only", pressed, line);
      }
      case "resume":
      case "leave":
      case "confirm_check":
      case "edit_check":
      case "remove_check":
      case "confirm_requirements":
      case "review_requirements":
      case "make_standing":
      case "keep_project":
      case "undo_plan":
      case "merge_plan":
      case "confirm_item":
      case "remove_item":
      case "approve":
      case "reject":
      case "another_way":
      case "another_plan":
      case "relax":
      case "accept":
      case "rework":
      case "dismiss":
      case "confirm":
      case "decline":
        // Only a restart notice or a line about checks, requirements, a hand-over or a ceiling offers these, all turned away above.
        throw new HttpError(422, "invalid_args", "this line does not offer that button");
    }
  }

  /**
   * Undo on a stop's receipt: its holds lifted and the work they ended opened again, a Stop's too —
   * undo means as if it had not been pressed. A line of yours that was read as the stop was never
   * meant as one, so it now goes on as any line would have. Said in your direct with a Bot, that
   * line always opens a turn of the Bot's there, so the work stopped there does not open again
   * beside it as well, or the Bot would be at it twice. In a group the line wakes only whom it
   * names — naming nobody, with nobody at work any more, it gets only the Bots' judgements — so
   * the stopped work there opens again as any lift opens it, and the line then goes on as any line
   * of yours there would.
   */
  function undo(message: Message, holdIds: string[], pressed: () => void): ControlActionResult {
    const toLift = holdIds.map((id) => store.getHold(id)).filter((hold) => !hold.lifted_at);
    const lines = new Set(toLift.flatMap((hold) => (hold.source === "user_text" && hold.source_message_id ? [hold.source_message_id] : [])));
    const heard = new Set([...lines].map(messageSession).filter((id): id is string => id !== null && directWithYou(id)));
    const lifted = store.transaction(() => {
      pressed();
      const lifted = toLift.map((hold) => store.liftHold(hold.id, { by: "user_button" }));
      for (const hold of lifted) {
        store.recordWorkEvent({ kind: "control.lift", actor: "user", sessionId: message.session_id, payload: { hold: hold.id, by: "user_button", undo: true } });
      }
      resumeLifted(lifted, null, { stops: true, leave: (record) => heard.has(record.session_id) });
      return lifted.map((hold) => store.getHold(hold.id));
    });
    for (const id of lines) {
      try {
        redeliver(store.getMessage(id));
      } catch {
        // the line was cleared meanwhile; there is nothing to send on
      }
    }
    return { made: [], lifted };
  }

  /**
   * 「只停《P》」 on a stop's receipt: each stop on a whole Bot becomes one on its work in that plan,
   * and the rest of its work opens again, the way a go on would open it. Said in a receipt of its own.
   */
  function onlyPlan(message: Message, holdIds: string[], taskId: string, pressed: () => void): ControlActionResult {
    const wide = holdIds.map((id) => store.getHold(id)).filter((hold) => hold.scope === "bot" && !hold.lifted_at);
    const result = store.transaction(() => {
      pressed();
      const made = wide.map((hold) =>
        holdOn({ scope: "bot_plan", id: botPlanScopeId(hold.scope_id!, taskId) }, { source: "user_button", sourceMessageId: hold.source_message_id }),
      );
      const lifted = wide.map((hold) => store.liftHold(hold.id, { by: "user_button" }));
      for (const hold of lifted) {
        store.recordWorkEvent({ kind: "control.lift", actor: "user", sessionId: message.session_id, payload: { hold: hold.id, by: "user_button", narrowed_to: taskId } });
      }
      const resumed = resumeLifted(lifted, null, { stops: false });
      const scopes = wide.map((hold) => ({ scope: "bot" as const, id: hold.scope_id! }));
      const line = continueReceiptLine(message.session_id, scopes, lifted, resumed, made.map((hold) => store.getHold(hold.id)));
      return { made, lifted: lifted.map((hold) => store.getHold(hold.id)), line };
    });
    publishMessage(result.line);
    return { made: result.made.map((hold) => store.getHold(hold.id)), lifted: result.lifted };
  }

  /**
   * The two buttons under a go on that a wider stop held back. 「全部继续」 lifts every stop over what
   * the go on named. 「只让 X 继续」 lifts them too, but each wider one (on everything, a conversation,
   * a plan) first leaves in its place one stop per other Bot on what it held of that Bot's work, so
   * only the Bots the go on named go on. Under the line said in place of a read-only answer that
   * said nothing (`unanswered`), each named Bot also takes up your line there.
   */
  function goOnByButton(message: Message, scopes: ControlScope[], listed: string[], only: boolean, pressed: () => void, unanswered?: string): ControlActionResult {
    const here = message.session_id;
    const keep = new Set(botsNamed(scopes, here));
    const result = store.transaction(() => {
      pressed();
      // The stops the line listed (a plan the go on would have landed on is among them), and any
      // made over the same work since.
      const ids = new Set([...listed, ...heldAbout(scopes, here).map((hold) => hold.id)]);
      const over = store.listHolds({ inForce: true }).reverse().filter((hold) => ids.has(hold.id));
      const made = only ? over.flatMap((hold) => (isWide(hold) ? splitHold(hold, keep) : [])) : [];
      const lifted = over.map((hold) => store.liftHold(hold.id, { by: "user_button" }));
      for (const hold of lifted) {
        store.recordWorkEvent({ kind: "control.lift", actor: "user", sessionId: here, payload: { hold: hold.id, by: "user_button" } });
      }
      const resumed = resumeLifted(lifted, null, { stops: true });
      if (unanswered) takeUp(unanswered, keep, resumed);
      const line = continueReceiptLine(here, scopes, lifted, resumed, made.map((hold) => store.getHold(hold.id)));
      return { made, lifted: lifted.map((hold) => store.getHold(hold.id)), line };
    });
    publishMessage(result.line);
    return { made: result.made.map((hold) => store.getHold(hold.id)), lifted: result.lifted };
  }

  return { act };
}

export type StopButtons = ReturnType<typeof createStopButtons>;
