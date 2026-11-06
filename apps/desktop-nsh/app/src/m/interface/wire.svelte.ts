// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: 3a24c91eb197af58
import { effect } from "../../lib/reactive";
/**
 * Shell's hook-up of your interface profile (ADR 0106): starts this window's controller once,
 * feeds it the daemon's profile whenever the snapshot moves (only once connected, so a start never
 * drops the look it painted from the last one), and says in a toast when a Bot changed it from
 * elsewhere, when a floor made this window drop it, and when a key paused or resumed it.
 */
import { onMount, untrack } from "../../lib/reactive";
import type { Bot, InterfaceState } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import { showToast } from "../toast.svelte.ts";
import { escapeKeyLabel, interfaceController, type InterfaceApi } from "./controller.svelte.ts";

export function wireInterface(source: {
  connected: () => boolean;
  api: () => InterfaceApi | null;
  state: () => InterfaceState | null;
  bots: () => readonly Bot[];
  t: () => Copy;
}): void {
  let lastSeen: string | null | undefined;

  onMount(() => interfaceController.start({
    api: source.api(),
    notices: {
      floorFailed: (failures) => {
        const t = source.t();
        const floor = failures[0]?.floor ?? "";
        showToast(t.ui.toast.floorFailed.replace("{floor}", (t.ui.floors as Record<string, string>)[floor] ?? floor), { tone: "error" });
      },
      paused: () => showToast(source.t().ui.toast.paused.replace("{key}", escapeKeyLabel()), { tone: "info" }),
      resumed: () => showToast(source.t().ui.toast.resumed, { tone: "info" }),
    },
  }));

  effect(() => {
    if (!source.connected()) return;
    const api = source.api();
    const state = source.state();
    untrack(() => {
      interfaceController.connect(api);
      interfaceController.sync(state);
      // A Bot's change arriving here, after the first answer: say who.
      const head = state?.recent[0];
      if (lastSeen !== undefined && head && head.id !== lastSeen && head.actor === "bot") {
        const t = source.t();
        const name = source.bots().find((bot) => bot.id === head.bot_id)?.name ?? t.ui.history.someBot;
        showToast(t.ui.toast.changedBy.replace("{name}", name), { tone: "info" });
      }
      lastSeen = head?.id ?? null;
    });
  });
}
