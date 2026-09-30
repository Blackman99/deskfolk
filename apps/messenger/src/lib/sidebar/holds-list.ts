import type { Bot, Hold, SessionSummary } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import { classifySession, presentBotIds, youBotPeer } from "./session-groups.ts";
import { sessionTitle, type RosterLabels } from "./session-title.ts";

/**
 * Your stops as the list shows them: the ones you made, by word, button or menu. A plan parked
 * before holds existed, taken over as one, is shown where it lives — parked on the board — and
 * not here.
 */
export function listedHolds(holds: readonly Hold[]): Hold[] {
  return holds.filter((hold) => hold.source === "user_text" || hold.source === "user_button");
}

/** A stop in words, from the snapshot alone: whose work, which conversation, which job. */
export function holdLabel(
  hold: Hold,
  ctx: { bots: ReadonlyMap<string, Bot>; sessions: ReadonlyMap<string, SessionSummary>; roster: RosterLabels; t: Copy["control"] },
): string {
  const { t } = ctx;
  const botName = (id: string | undefined) => (id ? (ctx.bots.get(id)?.name ?? ctx.roster.deleted) : ctx.roster.deleted);
  const plan = hold.plan_title ?? null;
  const id = hold.scope_id ?? "";
  switch (hold.scope) {
    case "global":
      return t.scope.global;
    case "bot":
      return t.scope.bot(botName(id));
    case "session": {
      const session = ctx.sessions.get(id);
      return t.scope.session(session ? sessionTitle(session, ctx.bots, ctx.roster) || ctx.roster.deleted : ctx.roster.deleted);
    }
    case "plan":
      return plan ? t.scope.plan(plan) : t.scope.aPlan;
    case "ticket":
      return plan ? t.scope.ticket(plan) : t.scope.aPlan;
    case "bot_plan":
      return t.scope.botPlan(botName(id.split(":")[0]), plan ?? t.scope.aPlan);
    case "turn":
      // The turn's Bot is on the record of what the stop ended.
      return t.scope.turn(botName(hold.effect.stopped_turns?.[0]?.bot_id));
  }
}

/**
 * Whether a stop of yours holds a row's conversation itself, so the row says so where its last line
 * would be: a stop on the group, or on the Bot a direct is with. A stop on everything is shown once,
 * above the list, not on every row; one on a plan is shown on the board.
 */
export function sessionHeld(session: SessionSummary, holds: readonly Hold[]): boolean {
  const kind = classifySession(session);
  const bots = kind === "you-bot" ? [youBotPeer(session)] : kind === "bot-bot" ? presentBotIds(session) : [];
  return holds.some(
    (hold) =>
      (hold.scope === "session" && hold.scope_id === session.id) ||
      (hold.scope === "bot" && bots.includes(hold.scope_id)),
  );
}
