/**
 * Carrying out a stop: the holds it makes, and the live work they cover ended and recorded. Nothing
 * is said about it (ADR 0101): a stop shows as the work stopping, and your next word goes on.
 */
import { type Message, type ControlScope, type HoldScope, type Hold, type Turn, type HeldTurn } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import { botPlanScopeId } from "../../store";
import type { HoldRequest, StopDeps } from "../stop";
import type { StopReach } from "./reach";

type Ended = { turn: Turn; record: HeldTurn; hold: string };

export function createStopCarryOut(deps: StopDeps, reach: StopReach) {
  const { store, publishTurn, lives, executionOf, abortLive } = deps;
  const { handedOn, on, heldTurn, turnRow } = reach;

  // ── Stopping ──────────────────────────────────────────────────────────────────────────────────

  function stopByLine(message: Message, scopes: ControlScope[]): void {
    carryOut(() => scopes.map((scope) => holdOn(scope, { source: "user_text", sourceMessageId: message.id })), message.session_id);
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
   * A stop in one write: the holds `create` makes, every live turn they cover ended, and what beside
   * it goes on recorded, with `sessionId` — the conversation it was said or chosen in — in the work
   * log. The aborts and the publishing follow once it is written. Nothing is said in the
   * conversation (ADR 0101): what it ended is on the holds (`effect`), for the board.
   */
  function carryOut(create: () => Hold[], sessionId: string | null): { made: Hold[] } {
    const result = store.transaction(() => {
      const created = create();
      const ended = endCovered(created);
      const made = settle(created, ended, sessionId);
      return { ended, made };
    });
    for (const { turn } of result.ended) publishTurn(turn, null);
    return { made: result.made };
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
      sessionId,
    );
    return made[0]!;
  }

  /**
   * The spend cap's stop (ADR 0088): one hold on everything, made by the app, that no line of yours
   * lifts — only your Lift in the bar above the list does. Every live turn it covers ends as at any
   * stop. The bar above the list says it.
   */
  function holdForSpendCap(): Hold {
    const { made } = carryOut(() => [store.createHold({ scope: "global", source: "spend_cap", liftOnNextUserMessage: false, targets: [] })], null);
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
   * What goes on beside what was ended, measured now and recorded on each hold: the other
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

  return { stopByLine, holdOn, carryOut, stopByButton, hold, holdForSpendCap, enforce, endViolations, splitHold };
}

export type StopCarryOut = ReturnType<typeof createStopCarryOut>;
