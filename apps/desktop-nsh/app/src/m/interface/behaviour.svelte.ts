// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: e04fce499a4f3437
/**
 * How the app works in this window, from your interface profile (ADR 0106): the controller writes
 * it, the places a behaviour applies read it — the composer's keys, a message's time. Reactive: a
 * template or `$derived` that reads it follows a change made in any window.
 */
import type { InterfaceBehaviour } from "@real-bot/protocol";
import { state } from "../../lib/reactive";

const current = state<InterfaceBehaviour>({});

export function interfaceBehaviour(): InterfaceBehaviour {
  return current.get();
}

export function setInterfaceBehaviour(next: InterfaceBehaviour): void {
  if (JSON.stringify(next) !== JSON.stringify(current.get())) current.set(next);
}
