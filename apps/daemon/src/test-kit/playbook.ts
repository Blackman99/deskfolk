import type { Store } from "../store";

/**
 * Every step on, as the app ran before engines (ADR 0085): the built-in 通用 is changed back to the
 * defaults it leaves off (the scribe, the reflection; the retrospective runs there since 2026-10-14,
 * and saying so again is harmless). For tests of those steps and for the scenario and local-API
 * harnesses, which run the app's whole pipeline.
 */
export function everyStepOn(store: Store): void {
  store.savePlaybook("general", { diff: { v: 1, steps: { scribe: { on: true }, retrospective: { on: true }, reflection: { on: true } } } });
}
