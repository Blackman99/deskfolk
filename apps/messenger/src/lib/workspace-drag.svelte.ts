/**
 * Dragging workspace paths out of a file tree and onto a composer.
 *
 * Pointer events, never HTML5 drag and drop: in the macOS window Tauri's own drop handler claims
 * every native drag before the page sees it, so `dragover` and `drop` never fire there (the tab
 * drag avoids it too, see `workbench/tab-drag.ts`). A tree row hands a press to
 * `pressWorkspacePaths`; a composer registers with `workspaceDropTarget`; on release, the target
 * under the pointer gets what was dragged, if it takes it right then.
 */

/** One dragged row: a workspace-relative path, and whether it is a folder. */
export type WorkspaceDragItem = { path: string; isDir: boolean };

export type WorkspaceDropTarget = {
  /** Whether a drop would be taken now: a locked composer, or one already sending, says no. */
  accepts: () => boolean;
  drop: (items: WorkspaceDragItem[]) => void;
};

export type WorkspaceDrag = {
  items: WorkspaceDragItem[];
  /** What the chip under the pointer says: the name, or how many. */
  label: string;
  x: number;
  y: number;
  /** The target under the pointer that would take the drop, if any. */
  over: Element | null;
};

/**
 * Further than a click's wobble. Past it the press is a drag, and the click the release would
 * fire is swallowed, so the row does not also open.
 */
export const WORKSPACE_DRAG_THRESHOLD_PX = 6;

const targets = new Map<Element, WorkspaceDropTarget>();
// Replaced whole on every move, never changed in place.
let drag = $state.raw<WorkspaceDrag | null>(null);

export const workspaceDrag = {
  get current(): WorkspaceDrag | null {
    return drag;
  },
};

/** `use:workspaceDropTarget={{ accepts, drop }}` on whatever should take dragged paths. */
export function workspaceDropTarget(node: Element, target: WorkspaceDropTarget) {
  targets.set(node, target);
  return {
    update(next: WorkspaceDropTarget) {
      targets.set(node, next);
    },
    destroy() {
      targets.delete(node);
    },
  };
}

/** The registered target at a point, when it would take a drop now. */
export function dropTargetAt(x: number, y: number): Element | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return null;
  for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
    const target = targets.get(el);
    if (target) return target.accepts() ? el : null;
  }
  return null;
}

/**
 * A primary-button press on a tree row. Nothing happens until the pointer has travelled far
 * enough to mean a drag, so a click still opens the row. `items` is read at that moment, so rows
 * picked with ⌘ or Shift just before go along. Touch is left alone: there the finger scrolls the
 * tree, and the tree covers the conversation anyway.
 */
export function pressWorkspacePaths(
  event: PointerEvent,
  source: { items: () => WorkspaceDragItem[]; label: (items: WorkspaceDragItem[]) => string },
): void {
  if (event.button !== 0 || event.pointerType === "touch") return;
  // Modifier clicks pick rows.
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
  const row = event.currentTarget instanceof Element ? event.currentTarget : null;
  const pointerId = event.pointerId;
  const origin = { x: event.clientX, y: event.clientY };
  let started = false;
  let cancelled = false;

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (!started) {
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < WORKSPACE_DRAG_THRESHOLD_PX) return;
      const items = source.items();
      if (items.length === 0) {
        stop();
        return;
      }
      started = true;
      // Captured, the pointer keeps reporting here over an editor, a terminal or a preview frame.
      try {
        row?.setPointerCapture(pointerId);
      } catch {
        // Nothing to capture with; moves still reach the window.
      }
      drag = { items, label: source.label(items), x: e.clientX, y: e.clientY, over: null };
      window.addEventListener("keydown", onKey, true);
    }
    if (!drag) return;
    drag = { ...drag, x: e.clientX, y: e.clientY, over: dropTargetAt(e.clientX, e.clientY) };
  };
  const finish = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    stop();
    if (!started) return;
    const carried = drag;
    drag = null;
    swallowNextClick();
    if (cancelled || e.type === "pointercancel" || !carried) return;
    const over = dropTargetAt(e.clientX, e.clientY);
    const target = over ? targets.get(over) : undefined;
    target?.drop(carried.items);
  };
  /** Escape puts the paths back; the release that follows drops nothing. */
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !drag) return;
    e.preventDefault();
    e.stopPropagation();
    cancelled = true;
    drag = null;
  };
  const noSelect = (e: Event) => e.preventDefault();
  function stop(): void {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", finish, true);
    window.removeEventListener("pointercancel", finish, true);
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("selectstart", noSelect, true);
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", finish, true);
  window.addEventListener("pointercancel", finish, true);
  document.addEventListener("selectstart", noSelect, true);
}

/**
 * Where the chip under the pointer goes: below and right of it, flipped to the other side near
 * an edge. The composer sits at the bottom of the window, where a chip below the pointer would
 * hang off the screen right where it is dropped.
 */
export function ghostPlacement(
  pointer: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const GAP = 12;
  const EDGE = 4;
  const x = pointer.x + GAP + size.width > viewport.width - EDGE ? pointer.x - GAP - size.width : pointer.x + GAP;
  const y = pointer.y + GAP + size.height > viewport.height - EDGE ? pointer.y - GAP - size.height : pointer.y + GAP;
  return { x: Math.max(EDGE, x), y: Math.max(EDGE, y) };
}

/** The click a release fires after a drag, which would open the row that was dragged. */
function swallowNextClick(): void {
  const swallow = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}
