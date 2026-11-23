/**
 * Whether to move as little as possible: your interface profile's `motion: "reduce"`, or the
 * system asking (`matchMedia`, backed by NSH's `reduceMotion()` on desktop).
 */
import { interfaceBehaviour } from "./interface/behaviour.svelte.ts";

export function prefersReducedMotion(): boolean {
  if (interfaceBehaviour().motion === "reduce") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
