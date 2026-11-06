/**
 * This window's runtime: the messenger's own (`src/m/runtime.svelte.ts`), one per window as each
 * Tauri window had one. Its connection loop finds the runtime through the Tauri bridge on a
 * desktop and through the page on the web, then keeps the snapshot current; screens read
 * `runtime.snapshot` and call its actions.
 */
import { copyFor } from "./m/copy.ts";
import { MessengerRuntime } from "./m/runtime.svelte.ts";

export const runtime = new MessengerRuntime();

/** The copy for the runtime's language (the interface profile's words come with its screens). */
export function copy() {
  return copyFor(runtime.snapshot.settings.locale);
}
