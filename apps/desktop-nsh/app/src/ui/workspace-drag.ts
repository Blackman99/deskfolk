/**
 * Dragging workspace paths out of a file tree and onto a composer (`workspace-drag.svelte.ts`),
 * for NSH: the messenger's module listens to DOM pointer events and asks `document` what is under
 * the pointer, neither of which exists here. A tree row hands `pressWorkspacePaths` a PanResponder
 * (its `panHandlers` go on the row); a composer registers its view with `workspaceDropTarget`; on
 * release the registered view whose frame holds the pointer gets what was dragged, if it takes it
 * right then. Frames are measured (`ViewRef.measure`) while the pointer moves, so `over` follows
 * a move or two behind. Where frames nest (a tree inside a pane that also takes drops), the
 * smallest one under the pointer is the target. A target that takes drops at one place in it (a
 * file tree, `ArtifactTree`: which folder) hears where the pointer is (`hover`), that it left
 * (`leave`), and where the drag was let go (`drop`'s `at`). The composers register (`ChatStage`,
 * `ProjectChat`), and so does every file tree.
 */
import { PanResponder, signal, keymap, type PanResponderInstance, type ViewRef } from "nsh";
import {
  WORKSPACE_DRAG_THRESHOLD_PX,
  type WorkspaceDragItem,
  type WorkspaceDropTarget,
} from "../m/workspace-drag.svelte.ts";
import { HOSTED_MESSENGER } from "../m/remote/mode.ts";

export { WORKSPACE_DRAG_THRESHOLD_PX, type WorkspaceDragItem, type WorkspaceDropTarget };

export type WorkspaceDrag = {
  items: WorkspaceDragItem[];
  /** What the chip under the pointer says: the name, or how many. */
  label: string;
  /** The pointer, in the window. */
  x: number;
  y: number;
  /** The target under the pointer that would take the drop, if any. */
  over: WorkspaceDropTarget | null;
};

const drag = signal<WorkspaceDrag | null>(null);
const targets = new Map<symbol, { ref: () => ViewRef | null | undefined; target: WorkspaceDropTarget }>();

export const workspaceDrag = {
  get current(): WorkspaceDrag | null {
    return drag();
  },
};

/** Registers whatever should take dragged paths; returns the function that removes it. */
export function workspaceDropTarget(ref: () => ViewRef | null | undefined, target: WorkspaceDropTarget): () => void {
  const id = Symbol("drop-target");
  targets.set(id, { ref, target });
  return () => void targets.delete(id);
}

/** The registered target whose frame holds the point, when it would take a drop now: the smallest, where frames nest. */
export async function dropTargetAt(x: number, y: number): Promise<WorkspaceDropTarget | null> {
  let hit: WorkspaceDropTarget | null = null;
  let area = Infinity;
  await Promise.all(
    [...targets.values()].map(async ({ ref, target }) => {
      const box = await ref()?.measure();
      if (!box) return;
      const { size } = box.bounds;
      const left = box.pagePosition.x;
      const top = box.pagePosition.y;
      const inside = x >= left && x <= left + size.width && y >= top && y <= top + size.height;
      if (inside && size.width * size.height < area && target.accepts()) {
        hit = target;
        area = size.width * size.height;
      }
    }),
  );
  return hit;
}

/**
 * A press on a tree row. Nothing happens until the pointer has travelled far enough to mean a
 * drag, so a press still opens the row. `items` is read at that moment, so rows picked with ⌘ or
 * Shift just before go along. A finger is left alone, as in the messenger: there it scrolls the
 * tree (taken for a drag, it held the list still on a phone), and the tree covers the conversation
 * anyway. A mouse or a pen drags. On the phone's page (`hosted`) nothing drags: no composer is ever
 * beside a tree there (no workbench at any width), and NSH's web runtime gives a touch no
 * `pointerType` to tell a finger by.
 */
export function pressWorkspacePaths(
  source: {
    items: () => WorkspaceDragItem[];
    label: (items: WorkspaceDragItem[]) => string;
  },
  hosted = HOSTED_MESSENGER,
): PanResponderInstance {
  let started = false;
  let cancelled = false;
  let off: (() => void) | null = null;
  let seq = 0;
  /** The target last told the pointer is over it, so it hears when the pointer leaves. */
  let heard: WorkspaceDropTarget | null = null;
  const leaveHeard = () => {
    heard?.leave?.();
    heard = null;
  };

  const end = () => {
    started = false;
    off?.();
    off = null;
    leaveHeard();
    drag.set(null);
  };
  const track = (x: number, y: number) => {
    const current = drag();
    if (!current) return;
    const mine = ++seq;
    drag.set({ ...current, x, y });
    void dropTargetAt(x, y).then((over) => {
      const now = drag();
      if (mine !== seq || !now) return;
      drag.set({ ...now, over });
      if (over !== heard) leaveHeard();
      heard = over;
      over?.hover?.(now.items, { x, y });
    });
  };

  return PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (e, g) =>
      !hosted && e.pointerType !== "touch" && Math.hypot(g.dx, g.dy) >= WORKSPACE_DRAG_THRESHOLD_PX && source.items().length > 0,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (_e, g) => {
      const items = source.items();
      if (items.length === 0) return;
      started = true;
      cancelled = false;
      drag.set({ items, label: source.label(items), x: g.moveX, y: g.moveY, over: null });
      /** Escape puts the paths back; the release that follows drops nothing. */
      off = keymap.bind(
        "escape",
        () => {
          cancelled = true;
          leaveHeard();
          drag.set(null);
        },
        { when: "always" },
      );
      track(g.moveX, g.moveY);
    },
    onPanResponderMove: (_e, g) => {
      if (started && !cancelled) track(g.moveX, g.moveY);
    },
    onPanResponderRelease: () => {
      const carried = drag();
      const was = started && !cancelled;
      end();
      if (!was || !carried) return;
      // Where the pointer last was: the release itself may report no position.
      void dropTargetAt(carried.x, carried.y).then((over) => over?.drop(carried.items, { x: carried.x, y: carried.y }));
    },
    onPanResponderTerminate: () => end(),
  });
}
