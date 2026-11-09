/**
 * The window's frosted material and what lies on it (`base.css`, `Shell.svelte`, `WorkbenchLeaf.svelte`
 * under `data-material="glass"`). The host puts the system's sidebar material behind the app on macOS
 * (`host/src/window.rs`) and says so in `host.params.material`; every other target has none.
 *
 * Where there is material the shell's ground covers it only in part (`bg-ground-glass`: light 30%,
 * dark 20%), so the sidebar and the gutters between the cards show the glass. Dark glass is lighter
 * than the dark cards, and glass that clear takes the colour of whatever is behind each part, so
 * there a docked pane's tab strip is drawn as the card's solid head (`WorkbenchLeaf`).
 */
import { colorScheme } from "nsh";
import { glass } from "../launch";

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
