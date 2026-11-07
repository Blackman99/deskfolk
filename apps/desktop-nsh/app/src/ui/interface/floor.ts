/**
 * The floor on NSH (ADR 0108 decisions 7 and 8): what keeps you in charge — Stop, the approval
 * buttons, the ask card, the way to Settings, pausing the custom interface and undoing a change
 * (`UI_FLOORS`) — marks itself with `ref={floor(name, colours)}`, naming the theme token its words
 * or glyph are drawn in and the grounds under it, bottom first. A token can only change colours in
 * NSH, so what a profile can break is contrast: each floor that is laid out (at least 12×12) must
 * keep 3:1 between its words and its grounds, and only counts against the profile when the app's
 * own theme passes it.
 *
 * Call `floor()` while the component renders (in its JSX): it leaves the register with the
 * component. The colours may be a function, read at each check, null while the view is no floor
 * (a Send button that is a Stop only while a reply runs).
 */
import { cleanup, colorScheme, signal, untracked, type ViewRef } from "nsh";
import type { UiFloor } from "@real-bot/protocol";
import type { FloorFailure } from "../../m/interface/floor.ts";
import { FLOOR_MIN_CONTRAST, inkContrast } from "./contrast";
import { tokensNow, tokensOfApp } from "./theme";

/** The theme tokens a floor is drawn with: its words or glyph, and its grounds from the bottom up. */
export type FloorColours = { ink: string; ground: readonly string[] };

type Entry = { name: UiFloor; colours: () => FloorColours | null; node: ViewRef | null };

const entries = new Set<Entry>();
const marked = signal(0);
let moved: (() => void) | null = null;

/** Who hears that a floor appeared (the window's look, ADR 0108); one at a time. */
export function onFloorsMoved(listener: (() => void) | null): void {
  moved = listener;
}

/** Marks the view as floor `name`; its colours are read at each check. Returns the view's `ref`. */
export function floor(name: UiFloor, colours: FloorColours | (() => FloorColours | null)): (node: ViewRef) => void {
  const entry: Entry = { name, colours: typeof colours === "function" ? colours : () => colours, node: null };
  entries.add(entry);
  untracked(() => marked.set(entries.size));
  cleanup(() => {
    entries.delete(entry);
    untracked(() => marked.set(entries.size));
  });
  return (node) => {
    entry.node = node;
    moved?.();
  };
}

/** The floors on screen now, with their colours: in the tree and at least 12×12. */
async function shown(): Promise<Array<{ name: UiFloor; colours: FloorColours }>> {
  const out: Array<{ name: UiFloor; colours: FloorColours }> = [];
  for (const entry of [...entries]) {
    const colours = untracked(entry.colours);
    if (!colours || !entry.node) continue;
    const box = await entry.node.measure().catch(() => null);
    if (!box || box.bounds.size.width < 12 || box.bounds.size.height < 12) continue;
    out.push({ name: entry.name, colours });
  }
  return out;
}

/** The window's own ground under every floor's. */
const WINDOW = "bg";

/** The floors the theme in force leaves under 3:1 that the app's own theme does not. */
export async function floorsHiddenByProfile(): Promise<FloorFailure[]> {
  const floors = await shown();
  if (floors.length === 0) return [];
  const names = [...new Set(floors.flatMap(({ colours }) => [colours.ink, WINDOW, ...colours.ground]))];
  const dark = untracked(colorScheme) === "dark";
  const mine = tokensNow(names);
  const app = tokensOfApp(names);
  const ratio = (values: Record<string, unknown>, colours: FloorColours) =>
    inkContrast(values[colours.ink], [values[WINDOW], ...colours.ground.map((name) => values[name])], dark);
  const out: FloorFailure[] = [];
  for (const { name, colours } of floors) {
    const now = ratio(mine, colours);
    if (now >= FLOOR_MIN_CONTRAST || ratio(app, colours) < FLOOR_MIN_CONTRAST) continue;
    const why = `contrast ${now.toFixed(2)}:1 (${colours.ink} on ${[...colours.ground].reverse().join(" over ") || WINDOW})`;
    if (!out.some((failure) => failure.floor === name && failure.why === why)) out.push({ floor: name, why });
  }
  return out;
}

/** How many floors are marked now, shown or not (reactive). */
export function floorCount(): number {
  return marked();
}
