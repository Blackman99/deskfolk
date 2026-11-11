import type { InterfaceRevisionHead } from "@real-bot/protocol";
import type { Copy } from "../../m/copy.ts";
import type { Snapshot } from "../../m/snapshot.ts";

/** Who made a change: you, the Bot by name, or a Bot no longer on the roster (`revisionWho` of `InterfaceHistoryCard.svelte`). */
export function revisionWho(head: InterfaceRevisionHead, bots: Snapshot["bots"], c: Copy["ui"]["history"]): string {
  if (head.actor === "user") return c.you;
  const bot = head.bot_id ? bots.find((item) => item.id === head.bot_id) : undefined;
  return bot ? c.bot.replace("{name}", bot.name) : c.someBot;
}

/** When, as month, day and time of day (`revisionWhen`); the clock is this machine's. */
export function revisionWhen(iso: string, locale: "zh" | "en"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return date.toLocaleString(locale === "en" ? "en" : "zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    const two = (n: number) => String(n).padStart(2, "0");
    return `${date.getMonth() + 1}/${date.getDate()} ${two(date.getHours())}:${two(date.getMinutes())}`;
  }
}
