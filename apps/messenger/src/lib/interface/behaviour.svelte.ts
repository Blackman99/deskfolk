/**
 * How the app works in this window, from your interface profile (ADR 0106): the controller writes
 * it, the places a behaviour applies read it — the composer's keys, a message's time. Reactive: a
 * template or `$derived` that reads it follows a change made in any window.
 */
import type { InterfaceBehaviour } from "@real-bot/protocol";

let current = $state<InterfaceBehaviour>({});

export function interfaceBehaviour(): InterfaceBehaviour {
  return current;
}

export function setInterfaceBehaviour(next: InterfaceBehaviour): void {
  if (JSON.stringify(next) !== JSON.stringify(current)) current = next;
}
