/** Carrying out a stop: the holds it makes, the live work they cover ended and recorded, and the receipt. */
import { type Message, type ControlScope, type HoldScope, type Hold, USER_MEMBER, type ControlOffer, type ControlPlanOffer, type Turn, type HeldTurn } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import { stopReceiptBody } from "../../prompts";
import { botPlanScopeId } from "../../store";
import type { HoldRequest, StopDeps } from "../stop";
import type { StopReach } from "./reach";
import type { StopWords } from "./words";

/** How many plans a receipt offers to widen a stop to, and as many to narrow it to. */
const PLAN_OFFERS_MAX = 3;
type Ended = { turn: Turn; record: HeldTurn; hold: string };

export function createStopCarryOut(deps: StopDeps, reach: StopReach, words: StopWords) {
  const { store, publishMessage, publishTurn, lives, executionOf, abortLive } = deps;
  const { handedOn, on, lineScopes, heldTurn, turnRow } = reach;
  const { authorIn, planTitle, locale, scopeLabel, holdSaid, turnLine, botName, ticketLabel, safeTurn, nextLineAbout } = words;

  // ── Stopping ──────────────────────────────────────────────────────────────────────────────────

  function stopByLine(message: Message, scopes: ControlScope[], offerCancel: boolean): void {
    carryOut(() => scopes.map((scope) => holdOn(scope, { source: "user_text", sourceMessageId: message.id })), {
      in: message.session_id,
      scopes,
      offerCancel,
    });
  }

  /** A hold of yours on a scope a line or a button names, with the work it handed on. */
  function holdOn(
    scope: { scope: HoldScope; id: string | null },
    opts: { source: "user_text" | "user_button"; sourceMessageId?: string | null; action?: "pause" | "cancel" },
  ): Hold {
    return store.createHold({
      scope: scope.scope,
      scopeId: scope.id,
      action: opts.action,
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      targets: handedOn(scope.scope, scope.id),
    });
  }

  /**
   * A stop in one write: the holds `create` makes, every live turn they cover ended, what beside it
   * goes on recorded, and — when `receipt.in` names a conversation you are in — the receipt there.
   * The aborts and the publishing follow once it is written.
   */
  function carryOut(
    create: () => Hold[],
    receipt: { in: string | null; scopes: ControlScope[]; offerCancel?: boolean },
  ): { made: Hold[]; receipt: Message | null } {
    const result = store.transaction(() => {
      const created = create();
      const ended = endCovered(created);
      const made = settle(created, ended, receipt.in);
      const line = receipt.in && store.isPresent(receipt.in, USER_MEMBER) ? stopReceiptLine(made, receipt.in, receipt) : null;
      return { ended, made, line };
    });
    for (const { turn } of result.ended) publishTurn(turn, null);
    if (result.line) publishMessage(result.line);
    return { made: result.made, receipt: result.line };
  }

  /** The receipt for a stop you said, chose from a menu or confirmed on a button, with its buttons. */
  function stopReceiptLine(holds: Hold[], sessionId: string, opts: { scopes: ControlScope[]; offerCancel?: boolean }): Message {
    const offer: ControlOffer[] = ["undo", ...(holds.some((hold) => hold.scope === "global") ? [] : ["stop_all" as const]), ...(opts.offerCancel ? ["cancel" as const] : [])];
    const plans = planOffers(holds);
    return store.insertMessage({
      sessionId,
      kind: "system",
      author: authorIn(sessionId, opts.scopes),
      body: stopReceipt(holds, sessionId),
      hiddenFromBots: true,
      control: { kind: "receipt", verb: "stop", hold_ids: holds.map((hold) => hold.id), offer, scopes: opts.scopes, ...(plans.length > 0 ? { plans } : {}) },
    });
  }

  /**
   * The plans a stop's receipt offers to widen it to — one other Bots were still working in — and
   * to narrow a stop on a whole Bot to: each plan its stopped work was in.
   */
  function planOffers(holds: Hold[]): ControlPlanOffer[] {
    const widen = new Set<string>();
    const narrow = new Set<string>();
    for (const hold of holds) {
      for (const row of hold.effect.working_beside ?? []) if (row.task_id) widen.add(row.task_id);
      if (hold.scope !== "bot") continue;
      for (const record of hold.effect.stopped_turns ?? []) if (record.task_id) narrow.add(record.task_id);
    }
    const offers = (offer: ControlPlanOffer["offer"], ids: Set<string>) =>
      [...ids].slice(0, PLAN_OFFERS_MAX).flatMap((id) => {
        const title = planTitle(id);
        return title === null ? [] : [{ offer, task_id: id, title }];
      });
    return [...offers("stop_plan", widen), ...offers("only_plan", narrow)];
  }

  function stopByButton(turnId: string): Turn | null {
    if (!on()) return null;
    const turn = store.getTurn(turnId);
    const bot = turn.bot_id;
    const task = turn.task_id ?? null;
    const scope: HoldScope = task ? "bot_plan" : "turn";
    const scopeId = task ? botPlanScopeId(bot, task) : turn.id;
    // A turn already over is refused, as a Stop before holds was. A group's turn is not any more:
    // one Bot's work in a group is stopped the same way as in a direct (ADR 0040 P2).
    if (!["running", "waiting_approval", "waiting_ask"].includes(turn.status)) throw new HttpError(422, "invalid_args", "turn is not in progress");
    const result = store.transaction(() => {
      const hold = store.createHold({ scope, scopeId, source: "user_button", liftOnNextUserMessage: true, targets: handedOn(scope, scopeId) });
      const ended = endCovered([hold], new Set([turn.id]));
      // What it ended is recorded on the hold (its `effect`), for 「停了吗」 and the board; nothing is said.
      settle([hold], ended, null);
      return { ended };
    });
    for (const { turn: ended } of result.ended) publishTurn(ended, null);
    return result.ended.find((row) => row.turn.id === turnId)?.turn ?? store.getTurn(turnId);
  }

  function hold(input: HoldRequest): Hold {
    const scope = input.scope as HoldScope;
    const scopeId = (input.scopeId ?? null) as string | null;
    const cascade = input.cascade ?? true;
    if (input.sessionId !== undefined && input.sessionId !== null && typeof input.sessionId !== "string") {
      throw new HttpError(422, "invalid_args", "session_id must be a string");
    }
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : null;
    if (sessionId) store.getSession(sessionId);
    const { made } = carryOut(
      () => [
        store.createHold({
          scope: input.scope,
          scopeId: input.scopeId,
          action: input.action,
          cascade: input.cascade,
          liftOnNextUserMessage: input.liftOnNextUserMessage,
          source: "user_button",
          targets: cascade === true && typeof scopeId === "string" ? handedOn(scope, scopeId) : [],
        }),
      ],
      { in: sessionId, scopes: lineScopes(scope, scopeId) },
    );
    return made[0]!;
  }

  function enforce(): void {
    if (!on()) return;
    const ended = store.transaction(() => endCovered(null));
    for (const { turn } of ended) publishTurn(turn, null);
  }

  /**
   * Ends every live turn a hold covers — only those `made` covers, when given — as stopped, keeping
   * its check-backs for the lift, and records on that hold what each was doing. A read-only turn
   * a hold let open is left to answer, unless it is one `also` names. The abort itself runs once
   * the write is in: the turn's model call, its MCP calls and its commands' process groups.
   */
  function endCovered(made: Hold[] | null, also: Set<string> = new Set()): Ended[] {
    const ended: Ended[] = [];
    for (const turn of store.listLiveTurns()) {
      if (turn.mode === "readonly" && !also.has(turn.id)) continue;
      const covering = store.turnHeldBy(turn.id);
      const owner = [...covering].reverse().find((hold) => made === null || made.some((row) => row.id === hold.id));
      if (!owner) continue;
      const live = lives.get(turn.id);
      const record = heldTurn(turn, live);
      const stopped = store.stopTurn(turn.id, { allowGroup: true, execution: executionOf(live), keepCheckBacks: true });
      if (!stopped) continue;
      store.addHoldEffect(owner.id, { stopped_turns: [record] });
      abortLive(turn.id);
      ended.push({ turn: stopped, record, hold: owner.id });
    }
    return ended;
  }

  /**
   * What the receipt says beside what was ended, measured now and recorded on each hold: the other
   * Bots' turns in the same plans that it does not cover, and anything it covers still running.
   * Records a `control.hold` in the work log for each. Returns the holds as they now read.
   */
  function settle(made: Hold[], ended: Ended[], sessionId: string | null): Hold[] {
    const live = store.listLiveTurns();
    return made.map((hold) => {
      const mine = ended.filter((row) => row.hold === hold.id);
      const plans = new Set(mine.map((row) => row.record.task_id).filter((id): id is string => id !== null));
      const oneBot = hold.scope === "bot" || hold.scope === "bot_plan" || hold.scope === "turn";
      const beside = oneBot
        ? live
            .filter((turn) => turn.task_id && plans.has(turn.task_id) && store.turnHeldBy(turn.id).length === 0)
            .map((turn) => ({ turn_id: turn.id, bot_id: turn.bot_id, task_id: turn.task_id ?? null, ticket_id: turn.ticket_id ?? null }))
        : [];
      const still = live.filter((turn) => turn.mode !== "readonly" && store.turnHeldBy(turn.id).some((row) => row.id === hold.id)).map((turn) => turn.id);
      store.addHoldEffect(hold.id, { working_beside: beside, still_running: still });
      store.recordWorkEvent({
        kind: "control.hold",
        actor: "user",
        sessionId,
        payload: { hold: hold.id, scope: hold.scope, scope_id: hold.scope_id, source: hold.source, stopped: mine.map((row) => row.turn.id) },
      });
      return store.getHold(hold.id);
    });
  }

  /**
   * Ends whatever still runs under these holds, records each as a violation on the hold and in the
   * work log (`hold.violation`), and returns them. A stop ends what it covers when it is made, so
   * this finds something only when that went wrong.
   */
  function endViolations(holds: Hold[]): Ended[] {
    if (holds.length === 0) return [];
    const ended = endCovered(holds);
    for (const row of ended) {
      store.addHoldEffect(row.hold, { violations: [row.turn.id] });
      store.recordWorkEvent({
        kind: "hold.violation",
        actor: "app",
        botId: row.turn.bot_id,
        sessionId: row.turn.session_id,
        taskId: row.turn.task_id ?? null,
        turnId: row.turn.id,
        payload: { hold: row.hold },
      });
    }
    return ended;
  }

  /**
   * Stops that hold, for every Bot but those in `keep`, what `wide` held of its work: on everything,
   * all of each Bot's work, one stop per Bot; on a plan, each Bot's work in it; on a conversation,
   * each Bot's work in the plans it parked or has now, plus a turn stop on each of that Bot's
   * stopped turns off those plans, so none of them opens again when `wide` goes. Each quotes the
   * line that made `wide`.
   */
  function splitHold(wide: Hold, keep: Set<string>): Hold[] {
    const others = store.listBots().filter((bot) => !bot.archived_at && !keep.has(bot.id));
    const opts = { source: "user_button" as const, sourceMessageId: wide.source_message_id, action: wide.action };
    switch (wide.scope) {
      case "global":
        return others.map((bot) => holdOn({ scope: "bot", id: bot.id }, opts));
      case "plan":
        return others.map((bot) => holdOn({ scope: "bot_plan", id: botPlanScopeId(bot.id, wide.scope_id!) }, opts));
      case "session": {
        const plans = new Set((wide.effect.parked_plans ?? []).map((row) => row.task_id));
        const current = store.sessionCurrentTask(wide.scope_id!)?.id;
        if (current) plans.add(current);
        const made = others.flatMap((bot) => [...plans].map((task) => holdOn({ scope: "bot_plan", id: botPlanScopeId(bot.id, task) }, opts)));
        const otherIds = new Set(others.map((bot) => bot.id));
        const turns = new Set([
          ...[...(wide.effect.stopped_turns ?? []), ...(wide.effect.held_over ?? [])]
            .filter((record) => otherIds.has(record.bot_id) && (record.task_id === null || !plans.has(record.task_id)))
            .map((record) => record.turn_id),
          ...wide.targets.filter((target) => target.scope === "turn" && otherIds.has(turnRow(target.id)?.bot_id ?? "")).map((target) => target.id),
        ]);
        for (const turn of turns) if (turnRow(turn)) made.push(holdOn({ scope: "turn", id: turn }, opts));
        return made;
      }
      default:
        return [];
    }
  }

  // ── Words ─────────────────────────────────────────────────────────────────────────────────────

  function stopReceipt(holds: Hold[], here: string): string {
    const heading = new Set(holds.flatMap((hold) => (hold.scope === "bot" ? [hold.scope_id!] : hold.scope === "bot_plan" ? [hold.scope_id!.split(":")[0]!] : [])));
    const effects = holds.map((hold) => hold.effect);
    return stopReceiptBody(locale(), {
      scopes: holds.map((hold) => scopeLabel(hold, here)),
      said: holdSaid(holds[0]!),
      stopped: effects.flatMap((effect) => effect.stopped_turns ?? []).map((record) => turnLine(record, here, heading)),
      suspended: effects.reduce((sum, effect) => sum + (effect.suspended_check_backs?.length ?? 0), 0),
      parked: effects.flatMap((effect) => effect.parked_plans ?? []).map((row) => planTitle(row.task_id) ?? row.task_id),
      beside: effects
        .flatMap((effect) => effect.working_beside ?? [])
        .map((row) => ({ bot: botName(row.bot_id), plan: planTitle(row.task_id!) ?? "", ticket: row.ticket_id ? ticketLabel(row.ticket_id) : null })),
      stillRunning: effects.flatMap((effect) => effect.still_running ?? []).flatMap((id) => {
        const turn = safeTurn(id);
        return turn ? [turnLine(heldTurn(turn, lives.get(id)), here, heading)] : [];
      }),
      liftOnNextLine: nextLineAbout(holds.find((hold) => hold.lift_on_next_user_message)),
      global: holds.some((hold) => hold.scope === "global"),
    });
  }

  return { stopByLine, holdOn, carryOut, stopByButton, hold, enforce, endViolations, splitHold };
}

export type StopCarryOut = ReturnType<typeof createStopCarryOut>;
