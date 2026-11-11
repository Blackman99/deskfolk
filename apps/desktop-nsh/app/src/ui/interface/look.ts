/**
 * The NSH side of the window's interface controller (ADR 0108): what the mirrored controller
 * (`m/interface/controller.svelte.ts`) asks of the platform, where the Svelte used the document.
 *
 * - painting: the profile's tokens as the theme (`theme.ts`), or the app's own;
 * - the floor: contrast of each `floor()` against its grounds, the app's theme as the yardstick;
 * - the way back: ⌥⇧⌘U (Ctrl+Alt+Shift+U elsewhere), bound while the window lives and heard in
 *   inputs too; nothing else binds it, and the newest binding of a key wins in NSH;
 * - the kind of window: desktop, the hosted tablet, or a phone (680 wide or less).
 *
 * `wireInterfaceHere` is the shell's hook-up (`shell-state.ts`), and a story's: the mirror's
 * `wireInterface` with this look, plus the bindings that live with the component that calls it.
 */
import { colorScheme, effect, keymap, untracked } from "nsh";
import type { InterfaceLook } from "../../m/interface/controller.svelte.ts";
import { surfaceOf } from "../../m/interface/apply.ts";
import { wireInterface } from "../../m/interface/wire.svelte.ts";
import { NARROW_MAX_WIDTH } from "../../m/workbench/surface.ts";
import { widthAtMost } from "../../platform/viewport";
import { floorsHiddenByProfile, onFloorsMoved } from "./floor";
import { paintProfile } from "./theme";

type Hooks = Parameters<InterfaceLook["start"]>[0];

let hooks: Hooks | null = null;

const surfaceNow = () => surfaceOf(widthAtMost(NARROW_MAX_WIDTH));

export const nshLook: InterfaceLook = {
  paint: (profile, on) => void paintProfile(profile, on),
  floorsHidden: () => floorsHiddenByProfile(),
  start(next) {
    hooks = next;
    onFloorsMoved(() => hooks?.floors());
    next.surface(untracked(surfaceNow));
    return () => {
      if (hooks !== next) return;
      hooks = null;
      onFloorsMoved(null);
    };
  },
};

/** The way back, as `keymap` writes it. */
export const ESCAPE_KEY = "mod+alt+shift+u";

/** Applies your interface profile in this window and keeps its floor (call while a component renders). */
export function wireInterfaceHere(source: Omit<Parameters<typeof wireInterface>[0], "look">): void {
  wireInterface({ ...source, look: nshLook });
  try {
    keymap.bind(ESCAPE_KEY, () => hooks?.escape(), { when: "always" });
  } catch (error) {
    console.warn(`interface: cannot bind ${ESCAPE_KEY}: ${String(error)}`);
  }
  // A floor's contrast is the look's: light and dark are checked each in turn.
  let first = true;
  effect(() => {
    colorScheme();
    if (first) {
      first = false;
      return;
    }
    untracked(() => hooks?.floors());
  });
  effect(() => {
    const surface = surfaceNow();
    untracked(() => hooks?.surface(surface));
  });
}
