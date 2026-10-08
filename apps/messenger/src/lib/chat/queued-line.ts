import { USER_MEMBER, type Message, type Turn } from "@real-bot/protocol";

/**
 * Where a line of yours stands while no Bot has read it yet (ADR 0069), as the row under it says:
 * `next_step` — its Bot is at work, and reads it at its next step; `its_turn` — it waits for that
 * Bot's next turn or job slot; `held` — a stop of yours holds it until the stop lifts.
 */
export type QueuedLineWait = "next_step" | "its_turn" | "held";

export type QueuedLine = {
  wait: QueuedLineWait;
  /** 直接插入: its Bot is at work on a step that can be cut for it. */
  canInsert: boolean;
  /** 撤回: still unread, and this is somewhere you can write. */
  canWithdraw: boolean;
};

/**
 * The row under a line of yours still waiting for a Bot to read it, or null when there is none to
 * show: a line read already, taken back, carried out by the app, not yours, or a daemon that cannot
 * take a line back or have it read now. The daemon decides again when either button is pressed.
 */
export function queuedLine(
  message: Message,
  opts: { queuedLineActions: boolean; connected: boolean; lockedComposer: boolean; turnsHere: readonly Turn[] },
): QueuedLine | null {
  if (!opts.queuedLineActions || message.kind !== "user" || message.author !== USER_MEMBER) return null;
  if (message.withdrawn_at || message.taken_as) return null;
  const delivery = message.delivery;
  if (!delivery || (delivery.state !== "queued" && delivery.state !== "held")) return null;
  const writable = opts.connected && !opts.lockedComposer;
  if (delivery.state === "held") return { wait: "held", canInsert: false, canWithdraw: writable };
  const working = opts.turnsHere.some(
    (turn) => turn.bot_id === delivery.bot_id && turn.status === "running" && turn.mode !== "readonly",
  );
  return { wait: working ? "next_step" : "its_turn", canInsert: working && writable, canWithdraw: writable };
}
