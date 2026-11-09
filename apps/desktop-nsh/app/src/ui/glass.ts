/**
 * The window's frosted material and what lies on it (`base.css`, `Shell.svelte`, `WorkbenchLeaf.svelte`
 * under `data-material="glass"`). The host puts the system's sidebar material behind the app on macOS
 * (`host/src/window.rs`) and says so in `host.params.material`; every other target has none.
 *
 * Where there is material the shell's ground covers it only in part (`bg-ground-glass`: light 30%,
 * dark 20%), so the sidebar and the gutters between the cards show the glass. Dark glass is lighter
 * than the dark cards, and glass that clear takes the colour of whatever is behind each part, so
 * there a docked pane's tab strip is drawn as the card's solid head (`WorkbenchLeaf`).
 *
 * Glass content (ADR 0106, the behaviour `content_glass`; `content-glass.css`) goes one step on: a
 * docked pane's card lets the glass through too, and what lies on the card paints no ground of its
 * own, so there is one layer between you and the glass, not three. The blur is the window's own.
 * Menus, dialogs, the settings drawer, floating panes, the editor and the terminal stay solid.
 * Not carried over: a profile's `--content-glass` share (NSH's theme holds colours, not shares).
 */
import { colorScheme, context, token } from "nsh";
import { glass } from "../launch";
import { interfaceBehaviour } from "../m/interface/behaviour.svelte.ts";

/** The window has the system's material behind the app. */
export const windowGlass: boolean = glass;

/** Dark on the material: a docked pane's strip is the card's head, not left on the glass. Reactive. */
export function darkGlass(): boolean {
  return windowGlass && colorScheme() === "dark";
}

/**
 * The sidebar's quiet grey (previews, times, its icons). On the material it is `ink-muted-glass`,
 * a step lighter in dark, where the glass is lighter than the dark ground was (`Sidebar.svelte`).
 */
export const SIDE_MUTED_TEXT = windowGlass ? "text-ink-muted-glass" : "text-ink-muted";
export const SIDE_MUTED_TINT = windowGlass ? "tint-ink-muted-glass" : "tint-ink-muted";
/** The sidebar's quieter grey (the search icon), `muted-light`, raised the same way on the material. */
export const SIDE_MUTED_LIGHT_TINT = windowGlass ? "tint-muted-light-glass" : "tint-muted-light";

/**
 * How much of a glass card is kept, in percent, or null where the cards are solid (no material, or
 * `content_glass` unset or `solid`). Frosted keeps most of the card, clear lets more through; dark
 * keeps more, its glass being lighter than its cards. Reactive.
 */
export function contentGlassShare(): number | null {
  if (!windowGlass) return null;
  const level = interfaceBehaviour().content_glass;
  const dark = colorScheme() === "dark";
  if (level === "frosted") return dark ? 84 : 78;
  if (level === "clear") return dark ? 64 : 50;
  return null;
}

/** Token `name` with only `share` percent of it kept: a glass card's ground. Reactive, like `token`. */
export function glassOf(name: "pane" | "ground", share: number): string {
  return `color-mix(in srgb, ${String(token(name))} ${share}%, transparent)`;
}

/** Inside a workbench pane's body (`WorkbenchLeaf` provides it): on a glass card, see `onGlassCard`. */
export const InPaneBody = context(false);

/**
 * Whether what lies here is on a glass card and so leaves its ground to the card (`content-glass.css`:
 * `.wb-body [data-ui=chat|chat-header|transcript|preview|workspace-tree]`). A floating pane's card is
 * solid, so a clear ground on it shows the same solid card. Call in a component's setup.
 */
export function onGlassCard(): () => boolean {
  const inBody = InPaneBody();
  return () => inBody && contentGlassShare() !== null;
}
