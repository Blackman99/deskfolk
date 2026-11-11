/**
 * What the workbench components share beyond the mirrored layout types (`src/m/workbench/layout-types.ts`).
 * A Svelte snippet becomes a render function: a tab's picture, its body, its label.
 */
import type { JSX } from "nsh";
import type { TabAction as MirroredTabAction, TabClosing, WorkbenchTab } from "../../m/workbench/layout-types.ts";

/** Something a tab offers to do: `icon` is the host's picture, drawn at the start of the row. */
export type TabAction = Omit<MirroredTabAction, "icon"> & { icon?: () => JSX.Element };

export type { TabClosing, WorkbenchTab };

/** A drag as a host feeds it to the workbench: the three moments of a press that moved. */
export type DragPhase = "start" | "move" | "end" | "cancel";

/** Where a drag is, in the window (page) coordinates, and how far it has come. */
export type DragPoint = { x: number; y: number; dx: number; dy: number };

/** The shell's render props. */
export type TabBody = (tab: WorkbenchTab, leafId: string) => JSX.Element;
export type TabLabel = (tab: WorkbenchTab) => JSX.Element;
export type LeafRender = (leafId: string) => JSX.Element;
/** The strip's + menu body: the pane, what was typed in its filter, and a way to close the menu. */
export type MenuRender = (leafId: string, query: string, close: () => void) => JSX.Element;

/**
 * One pane's strip, row and tabs as the drop zones need them, in the window's coordinates: the
 * strip, where the row shows and where its first tab starts (scrolled out of view or not), and each
 * tab's width. Measured when a drag starts or its row has just scrolled.
 */
export type MeasuredRow = {
  strip: { x: number; y: number; width: number; height: number };
  visible: { x: number; width: number };
  start: number;
  widths: number[];
};

/** What a pane's strip lets the workbench do with its tab row while a tab is dragged over it. */
export type RowHandle = {
  measure: () => Promise<MeasuredRow | null>;
  /** Scrolls the row sideways by `dx`; false where it did not move (at its end). */
  scrollBy: (dx: number) => boolean;
};

/** Each pane's strip says how to measure and scroll its row; the workbench asks when a drag starts. */
export type RowRegistry = Map<string, RowHandle>;
