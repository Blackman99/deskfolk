/**
 * The window's frosted material and what lies on it (`base.css`, `Shell.svelte`, `WorkbenchLeaf.svelte`
 * under `data-material="glass"`). The host puts the system's sidebar material behind the app on macOS
 * (`host/src/window.rs`) and says so in `host.params.material`; every other target has none.
 *
 * Where there is material the shell's ground covers it only in part (`bg-ground-glass`: light 30%,
 * dark 20%), so the sidebar, the gutters between the cards and each docked pane's tab strip show the
 * glass. Dark glass is lighter than the dark cards and takes the colour of whatever is behind each
 * part, so two panes' strips can differ in tint. Dark drew the strip as the card's solid head until
 * you asked for it to lie on the glass as light's does (ADR 0107, addendum 36).
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

/**
 * The hairline round a glass card and its active tab: `--shadow-pane`'s 0.5 pt ring, drawn as a
 * border. Under a ground that is not opaque NSH 0.4.0 masks an outer shadow to outside the box, and
 * at the corners that mask is stepped: the ring showed through as a hard bright arc on every rounded
 * corner. A border is the layer's own and follows its corners. The shadow's soft drop goes through
 * the same mask, so a glass card goes without it.
 */
export const GLASS_EDGE = "border-[0.5px] border-ink/14 dark:border-ink/11";

/**
 * A line across a card: under a conversation's header, either side of a date in the transcript.
 * The ink at a share, not `line-subtle`, so it reads on whatever is under it. `line-subtle` is a
 * colour a step off the solid `pane`; on a glass card the ground is the glass, often as light as that
 * colour, and the line was gone (dark, `content_glass` clear: some 5 levels from the ground). On a
 * solid dark card this comes out near `line`, a step above `line-subtle`. Light takes less of the ink:
 * a tenth stood out on the light glass, six in a hundred is about what `line-subtle` was on white.
 */
export const SEAM_LINE = "bg-ink/6 dark:bg-ink/10";
export const SEAM_BORDER = "border-ink/6 dark:border-ink/10";

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

/** Inside a docked pane's tab strip, which lies on the window's ground (`LeafStrip` provides it): see `idleTabInk`. */
export const InDockedStrip = context<() => boolean>(() => false);

/**
 * The ink of a tab name that is not shown, with the shown tab's full ink on `group-selected`. On the
 * material, dark raises it to `ink-muted-glass` as the sidebar's quiet grey is raised: there the
 * strip lies on glass lighter than the dark ground, and `tab-idle-ink` came out at 2.9–3.5:1 over a
 * light or a warm backdrop (light's own reads about 4.5:1). Light, floating panes and the phone keep
 * `tab-idle-ink`. Call in a component's setup.
 */
export function idleTabInk(): () => string {
  const docked = InDockedStrip();
  return () =>
    windowGlass && docked() && colorScheme() === "dark" ? "text-ink-muted-glass group-selected:text-ink" : "text-tab-idle-ink group-selected:text-ink";
}
