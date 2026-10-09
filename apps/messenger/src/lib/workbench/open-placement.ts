/**
 * Where each kind of window opens on the workbench when it is not open yet.
 *
 * Something already on screen is only brought forward — a conversation's one preview, one trace,
 * board and spec, the one calendar and ledger turn or come forward where they are — so this only
 * ever decides where a new tab goes: beside the one in front, over it, in a pane split off in some
 * direction, in the pane already there on that side, or floating. The choice is per browser, like
 * the layout it shapes (ADR 0025): it lives in this machine's storage, not the daemon.
 */
import type { SessionGroup } from "../sidebar/session-groups.ts";
import { forgetStored, readStored, writeStored } from "../storage.ts";
import type { PaneContent } from "./pane-content.ts";

/**
 * The kinds of window, as the settings list them. Conversations split in two: a Bot↔Bot direct is
 * mostly opened from a card in your own conversation, to read beside it. The job's three views are
 * three kinds, since each is a tab of its own.
 */
export type OpenKind =
  | "chat"
  | "bot-bot"
  | "trace"
  | "board"
  | "spec"
  | "preview"
  | "workspace"
  | "terminal"
  | "routines"
  | "spend";

export const OPEN_KINDS: readonly OpenKind[] = [
  "chat",
  "bot-bot",
  "trace",
  "board",
  "spec",
  "preview",
  "workspace",
  "terminal",
  "routines",
  "spend",
];

/**
 * - `tab`: a new tab in the pane the keyboard is in, brought forward.
 * - `tab-background`: the same, left behind the one in front; the keyboard stays where it is.
 * - `replace`: in place of the same kind of window in front of you — in the pane the keyboard is
 *   in, else the nearest pane showing one. A new tab when none does, or when that one holds an
 *   unsaved edit.
 * - `split-*`: the pane the keyboard is in is divided that way and the new pane takes it.
 * - `side-*`: into the pane next door on that side; when the keyboard is already in that side's
 *   pane, into it; only when neither is there, split off that way. Opening one file after another
 *   stacks them in one pane instead of dividing the window again each time.
 * - `float`: a pane of its own over the layout, in the middle.
 */
export type OpenPlacement =
  | "tab"
  | "tab-background"
  | "replace"
  | "split-left"
  | "split-right"
  | "split-up"
  | "split-down"
  | "side-left"
  | "side-right"
  | "side-up"
  | "side-down"
  | "float";

export type OpenPlacementGroup = "tabs" | "split" | "side" | "float";

/** The choices in the order the picker lists them, under their heading. */
export const OPEN_PLACEMENT_GROUPS: readonly { group: OpenPlacementGroup; placements: readonly OpenPlacement[] }[] = [
  { group: "tabs", placements: ["tab", "replace", "tab-background"] },
  { group: "split", placements: ["split-right", "split-down", "split-left", "split-up"] },
  { group: "side", placements: ["side-right", "side-down", "side-left", "side-up"] },
  { group: "float", placements: ["float"] },
];

export const OPEN_PLACEMENTS: readonly OpenPlacement[] = OPEN_PLACEMENT_GROUPS.flatMap((row) => row.placements);

const PLACEMENT_SET: ReadonlySet<string> = new Set(OPEN_PLACEMENTS);
const KIND_SET: ReadonlySet<string> = new Set(OPEN_KINDS);

/**
 * What a new install does. Going through conversations one after another replaces the one you are
 * reading instead of piling up tabs; what belongs to a conversation — its files, its job's views,
 * a direct between its Bots, the workspace — opens in a column beside it, so reading it never hides
 * the conversation; a terminal goes under, as in an editor; the calendar and the ledger are big
 * enough to want a pane to themselves.
 */
export const OPEN_PLACEMENT_DEFAULTS: Readonly<Record<OpenKind, OpenPlacement>> = {
  chat: "replace",
  "bot-bot": "side-right",
  trace: "side-right",
  board: "side-right",
  spec: "side-right",
  preview: "side-right",
  workspace: "side-right",
  terminal: "side-down",
  routines: "tab",
  spend: "tab",
};

export function isOpenPlacement(value: unknown): value is OpenPlacement {
  return typeof value === "string" && PLACEMENT_SET.has(value);
}

/** Which kind of window this content is, for its placement. `groupOf` reads a conversation's kind. */
export function openKindOf(content: PaneContent, groupOf: (sessionId: string) => SessionGroup | null): OpenKind {
  switch (content.kind) {
    case "chat":
      return groupOf(content.sessionId) === "bot-bot" ? "bot-bot" : "chat";
    case "trace":
      return content.view ?? "trace";
    default:
      return content.kind;
  }
}

const STORAGE_KEY = "real-bot-open-placement";

export type OpenPlacements = Record<OpenKind, OpenPlacement>;

/** The choices kept on this machine over the defaults. A kind or a value this build does not know is dropped. */
export function loadOpenPlacements(): OpenPlacements {
  const choices: OpenPlacements = { ...OPEN_PLACEMENT_DEFAULTS };
  const raw = readStored(STORAGE_KEY);
  if (!raw) return choices;
  try {
    const kept: unknown = JSON.parse(raw);
    if (!kept || typeof kept !== "object" || Array.isArray(kept)) return choices;
    for (const [kind, value] of Object.entries(kept)) {
      if (KIND_SET.has(kind) && isOpenPlacement(value)) choices[kind as OpenKind] = value;
    }
  } catch {
    // Unreadable: the defaults, as with any setting kept here.
  }
  return choices;
}

/** Only what differs from the defaults is kept, so a better default reaches everyone who never chose. */
export function saveOpenPlacements(choices: OpenPlacements): void {
  const changed: Partial<OpenPlacements> = {};
  for (const kind of OPEN_KINDS) {
    if (choices[kind] !== OPEN_PLACEMENT_DEFAULTS[kind]) changed[kind] = choices[kind];
  }
  if (Object.keys(changed).length === 0) forgetStored(STORAGE_KEY);
  else writeStored(STORAGE_KEY, JSON.stringify(changed));
}

export function forgetOpenPlacements(): void {
  forgetStored(STORAGE_KEY);
}
