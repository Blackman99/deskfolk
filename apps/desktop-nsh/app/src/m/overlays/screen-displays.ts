/**
 * A Mac's screens on the remote screen page. macOS Screen Sharing sends all of a Mac's screens as
 * one picture unless asked for one (`app/native/src/rfb/displays.rs`); the page asks for the main
 * screen by default, or for the one picked last on this phone, and lists the screens to switch.
 * The Mac names them by id only, so the list says which is the main one and where each other one
 * sits from it, as the Mac arranges them in System Settings → Displays.
 */
import { forgetStored, readStored, writeStored } from "../storage.ts";

/** One screen as the native client reports it: its id, and its place in points (y grows down). */
export type ScreenDisplay = { id: number; main: boolean; x: number; y: number; width: number; height: number };

/** What the page asks for: the main screen, all of them, or one by id. */
export type DisplayChoice = "main" | "all" | number;

export type Side = { h: "left" | "right" | null; v: "above" | "below" | null };

/** A row of the picker: the main screen's `number` is null, the others count on from 2. */
export type DisplayEntry = { display: ScreenDisplay; number: number | null; side: Side };

const KEY = "real-bot-screen-display";

export function loadDisplayChoice(): DisplayChoice {
  const raw = readStored(KEY);
  if (raw === "all") return "all";
  const id = Number(raw);
  return raw && Number.isInteger(id) && id > 0 ? id : "main";
}

export function saveDisplayChoice(choice: DisplayChoice): void {
  if (choice === "main") forgetStored(KEY);
  else writeStored(KEY, String(choice));
}

/** The number `Screens.selectDisplay` takes: below 0 all, 0 the main screen, else an id. */
export function choiceNumber(choice: DisplayChoice): number {
  return choice === "all" ? -1 : choice === "main" ? 0 : choice;
}

/** The choice that keeps showing this screen: the main one is followed as "main", even if another becomes main. */
export function choiceOf(display: ScreenDisplay | null): DisplayChoice {
  return display === null ? "all" : display.main ? "main" : display.id;
}

/** Where `d` sits from `main`, by its middle against the main screen's edges. */
export function sideOf(d: ScreenDisplay, main: ScreenDisplay): Side {
  const cx = d.x + d.width / 2;
  const cy = d.y + d.height / 2;
  return {
    h: cx < main.x ? "left" : cx > main.x + main.width ? "right" : null,
    v: cy < main.y ? "above" : cy > main.y + main.height ? "below" : null,
  };
}

/** The main screen first, then the others left to right (top to bottom where they line up). */
export function displayEntries(displays: ScreenDisplay[]): DisplayEntry[] {
  const main = displays.find((d) => d.main) ?? displays[0];
  if (!main) return [];
  const others = displays.filter((d) => d !== main).sort((a, b) => a.x - b.x || a.y - b.y);
  return [
    { display: main, number: null, side: { h: null, v: null } },
    ...others.map((d, i) => ({ display: d, number: i + 2, side: sideOf(d, main) })),
  ];
}
