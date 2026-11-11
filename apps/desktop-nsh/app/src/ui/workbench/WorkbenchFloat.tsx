/**
 * A pane that floats over the tiled arrangement (`WorkbenchFloat.svelte`): a card with the large
 * radius and a shadow, a hairline round it, a `WorkbenchLeaf` inside. Its strip is the title bar: a
 * press on its bare part moves the pane, a double press puts it back into the tiled arrangement.
 * Every edge and every corner resizes, so the pane can be pulled open wherever there is room.
 *
 * The frame being shown while a drag is in progress is local (`live`); the layout, and the saved
 * arrangement, stay at `frame` until the pointer is released. Pulled back inside the workbench,
 * which narrows without the window changing size (the sidebar opening, the preview opening), the
 * saved frame is not touched, so widening again puts the pane back where it was.
 */
import { PanResponder, signal, View } from "nsh";
import { copy } from "../../runtime";
import type { FloatFrame, LeafNode, PaneMin, Rect } from "../../m/workbench/layout-types.ts";
import { clampFrame, moveFrame, resizeFrame, type Handle } from "../../m/workbench/float-frame.ts";
import { dragGate } from "../../m/workbench/pane-resize.svelte.ts";
import { paneResize } from "./drag-settle";
import { shadow } from "../styles";
import { WorkbenchLeaf, type WorkbenchLeafProps } from "./WorkbenchLeaf";
import type { DragPhase, DragPoint } from "./types";

/** Every edge and every corner. */
const HANDLES: Handle[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

/** The grip's box, straddling the edge: half outside, where the pointer finds an edge without landing on the content. */
function gripStyle(handle: Handle) {
  const edge = { position: "absolute", zIndex: 36 } as const;
  switch (handle) {
    case "n": return { ...edge, left: 10, right: 10, top: -4, height: 8, cursor: "ns-resize" } as const;
    case "s": return { ...edge, left: 10, right: 10, bottom: -4, height: 8, cursor: "ns-resize" } as const;
    case "w": return { ...edge, top: 10, bottom: 10, left: -4, width: 8, cursor: "ew-resize" } as const;
    case "e": return { ...edge, top: 10, bottom: 10, right: -4, width: 8, cursor: "ew-resize" } as const;
    case "nw": return { ...edge, left: -4, top: -4, width: 14, height: 14, cursor: "nwse-resize" } as const;
    case "ne": return { ...edge, right: -4, top: -4, width: 14, height: 14, cursor: "nesw-resize" } as const;
    case "sw": return { ...edge, left: -4, bottom: -4, width: 14, height: 14, cursor: "nesw-resize" } as const;
    case "se": return { ...edge, right: -4, bottom: -4, width: 14, height: 14, cursor: "nwse-resize" } as const;
  }
}

export type WorkbenchFloatProps = Omit<WorkbenchLeafProps, "focused" | "divided" | "floating" | "onStripDrag" | "onStripPress" | "onClosePane"> & {
  frame: FloatFrame;
  z: number;
  focused: boolean;
  min: PaneMin;
  viewport: Rect;
  onFrame: (leafId: string, frame: FloatFrame) => void;
  onClosePane?: (leafId: string) => void;
  onDock?: (leafId: string) => void;
};

export function WorkbenchFloat(props: WorkbenchFloatProps) {
  const leaf = (): LeafNode => props.leaf;
  const live = signal<FloatFrame | null>(null);
  const placed = () => (props.viewport.width > 0 && props.viewport.height > 0 ? clampFrame(props.frame, props.min, props.viewport) : props.frame);
  const shown = () => live() ?? placed();

  /** One gesture: from where the pane is when it begins, a step from how far the pointer has come. */
  function gesture(step: (origin: FloatFrame, dx: number, dy: number) => FloatFrame) {
    let origin = placed();
    let latest = origin;
    let active = false;
    const begin = () => {
      if (active) return;
      active = true;
      props.onFocus(leaf().id);
      origin = placed();
      latest = origin;
      dragGate.begin();
      paneResize.begin();
    };
    const to = (dx: number, dy: number) => {
      latest = step(origin, dx, dy);
      live.set(latest);
    };
    const finish = (commit: boolean) => {
      if (!active) return;
      active = false;
      const changed = latest.x !== origin.x || latest.y !== origin.y || latest.width !== origin.width || latest.height !== origin.height;
      try {
        if (commit && changed) props.onFrame(leaf().id, latest);
      } finally {
        dragGate.end();
        paneResize.end();
        live.set(null);
      }
    };
    return { begin, to, finish };
  }

  const moveGesture = gesture((origin, dx, dy) => moveFrame(origin, dx, dy, props.min, props.viewport));
  const onStripDrag = (_leafId: string, phase: DragPhase, point: DragPoint) => {
    if (phase === "start") moveGesture.begin();
    else if (phase === "move") moveGesture.to(point.dx, point.dy);
    else moveGesture.finish(phase === "end");
  };

  const grip = (handle: Handle) => {
    const g = gesture((origin, dx, dy) => resizeFrame(origin, handle, dx, dy, props.min, props.viewport));
    const pan = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => g.begin(),
      onPanResponderMove: (_e, s) => g.to(s.dx, s.dy),
      onPanResponderRelease: (_e, s) => {
        g.to(s.dx, s.dy);
        g.finish(true);
      },
      onPanResponderTerminate: () => g.finish(false),
    });
    // Out of the tab order: they answer the pointer only.
    return (
      <View
        role="button"
        testID={`wb-grip-${handle}`}
        accessibilityLabel={copy().pane.resize}
        focusable={false}
        style={gripStyle(handle)}
        {...pan.panHandlers}
      />
    );
  };

  return (
    <View
      testID={`wb-float-${leaf().id}`}
      class="absolute border border-line rounded-(--radius-lg) bg-pane"
      style={{
        left: shown().x,
        top: shown().y,
        width: shown().width,
        height: shown().height,
        zIndex: 40 + props.z,
        boxShadow: shadow(props.focused ? "lg" : "md"),
      }}
    >
      <WorkbenchLeaf
        leaf={leaf()}
        focused={props.focused}
        divided
        floating
        tabBody={props.tabBody}
        tabLabel={props.tabLabel}
        onFocus={props.onFocus}
        onActivate={props.onActivate}
        onCloseTab={props.onCloseTab}
        tabClosing={props.tabClosing}
        tabFloating={props.tabFloating}
        onClosePane={props.onClosePane}
        draggedTab={props.draggedTab}
        onTabDrag={props.onTabDrag}
        onStripDrag={onStripDrag}
        onStripPress={(leafId, e) => {
          // The strip is the title bar: a double press on its bare part puts the pane back into the tiled arrangement.
          if (e.clickCount === 2) props.onDock?.(leafId);
        }}
        onPaneMenu={props.onPaneMenu}
        onMenu={props.onMenu}
        emptyActions={props.emptyActions}
        emptyLead={props.emptyLead}
        menuActions={props.menuActions}
        tabActions={props.tabActions}
        rows={props.rows}
      />
      {HANDLES.map(grip)}
    </View>
  );
}
