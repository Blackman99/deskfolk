import type { Bot, Hold, SessionSummary } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import { sessionTitle, type RosterLabels } from "./session-title.ts";

/**
 * Your stops as the list shows them: only those that wait for you to lift them, the ones you dropped
 * a job with by a button. A stop for now is never listed (ADR 0081): it ends with your next line, as
 * a stop does anywhere else. A plan parked before holds existed, taken over as one, is shown where it
 * lives — parked on the board — and not here.
 */
export function listedHolds(holds: readonly Hold[]): Hold[] {
  return holds.filter((hold) => (hold.source === "user_text" || hold.source === "user_button") && !hold.lift_on_next_user_message);
}

/** A stop in words, from the snapshot alone: whose work, which conversation, which job. */
export function holdLabel(
  hold: Hold,
  ctx: { bots: ReadonlyMap<string, Bot>; sessions: ReadonlyMap<string, SessionSummary>; roster: RosterLabels; t: Copy["control"] },
): string {
  const { t } = ctx;
  const botName = (id: string | undefined) => (id ? (ctx.bots.get(id)?.name ?? ctx.roster.deleted) : ctx.roster.deleted);
  return scopeLabel(hold, ctx, botName);
}

function scopeLabel(
  hold: Hold,
  ctx: { sessions: ReadonlyMap<string, SessionSummary>; bots: ReadonlyMap<string, Bot>; roster: RosterLabels; t: Copy["control"] },
  botName: (id: string | undefined) => string,
): string {
  const { t } = ctx;
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
