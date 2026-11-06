import type { Choice } from "../claude-models.svelte.ts";

/**
 * What a cascading picker in a composer (`TunePicker.svelte`) lists: what a conversation's runs go
 * on — an account, a model, a thinking level — where each level depends on the row picked before
 * it. A project session's (`ProjectAgentTune.svelte`) and a Bot's direct's (`BotTune.svelte`) say
 * what is under each row; the picker opens, places and walks the columns the same for both.
 */

/** A picker row: a choice, what is said of it under its name, and whether it can be taken now. */
export type TuneRow = Choice & { detail?: string; disabled?: boolean };

/** The row in focus at each level, by the level's key: the path the columns follow. */
export type TuneFocus = Record<string, string>;

/** One level of the cascade, as its column (or the phone sheet's list) shows it. */
export type TuneLevel = {
  /** Names the column in the markup (`data-tune-column`) and in its rows' ids. */
  key: string;
  heading: string;
  /** The column's width: the picker keeps room from the start for every column that may open. */
  width: number;
  /** Its rows say what they are under their names. */
  details?: boolean;
  /** Its rows open nothing: pointing at one moves the focus at once. */
  leaf?: boolean;
  /** A line under the list. */
  note?: string | null;
};

/** What the picker lists and does, each read for the path in focus. */
export type TuneTree = {
  /** The path the picker opens on: what the conversation has now. */
  start(): TuneFocus;
  /** The levels along a path, first to last. */
  levels(focus: TuneFocus): TuneLevel[];
  /** Every level that may open from the path the picker opens on, for the room the columns keep. */
  room(focus: TuneFocus): TuneLevel[];
  rows(level: string, focus: TuneFocus): TuneRow[];
  /** The checked row of a level: what the conversation would have after taking the path up to it. */
  checked(level: string, focus: TuneFocus): string;
  /** Whether a row has a level beside it. */
  opensMore(level: string, value: string, focus: TuneFocus): boolean;
  /** The path through a row; the same object when nothing moves. */
  focusAt(level: string, value: string, focus: TuneFocus): TuneFocus;
  /** Takes the path up to a level, once the picker has closed. */
  commit(level: string, focus: TuneFocus): void;
};
