/**
 * One division of the layout tree (`WorkbenchBranch.svelte`): its children side by side (`row`) or
 * stacked (`column`), a divider between each two, every child a leaf (`WorkbenchLeaf`) or a branch
 * again.
 *
 * The Svelte grid's `minmax(<min>px, <w>fr)` tracks are flex items here: `flex-grow` is the weight,
 * the basis zero, the floor the child's minimum size; the engine's "find the size of an fr" loop is
 * the water-filling `allocate()` reproduces for the handles. The dividers are real children, the
 * one-pixel seam between two panes, and only their hit area reaches three points into each, so the
 * line can be aimed at without a gutter taking room. No transition on the tracks, ever: a drag has
 * to follow the pointer exactly.
 */
import { computed, PanResponder, View } from "nsh";
import { copy } from "../../runtime";
import { WB_SASH_PX, type LayoutNode, type MinSizeLookup } from "../../m/workbench/layout-types.ts";
import { minSize } from "../../m/workbench/layout-geometry.ts";
import { narrowWindow } from "../Modal";
import { WorkbenchLeaf, type WorkbenchLeafProps } from "./WorkbenchLeaf";
import type { DragPhase, DragPoint } from "./types";

/** What a branch hands down to every leaf under it, unchanged. */
/** A tiled pane's strip moves the window by its bare part, never the pane (`leaf-strip`): no strip drag or press here. */
export type BranchShared = Omit<WorkbenchLeafProps, "leaf" | "focused" | "divided" | "floating" | "onStripDrag" | "onStripPress">;

export type WorkbenchBranchProps = BranchShared & {
  node: LayoutNode;
  focusId: string;
  /** More than one pane is showing, so all but the current one go quiet. */
  divided: boolean;
  mins: MinSizeLookup;
  /** A divider pressed and moved: its id (`<branch>#<index>`), the phase and where the pointer is. */
  onSashDrag: (sashId: string, phase: DragPhase, point: DragPoint) => void;
  /** The divider being dragged right now, so it keeps the accent while the pointer is down. */
  draggingSash?: string | null;
};

export function Sash(props: { id: string; vertical: boolean; active: boolean; onDrag: (phase: DragPhase, point: DragPoint) => void }) {
  let started = false;
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (_e, g) => {
      started = true;
      props.onDrag("start", { x: g.x0, y: g.y0, dx: 0, dy: 0 });
    },
    onPanResponderMove: (_e, g) => props.onDrag("move", { x: g.moveX, y: g.moveY, dx: g.dx, dy: g.dy }),
    onPanResponderRelease: (_e, g) => {
      if (started) props.onDrag("end", { x: g.moveX, y: g.moveY, dx: g.dx, dy: g.dy });
      started = false;
    },
    onPanResponderTerminate: (_e, g) => {
      if (started) props.onDrag("cancel", { x: g.moveX, y: g.moveY, dx: g.dx, dy: g.dy });
      started = false;
    },
  });
  // Between two cards the gutter is the seam: no line of its own beside the phone layout, only the grip's tint.
  const rest = () => (narrowWindow() ? "bg-line" : "bg-transparent");
  return (
    <View
      role="button"
      testID={`wb-sash-${props.id.replace("#", "-")}`}
      accessibilityLabel={copy().pane.resize}
      focusable={false}
      hitSlop={props.vertical ? { left: 4, right: 4 } : { top: 4, bottom: 4 }}
      class={`shrink-0 ${props.active ? "bg-brand" : `${rest()} hover:bg-line-hover`}`}
      style={{
        width: props.vertical ? WB_SASH_PX : undefined,
        height: props.vertical ? undefined : WB_SASH_PX,
        cursor: props.vertical ? "col-resize" : "row-resize",
        zIndex: 4,
      }}
      {...pan.panHandlers}
    />
  );
}

type Slot = { key: string; child: LayoutNode; sash: boolean };

export function WorkbenchBranch(props: WorkbenchBranchProps) {
  const branch = () => {
    const current = props.node;
    return current.type === "branch" ? current : null;
  };
  const leafOf = () => {
    const current = props.node;
    return current.type === "leaf" ? current : null;
  };

  return (
    <If
      when={branch()}
      else={
        <If when={leafOf()}>
          {(leaf) => (
            <WorkbenchLeaf
              leaf={leaf()}
              focused={leaf().id === props.focusId}
              divided={props.divided}
              tabBody={props.tabBody}
              tabLabel={props.tabLabel}
              onFocus={props.onFocus}
              onActivate={props.onActivate}
              onCloseTab={props.onCloseTab}
              tabClosing={props.tabClosing}
              tabFloating={props.tabFloating}
              onClosePane={props.onClosePane}
              draggedTab={props.draggedTab}
              draggedLeaf={props.draggedLeaf}
              onTabDrag={props.onTabDrag}
              onPaneMenu={props.onPaneMenu}
              onMenu={props.onMenu}
              emptyActions={props.emptyActions}
              emptyLead={props.emptyLead}
              menuActions={props.menuActions}
              tabActions={props.tabActions}
              rows={props.rows}
            />
          )}
        </If>
      }
    >
      {(current) => {
        const row = () => current().axis === "row";
        /**
         * The children with a divider before every one but the first; keyed so a pane keeps its content.
         * A slot keeps its object while its child is the same one (`layout-share.ts` keeps those): a new
         * slot on every move of a divider had everything a pane reads through it work again.
         */
        let kept = new Map<string, Slot>();
        const slots = computed((): Slot[] => {
          const seen = new Map<string, Slot>();
          const out: Slot[] = [];
          const add = (key: string, child: LayoutNode, sash: boolean) => {
            const before = kept.get(key);
            const slot = before && before.child === child && before.sash === sash ? before : { key, child, sash };
            seen.set(key, slot);
            out.push(slot);
          };
          current().children.forEach((child, index) => {
            if (index > 0) add(`sash-${child.id}`, child, true);
            add(child.id, child, false);
          });
          kept = seen;
          return out;
        });
        return (
          <View testID={`wb-branch-${current().id}`} class={`flex-1 min-w-0 min-h-0 overflow-hidden ${row() ? "flex-row" : "flex-col"}`}>
            <Each of={slots()} key={(slot) => slot.key}>
              {(slot) => {
                const index = () => current().children.findIndex((child) => child.id === slot().child.id);
                const sashId = () => `${current().id}#${index()}`;
                return (
                  <If
                    when={slot().sash}
                    else={
                      <View
                        testID={`wb-cell-${slot().child.id}`}
                        class="min-w-0 min-h-0"
                        style={{
                          flexGrow: current().weights[index()] ?? 1,
                          flexShrink: 1,
                          flexBasis: 0,
                          ...(row() ? { minWidth: minSize(slot().child, props.mins).width } : { minHeight: minSize(slot().child, props.mins).height }),
                        }}
                      >
                        <WorkbenchBranch
                          node={slot().child}
                          focusId={props.focusId}
                          divided={props.divided}
                          mins={props.mins}
                          tabBody={props.tabBody}
                          tabLabel={props.tabLabel}
                          onFocus={props.onFocus}
                          onActivate={props.onActivate}
                          onCloseTab={props.onCloseTab}
                          tabClosing={props.tabClosing}
                          tabFloating={props.tabFloating}
                          onClosePane={props.onClosePane}
                          onSashDrag={props.onSashDrag}
                          draggingSash={props.draggingSash}
                          draggedTab={props.draggedTab}
                          draggedLeaf={props.draggedLeaf}
                          onTabDrag={props.onTabDrag}
                          onPaneMenu={props.onPaneMenu}
                          onMenu={props.onMenu}
                          emptyActions={props.emptyActions}
                          emptyLead={props.emptyLead}
                          menuActions={props.menuActions}
                          tabActions={props.tabActions}
                          rows={props.rows}
                        />
                      </View>
                    }
                  >
                    <Sash id={sashId()} vertical={row()} active={props.draggingSash === sashId()} onDrag={(phase, point) => props.onSashDrag(sashId(), phase, point)} />
                  </If>
                );
              }}
            </Each>
          </View>
        );
      }}
    </If>
  );
}
