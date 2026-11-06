/**
 * What `TunePicker.svelte`'s script holds, as one controller (the picture is `TunePicker.tsx`'s):
 * the path in focus, how far it is open (the columns side by side, or how deep the phone's sheet
 * has gone), the column the keys move in, and the walking, opening and picking. The tree it walks
 * (`tune-picker.ts`) says what each level lists; this does not know models from accounts.
 */
import { computed, signal } from "nsh";
import type { TuneFocus, TuneLevel, TuneRow, TuneTree } from "../../m/chat/tune-picker";

/** Pointing opens what is under a row after a moment, so a slanting path to the column beside it does not open every row it crosses. */
export const HOVER_INTENT_MS = 90;

export function createTune(options: { tree: () => TuneTree; disabled: () => boolean; phone: () => boolean; sheetTitle: () => string }) {
  const tree = options.tree;
  const open = signal(false);
  /** The path in focus: what each column's highlighted row is, and so what the next column lists. */
  const focus = signal<TuneFocus>({});
  /** How far the path is open; one is the first level alone. */
  const depth = signal(1);
  /** The column the arrow keys move in, and whether they moved last (its row is ringed then, not under a pointer). */
  const active = signal("");
  const keyed = signal(false);
  /** Which way the phone's sheet went last. */
  const sheetStep = signal<"forward" | "back">("forward");

  const levels = computed(() => tree().levels(focus()));
  const shown = computed(() => levels().slice(0, Math.max(1, depth())));
  /** The level the phone's sheet lists: the deepest one open. */
  const sheetLevel = (): TuneLevel => shown()[shown().length - 1]!;

  const rowsOf = (level: string): TuneRow[] => tree().rows(level, focus());
  const checkedOf = (level: string): string => tree().checked(level, focus());
  const focusOf = (level: string): string => focus()[level] ?? "";
  const opensMore = (level: string, value: string): boolean => tree().opensMore(level, value, focus());
  const isLeaf = (level: string): boolean => levels().find((entry) => entry.key === level)?.leaf === true;
  const columnOf = (level: string): number => levels().findIndex((entry) => entry.key === level);

  /** The phone sheet's heading a level down: the row it went into (an account, a model). At the top, the picker's own. */
  const sheetTitle = (): string => {
    const at = shown().length - 1;
    if (at === 0) return options.sheetTitle();
    const parent = shown()[at - 1]!.key;
    return rowsOf(parent).find((row) => row.value === focusOf(parent))?.label ?? options.sheetTitle();
  };

  /** The width every column that may open takes, so opening one never moves the others. */
  const reserve = (): number => {
    const widths = tree().room(focus()).map((entry) => entry.width);
    return widths.reduce((sum, width) => sum + width, 0) + 4 * Math.max(0, widths.length - 1);
  };

  function focusAt(level: string, value: string): void {
    const next = tree().focusAt(level, value, focus());
    if (next !== focus()) focus.set(next);
  }

  /** Puts the path through a row and opens what is under it, if anything: its column beside it, or the sheet a level down. */
  function openAt(level: string, value: string): void {
    focusAt(level, value);
    const at = columnOf(level);
    depth.set(opensMore(level, value) ? at + 2 : at + 1);
  }

  /** The column `level` opens on its own path's row, or the first one that can be taken when that row is not in it. */
  function landIn(level: string): void {
    const rows = rowsOf(level);
    if (!rows.some((row) => row.value === focusOf(level) && !row.disabled)) step(level, "first");
  }

  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  function openPicker(): void {
    if (options.disabled() || open()) return;
    focus.set(tree().start());
    depth.set(1);
    active.set(levels()[0]!.key);
    keyed.set(false);
    sheetStep.set("forward");
    open.set(true);
  }

  function close(): void {
    if (!open()) return;
    clearTimeout(hoverTimer);
    open.set(false);
  }

  /** Takes the path in focus up to `level`, as one change. */
  function commit(level: string): void {
    const picked = focus();
    close();
    tree().commit(level, picked);
  }

  /** A press or a tap: a row with something under it opens it (the sheet goes into it); a row with nothing under it is the pick. */
  function press(level: string, row: TuneRow): void {
    if (row.disabled) return;
    clearTimeout(hoverTimer);
    active.set(level);
    if (opensMore(level, row.value)) {
      sheetStep.set("forward");
      openAt(level, row.value);
      return;
    }
    focusAt(level, row.value);
    commit(level);
  }

  /** The phone sheet's Back: one level up. */
  function sheetBack(): void {
    sheetStep.set("back");
    depth.set(Math.max(1, shown().length - 1));
  }

  function hover(level: string, row: TuneRow): void {
    if (row.disabled) return;
    clearTimeout(hoverTimer);
    keyed.set(false);
    if (isLeaf(level)) {
      active.set(level);
      focusAt(level, row.value);
      return;
    }
    // Back on the row whose column is open: it stays open, and so does anything beyond it.
    const at = columnOf(level);
    if (row.value === focusOf(level) && depth() >= (opensMore(level, row.value) ? at + 2 : at + 1)) {
      active.set(level);
      return;
    }
    hoverTimer = setTimeout(() => {
      active.set(level);
      openAt(level, row.value);
    }, HOVER_INTENT_MS);
  }

  function step(level: string, by: 1 | -1 | "first" | "last"): void {
    const rows = rowsOf(level);
    if (rows.length === 0) return;
    const from = rows.findIndex((row) => row.value === focusOf(level));
    const order =
      by === "first"
        ? rows.map((_, i) => i)
        : by === "last"
          ? rows.map((_, i) => rows.length - 1 - i)
          : rows.map((_, i) => (from + by * (i + 1) + rows.length * 2) % rows.length);
    const next = order.map((i) => rows[i]!).find((row) => !row.disabled);
    if (next) focusAt(level, next.value);
  }

  /** Right, or Enter on a row with something under it: its column opens and the keys go into it. */
  function enter(): boolean {
    const at = columnOf(active());
    if (at < 0 || !opensMore(active(), focusOf(active()))) return false;
    depth.set(at + 2);
    active.set(levels()[at + 1]!.key);
    landIn(active());
    return true;
  }

  /** A key while the columns are open (desktop); true when it was the picker's. */
  function key(name: "down" | "up" | "home" | "end" | "left" | "right" | "enter" | "space" | "tab"): boolean {
    if (!open() || options.phone()) return false;
    const at = columnOf(active());
    if (name !== "enter" && name !== "space" && name !== "tab") keyed.set(true);
    switch (name) {
      case "tab":
        close();
        return false;
      case "down":
      case "up":
      case "home":
      case "end":
        step(active(), name === "down" ? 1 : name === "up" ? -1 : name === "home" ? "first" : "last");
        // Another row: what was open beside the one before closes.
        depth.set(at + 1);
        return true;
      case "right":
        enter();
        return true;
      case "left":
        // Back a column, closing the one the keys were in.
        if (at > 0) {
          depth.set(at);
          active.set(levels()[at - 1]!.key);
        }
        return true;
      case "enter":
      case "space":
        if (!enter()) commit(active());
        return true;
    }
  }

  /** A column the keys were in can go: the model in focus may take no level. */
  function settleActive(): void {
    if (open() && !shown().some((entry) => entry.key === active())) active.set(shown()[shown().length - 1]!.key);
  }

  return {
    open, focus, depth, active, keyed, sheetStep, levels, shown, sheetLevel, sheetTitle, reserve,
    rowsOf, checkedOf, focusOf, opensMore, isLeaf, columnOf,
    openPicker, close, commit, press, sheetBack, hover, key, settleActive,
    stop: () => clearTimeout(hoverTimer),
  };
}

export type Tune = ReturnType<typeof createTune>;

/** One column's measured pieces, for lining a column up with the row it came from. */
export type ColumnBox = { height: number; listTop: number; rows: Record<string, number> };

/**
 * Each column's top margin so it opens level with the row it came from (`lineUp()` in the Svelte
 * one, which measured the DOM): the first column on the edge, each next one's first row level with
 * its parent's focused row, held inside the room the columns so far take.
 */
export function columnTops(keys: readonly string[], focusOf: (level: string) => string, boxes: Record<string, ColumnBox | undefined>): number[] {
  const tops: number[] = [];
  let bottom = 0;
  keys.forEach((key, at) => {
    const box = boxes[key];
    if (at === 0 || !box) {
      tops.push(0);
      bottom = Math.max(bottom, box?.height ?? 0);
      return;
    }
    const parentKey = keys[at - 1]!;
    const parent = boxes[parentKey];
    const rowY = parent?.rows[focusOf(parentKey)];
    if (!parent || rowY === undefined) {
      tops.push(0);
      return;
    }
    const wanted = tops[at - 1]! + parent.listTop + rowY - box.listTop;
    const top = Math.max(0, Math.min(wanted, Math.max(0, bottom - box.height)));
    tops.push(top);
    bottom = Math.max(bottom, top + box.height);
  });
  return tops;
}
