/**
 * Whether to move as little as possible (ADR 0108 decision 4): your interface profile's
 * `motion: "reduce"`, or the system asking. NSH's own `reduceMotion()` hears only the system and
 * nothing overrides it, so the app reads this one instead (reactive, like NSH's). `motion-reduce:`
 * classes follow the system only; motion the app writes reads this.
 */
import { context, reduceMotion as systemReducesMotion } from "nsh";
import { interfaceBehaviour } from "../../m/interface/behaviour.svelte";

export function reduceMotion(): boolean {
  return interfaceBehaviour().motion === "reduce" || systemReducesMotion();
}

/**
 * Whether looping motion holds still here (an accessor; read the context while the component
 * renders): true in the phone's roster while a page covers it (`Shell`). A folk's blink and work
 * and a working Bot's pulse stop there. On the web NSH steps every running animation and writes
 * every bound animated value on every animation frame, so loops no one could see kept the page
 * drawing frames, and made each of them dearer.
 */
export const LoopsHeld = context<() => boolean>(() => false);
