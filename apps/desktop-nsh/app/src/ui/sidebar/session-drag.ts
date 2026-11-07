/**
 * A conversation pulled out of the list onto the workbench (the Svelte rows' `onpointerdown` that
 * `Shell.svelte`'s `dragSession` answers). A row's pan reports the drag in the window's coordinates,
 * as a workbench tab's does: start, moves, then end or cancel. A press that never travels the
 * threshold is still the row's press, which opens it.
 */
import type { SessionSummary } from "@real-bot/protocol";
import { dragResponder } from "../workbench/leaf-strip";
import type { DragPhase, DragPoint } from "../workbench/types";

/** What a row reports, once the list knows whose row it is. */
export type SessionDrag = (phase: DragPhase, point: DragPoint) => void;

/** What the sidebar, the rail and the pinned roster hear: the drag, and the conversation it is of. */
export type SessionDragHandler = (phase: DragPhase, point: DragPoint, session: SessionSummary) => void;

/** The handlers to spread on a row (`{...sessionPan(() => props.onDrag)}`); nothing happens while `drag()` is unset. */
export function sessionPan(drag: () => SessionDrag | undefined) {
  return dragResponder(
    (phase, point) => drag()?.(phase, point),
    () => Boolean(drag()),
  ).panHandlers;
}
