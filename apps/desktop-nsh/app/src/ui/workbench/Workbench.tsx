/**
 * The wide window's tiled panes (`Workbench.svelte`): the layout tree drawn as splits
 * (`WorkbenchBranch`) and panes (`WorkbenchLeaf`: a tab strip and the active tab's body), the
 * floating panes over it (`WorkbenchFloat`), a tab dragged to another pane or to a pane's edge to
 * split it, the dividers dragged to resize, a pane's context menu and the new-pane menu. All the
 * layout logic is the messenger's own modules under `src/m/workbench/`; this file is where they meet
 * the screen. The shell passes the tab bodies and labels as render props and owns the layout: every
 * change comes back through `onLayout`.
 *
 * Differences from the Svelte workbench, all because NSH has no DOM: Alt-dragging a tab out into a
 * float works only while the mouse is heard over the workbench; typing in a pane does not make it
 * the current one (a press, a scroll or a drag in it does); a terminal's Copy and Paste come from
 * `paneEdit`, which the host answers, instead of a registry on the element; the middle button closing
 * a tab is not heard (a press carries no button); a conversation pulled in from the sidebar starts
 * through `onApi`'s `dragIn`, which the list row's own gesture drives.
 */
import { computed, effect, PanResponder, signal, Text, View, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import { onWheel } from "../../platform/wheel";
import type { FloatFrame, LayoutNode, MinSizeLookup, Rect, WorkbenchLayout } from "../../m/workbench/layout-types.ts";
import { computeGeometry } from "../../m/workbench/layout-geometry.ts";
import { leafById, tiledLeaves } from "../../m/workbench/layout-tree.ts";
import type { Point } from "../../m/workbench/drop-zones.ts";
import { beginIncomingDrag, beginLeafDrag, beginTabDrag, type IncomingTab } from "../../m/workbench/tab-drag.ts";
import type { PaneEdit } from "../../m/workbench/pane-edit.ts";
import { PaneContextMenu } from "./PaneContextMenu";
import { WorkbenchBranch } from "./WorkbenchBranch";
import { WorkbenchFloat } from "./WorkbenchFloat";
import { WorkbenchLeaf } from "./WorkbenchLeaf";
import { createPaneDrag, type DragSession } from "./workbench-drag";
import { bindWorkbenchKeys, createOps } from "./workbench-ops";
import { createResizer } from "./workbench-resize";
import { createLayoutSharer } from "./layout-share";
import type { DragPhase, DragPoint, LeafRender, MenuRender, RowRegistry, TabAction, TabBody, TabLabel, WorkbenchTab } from "./types";

/** What the shell calls on the workbench from outside it. */
export type WorkbenchApi = {
  /**
   * A drag that starts outside the workbench: a conversation pulled in from the list. The tab it
   * already has moves as if dragged by its own strip; with none, a new one is made where it is let
   * go. `point` is in the window; the session's `move` and `end` follow the pointer. Null where the
   * workbench is not wide.
   */
  dragIn: (from: IncomingTab, label: string, point: Point) => DragSession | null;
};

export type WorkbenchProps = {
  layout: WorkbenchLayout;
  mins: MinSizeLookup;
  /** False below the narrow breakpoint: only the focused pane is drawn, the tree untouched. */
  wide: boolean;
  tabBody: TabBody;
  tabLabel: TabLabel;
  /** What to call a tab in plain text, for the chip that follows the pointer during a drag. */
  tabName?: (tab: WorkbenchTab) => string;
  onLayout: (next: WorkbenchLayout) => void;
  /** The workbench's own box, each time it is measured anew: what opening a split or a float is sized against. */
  onViewport?: (viewport: Rect) => void;
  /** A floating pane moved or resized by hand, with the frame it was left at. */
  onFloatAdjusted?: (leafId: string, frame: FloatFrame) => void;
  onActivate?: (leafId: string, tabId: string) => void;
  onCloseTab?: (leafId: string, tabId: string) => void;
  /** Several of one pane's tabs at once, from a tab's menu. Left out, the workbench closes them in the layout itself. */
  onCloseTabs?: (leafId: string, tabIds: string[]) => void;
  onClosePane?: (leafId: string) => void;
  /** The strip's ⋯, where it was pressed. Left out, the strip has none. */
  onMenu?: (leafId: string, at: { x: number; y: number }) => void;
  emptyActions?: LeafRender;
  /** Under an empty pane's title: the ways to start something new. */
  emptyLead?: LeafRender;
  /** The strip's + menu. The second argument is the text typed into its filter. */
  menuActions?: MenuRender;
  /** What a tab offers for what it shows: under its ⋯, and first in a right click on it. */
  tabActions?: (leafId: string, tab: WorkbenchTab) => TabAction[];
  /** Copy and Paste for what was right-clicked when it keeps its own selection (a terminal). */
  paneEdit?: (leafId: string, tabId: string | null) => PaneEdit | null;
  /** Hands the shell what it may call. */
  onApi?: (api: WorkbenchApi) => void;
};

type PaneMenu = { leafId: string; tabId: string | null; x: number; y: number; seq: number; edit: PaneEdit | null; canCopy: boolean };

export function Workbench(props: WorkbenchProps) {
  const t = () => copy().pane;
  /** The layout with each pane, tab and params object kept while it says the same (`layout-share.ts`). */
  const share = createLayoutSharer();
  const layout = computed(() => share(props.layout));
  const wide = () => props.wide;
  let hostRef: ViewRef | null = null;
  const viewport = signal<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  /** Where the workbench is in the window: a drag reports the window's coordinates. */
  const origin = signal<Point>({ x: 0, y: 0 });
  const rows: RowRegistry = new Map();
  let nextId = 0;
  const freshId = () => `wb-${Date.now().toString(36)}-${++nextId}`;
  let alt = false;

  const geometry = () => (viewport().width > 0 && viewport().height > 0 ? computeGeometry(layout(), viewport(), props.mins) : null);
  const commit = (next: WorkbenchLayout) => props.onLayout(next);

  const ops = createOps({
    layout,
    mins: props.mins,
    viewport,
    geometry,
    wide,
    freshId,
    commit,
    tabName: (tab) => props.tabName?.(tab) ?? tab.kind,
    onFloatAdjusted: (leafId, frame) => props.onFloatAdjusted?.(leafId, frame),
    onCloseTab: (leafId, tabId) => props.onCloseTab?.(leafId, tabId),
    onCloseTabs: props.onCloseTabs ? (leafId, ids) => props.onCloseTabs?.(leafId, ids) : undefined,
    onClosePane: props.onClosePane ? (leafId) => props.onClosePane?.(leafId) : undefined,
  });

  const refreshOrigin = async () => {
    const m = await hostRef?.measure();
    if (m) origin.set({ x: m.pagePosition.x, y: m.pagePosition.y });
  };
  const toLocal = (page: Point): Point => ({ x: page.x - origin().x, y: page.y - origin().y });

  const drag = createPaneDrag({ layout, geometry, viewport, mins: props.mins, rows, freshId, commit, toLocal, refreshOrigin, alt: () => alt });
  const resizer = createResizer({ layout, geometry, mins: props.mins, commit });

  /** The arrangement being drawn: the real one, or what a divider in hand would leave. */
  const view = computed(() => {
    const live = resizer.live();
    return live ? share(live) : layout();
  });
  const viewGeometry = () => (viewport().width > 0 && viewport().height > 0 ? computeGeometry(view(), viewport(), props.mins) : null);
  /** The crossings, each keyed by its divider and its place along it: the key outlives the move, which changes the geometry's own id. */
  const junctions = () => {
    const seen = new Map<string, number>();
    return (viewGeometry()?.junctions ?? []).map((junction) => {
      const n = seen.get(junction.bar.sashId) ?? 0;
      seen.set(junction.bar.sashId, n + 1);
      return { key: `${junction.bar.sashId.replace("#", "-")}-${n}`, junction };
    });
  };
  const dividing = () => resizer.draggingSash() !== null || resizer.draggingJunction() !== null;
  /**
   * The crossing in hand, by its slot's key: its geometry id names where it stands along its divider,
   * so moving it along changed the id, and the handle being dragged went to the others' look (hidden).
   */
  const heldJunction = signal<string | null>(null);

  /** The floating panes in a fixed document order; `z` alone says which is on top. */
  const floatingInPlace = () => [...layout().floating].sort((a, b) => (a.leaf.id < b.leaf.id ? -1 : a.leaf.id > b.leaf.id ? 1 : 0));
  /** A floating pane always has the tiled tree beside it, so either one means two or more. */
  const divided = () => layout().root.type === "branch" || layout().floating.length > 0;
  const soloLeaf = () =>
    tiledLeaves(layout().root).find((leaf) => leaf.id === layout().focus.leafId) ??
    layout().floating.find((pane) => pane.leaf.id === layout().focus.leafId)?.leaf ??
    tiledLeaves(layout().root)[0];
  /** Closing the only tiled pane just empties it again, so that pane offers no × to do it with. */
  const closable = (leafId: string) => layout().root.type === "branch" || leafId !== layout().root.id;

  // Measured on layout, and again where it stands in the window (the sidebar moved it).
  const onLayoutOf = (e: { bounds: { size: { width: number; height: number } } }) => {
    const { width, height } = e.bounds.size;
    void refreshOrigin();
    if (width === viewport().width && height === viewport().height) return;
    const next = { x: 0, y: 0, width, height };
    viewport.set(next);
    props.onViewport?.(next);
  };

  /** Scrolling a pane makes it the current one, the way a press in it does. */
  onWheel(
    () => hostRef,
    (_e, at) => {
      const floats = [...layout().floating].reverse().find((pane) => at.x >= pane.frame.x && at.x <= pane.frame.x + pane.frame.width && at.y >= pane.frame.y && at.y <= pane.frame.y + pane.frame.height);
      if (floats) return ops.focus(floats.leaf.id);
      for (const [id, rect] of geometry()?.leaves ?? []) {
        if (at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height) return ops.focus(id);
      }
    },
  );

  bindWorkbenchKeys(ops.run);

  props.onApi?.({
    dragIn: (from, label, point) => (wide() ? drag.begin(beginIncomingDrag(from, point), label, true) : null),
  });

  // The strip's drags: a tab, or the whole pane by its bare part.
  let session: DragSession | null = null;
  const run = (start: () => DragSession) => (phase: DragPhase, point: DragPoint) => {
    if (phase === "start") session = start();
    else if (phase === "move") session?.move({ x: point.x, y: point.y });
    else {
      session?.end(phase === "cancel");
      session = null;
    }
  };
  const onTabDrag = (leafId: string, tabId: string, phase: DragPhase, point: DragPoint) =>
    run(() => drag.begin(beginTabDrag(leafId, tabId, { x: point.x, y: point.y }), ops.nameOf(leafId, tabId)))(phase, point);
  const onStripDrag = (leafId: string, phase: DragPhase, point: DragPoint) =>
    run(() => drag.begin(beginLeafDrag(leafId, { x: point.x, y: point.y }), ops.nameOf(leafId, null)))(phase, point);

  // A right click anywhere in a pane opens its menu, unless something inside has already answered it.
  const paneMenu = signal<PaneMenu | null>(null);
  let paneMenuSeq = 0;
  const openPaneMenu = (e: { leafId: string; tabId: string | null; x: number; y: number }) => {
    if (!wide()) return;
    const edit = props.paneEdit?.(e.leafId, e.tabId) ?? null;
    paneMenu.set({ ...e, seq: ++paneMenuSeq, edit, canCopy: edit?.canCopy() ?? false });
  };
  const menuFloating = () => {
    const open = paneMenu();
    return open ? layout().floating.some((pane) => pane.leaf.id === open.leafId) : false;
  };
  /** Read while the menu is open, so a pin toggled elsewhere is not shown the old way round. */
  const actionsOf = (leafId: string, tabId: string | null): TabAction[] => {
    if (!tabId || !props.tabActions) return [];
    const tab = ops.leafOf(leafId)?.tabs.find((candidate) => candidate.id === tabId);
    return tab ? props.tabActions(leafId, tab) : [];
  };

  /** A pane that goes away (closed, docked, healed) takes its menu with it. */
  effect(() => {
    const open = paneMenu();
    if (!open) return;
    const exists = tiledLeaves(layout().root).some((leaf) => leaf.id === open.leafId) || layout().floating.some((pane) => pane.leaf.id === open.leafId);
    if (!exists || !wide()) paneMenu.set(null);
  });

  const activate = (leafId: string, tabId: string) => props.onActivate?.(leafId, tabId);
  const closeTab = (leafId: string, tabId: string) => props.onCloseTab?.(leafId, tabId);
  const node = (): LayoutNode => view().root;

  return (
    <View
      testID="wb-root"
      ref={(n) => (hostRef = n)}
      onLayout={onLayoutOf}
      onMouseMove={(e) => (alt = e.modifiers.alt)}
      class="flex-1 min-w-0 min-h-0 relative overflow-hidden"
    >
      <If
        when={wide()}
        else={
          <If when={soloLeaf()}>
            {(leaf) => (
              <WorkbenchLeaf
                leaf={leaf()}
                focused
                tabBody={props.tabBody}
                tabLabel={props.tabLabel}
                onFocus={ops.focus}
                onActivate={activate}
                onCloseTab={closeTab}
                tabClosing={ops.closingOf}
                onClosePane={closable(leaf().id) ? ops.closePane : undefined}
                onMenu={props.onMenu}
                emptyActions={props.emptyActions}
                emptyLead={props.emptyLead}
                menuActions={props.menuActions}
                tabActions={props.tabActions}
                rows={rows}
              />
            )}
          </If>
        }
      >
        <WorkbenchBranch
          node={node()}
          focusId={layout().focus.leafId}
          divided={divided()}
          mins={props.mins}
          tabBody={props.tabBody}
          tabLabel={props.tabLabel}
          onFocus={ops.focus}
          onActivate={activate}
          onCloseTab={closeTab}
          tabClosing={ops.closingOf}
          tabFloating={ops.tabFloating}
          onClosePane={closable(layout().root.id) ? ops.closePane : undefined}
          onSashDrag={resizer.sash}
          draggingSash={resizer.draggingSash()}
          draggedTab={drag.draggedTab()}
          draggedLeaf={drag.draggedLeaf()}
          onTabDrag={onTabDrag}
          onStripDrag={onStripDrag}
          onPaneMenu={openPaneMenu}
          onMenu={props.onMenu}
          emptyActions={props.emptyActions}
          emptyLead={props.emptyLead}
          menuActions={props.menuActions}
          tabActions={props.tabActions}
          rows={rows}
        />

        <Each of={floatingInPlace()} key={(pane) => pane.leaf.id}>
          {(pane) => (
            <WorkbenchFloat
              leaf={pane().leaf}
              frame={pane().frame}
              z={layout().floating.findIndex((candidate) => candidate.leaf.id === pane().leaf.id)}
              focused={pane().leaf.id === layout().focus.leafId}
              min={drag.minOf(pane().leaf)}
              viewport={viewport()}
              tabBody={props.tabBody}
              tabLabel={props.tabLabel}
              onFrame={ops.onFloatFrame}
              onFocus={ops.focus}
              onActivate={activate}
              onCloseTab={closeTab}
              tabClosing={ops.closingOf}
              tabFloating={ops.tabFloating}
              onClosePane={ops.closePane}
              draggedTab={drag.draggedTab()}
              onTabDrag={onTabDrag}
              onDock={ops.onDock}
              onPaneMenu={openPaneMenu}
              onMenu={props.onMenu}
              emptyActions={props.emptyActions}
              emptyLead={props.emptyLead}
              menuActions={props.menuActions}
              tabActions={props.tabActions}
              rows={rows}
            />
          )}
        </Each>

        <If when={viewGeometry()}>
          {/* Handles and indicators live in one layer above the panes: a cross would otherwise draw two handles on the same point. */}
          <View accessible={false} class="absolute left-0 top-0 right-0 bottom-0" style={{ zIndex: 5, pointerEvents: "box-none" }}>
            <Each of={junctions()} key={(slot) => slot.key}>
              {(slot) => {
                const junction = () => slot().junction;
                const held = () => heldJunction() === slot().key && resizer.draggingJunction() !== null;
                let started = false;
                const pan = PanResponderFor(
                  () => junction().id,
                  (id, phase, point) => {
                    if (phase === "start") heldJunction.set(slot().key);
                    else if (phase !== "move") heldJunction.set(null);
                    resizer.junction(id, phase, point);
                  },
                  () => started,
                  (v) => (started = v),
                );
                return (
                  <View
                    role="button"
                    testID={`wb-junction-${slot().key}`}
                    accessibilityLabel={t().junction}
                    focusable={false}
                    class="absolute items-center justify-center group"
                    style={{ left: junction().point.x - 12, top: junction().point.y - 12, width: 24, height: 24, cursor: "move" }}
                    {...pan.panHandlers}
                  >
                    {/* A small diamond on the crossing, taking the accent and growing when you are on it. */}
                    <View
                      accessible={false}
                      class={`rounded-[2px] ${held() ? "bg-brand" : dividing() ? "bg-transparent" : "bg-transparent group-hover:bg-brand"}`}
                      style={{ width: held() ? 12 : 6, height: held() ? 12 : 6, transform: "rotate(45deg)" }}
                    />
                  </View>
                );
              }}
            </Each>
          </View>
          {/* What a drag shows goes over the floating panes too: their strips are drop targets. */}
          <View accessible={false} class="absolute left-0 top-0 right-0 bottom-0" style={{ zIndex: 150, pointerEvents: "none" }}>
            <If when={drag.indicator() && !drag.idleGap()}>
              {/* See-through, so the pane it is about to land on still shows under it: the brand at 14%
                  inside a 2px brand edge. Between two tabs it is a caret, not a box. (`token()` gives
                  `#rrggbbaa`, so an alpha is written as the class's `/14`, never appended to it.) */}
              <View
                testID="wb-drop"
                accessible={false}
                class={`absolute ${drag.onTabGap() ? "bg-brand rounded-[1px]" : "bg-brand/14 border-2 border-brand rounded-(--radius-sm)"}`}
                style={{
                  left: drag.indicator()!.x,
                  top: drag.indicator()!.y,
                  width: drag.indicator()!.width,
                  height: drag.indicator()!.height,
                }}
              />
            </If>
            <If when={drag.ghost()}>
              {(ghost) => (
                <View
                  testID="wb-ghost"
                  accessible={false}
                  class="absolute px-2 py-[2px] rounded-(--radius-sm) bg-pane"
                  style={{ left: ghost().x + 12, top: ghost().y + 12, boxShadow: "0 4px 12px rgb(0 0 0 / 0.2)" }}
                >
                  {/* One line even at the window's edge, where the room left would wrap it. */}
                  <Text class="text-[12px] text-ink whitespace-nowrap">{ghost().label}</Text>
                </View>
              )}
            </If>
          </View>
        </If>

        <Each of={paneMenu() ? [paneMenu()!] : []} key={(open) => open.seq}>
          {(open) => (
            <PaneContextMenu
              x={open().x}
              y={open().y}
              actions={actionsOf(open().leafId, open().tabId)}
              closeTabs={ops.closingOf(open().leafId, open().tabId)}
              fits={ops.fitsFor(open().leafId)}
              floating={menuFloating()}
              edit={open().edit ? { canCopy: open().canCopy, onCopy: open().edit!.copy, onPaste: open().edit!.paste } : null}
              onSplit={(dir) => ops.splitTowards(open().leafId, dir)}
              onDock={() => ops.onDock(open().leafId)}
              onFloat={ops.tabFloating(open().leafId, open().tabId ?? leafById(layout(), open().leafId)?.activeTabId ?? null) ?? undefined}
              onClosePane={() => ops.closePane(open().leafId)}
              onClose={() => paneMenu.set(null)}
            />
          )}
        </Each>
      </If>
    </View>
  );
}

/** The crossing's gesture: pressed and moved, it reports like the dividers' own. */
function PanResponderFor(
  id: () => string,
  report: (id: string, phase: DragPhase, point: DragPoint) => void,
  started: () => boolean,
  setStarted: (v: boolean) => void,
) {
  return PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (_e, g) => {
      setStarted(true);
      report(id(), "start", { x: g.x0, y: g.y0, dx: 0, dy: 0 });
    },
    onPanResponderMove: (_e, g) => report(id(), "move", { x: g.moveX, y: g.moveY, dx: g.dx, dy: g.dy }),
    onPanResponderRelease: (_e, g) => {
      if (started()) report(id(), "end", { x: g.moveX, y: g.moveY, dx: g.dx, dy: g.dy });
      setStarted(false);
    },
    onPanResponderTerminate: (_e, g) => {
      if (started()) report(id(), "cancel", { x: g.moveX, y: g.moveY, dx: g.dx, dy: g.dy });
      setStarted(false);
    },
  });
}
