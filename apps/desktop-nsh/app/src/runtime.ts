/**
 * This window's runtime: the messenger's own (`src/m/runtime.svelte.ts`), one per window as each
 * Tauri window had one. Its connection loop finds the runtime through the Tauri bridge on a
 * desktop and through the page on the web, then keeps the snapshot current; screens read
 * `runtime.snapshot` and call its actions.
 */
import { copyFor } from "./m/copy.ts";
import { interfaceController } from "./m/interface/controller.svelte.ts";
import { MessengerRuntime } from "./m/runtime.svelte.ts";

export const runtime = new MessengerRuntime();

/**
 * The copy for the runtime's language, with the words your interface profile changed laid over it
 * (ADR 0106, `Shell.svelte`'s `t`): not while the profile is off or the address asks for the default.
 */
export function copy() {
  const locale = runtime.snapshot.settings.locale === "en" ? "en" : "zh";
  return copyFor(locale, interfaceController.copyIn(locale));
}
