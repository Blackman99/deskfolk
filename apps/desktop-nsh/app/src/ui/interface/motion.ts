/**
 * Whether to move as little as possible (ADR 0108 decision 4): your interface profile's
 * `motion: "reduce"`, or the system asking. NSH's own `reduceMotion()` hears only the system and
 * nothing overrides it, so the app reads this one instead (reactive, like NSH's). `motion-reduce:`
 * classes follow the system only; motion the app writes reads this.
 */
import { reduceMotion as systemReducesMotion } from "nsh";
import { interfaceBehaviour } from "../../m/interface/behaviour.svelte";

export function reduceMotion(): boolean {
  return interfaceBehaviour().motion === "reduce" || systemReducesMotion();
}
