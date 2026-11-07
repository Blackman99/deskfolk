/**
 * One pane (`WorkbenchLeaf.svelte`): a tab strip (`leaf-strip.tsx`) and the active tab's body under
 * it, or, with no tab, what an empty pane offers (`leaf-menus.tsx`).
 *
 * Beside the phone layout a docked pane is a card on the window's ground: the strip and its tabs sit
 * on the ground, the body is the card, 4 points of gutter around it. A pane that is not the current
 * one, while there is another to tell it from, steps back in its chrome alone (the strip half faded,
 * the card lying flat) and the current card stands off the ground by a soft shadow. On a phone the
 * pane is one flat surface, the strip a band above it. A floating pane keeps its own frame
 * (`WorkbenchFloat`) and its strip is its title bar.
 *
 * Tab bodies and labels are the host's render props: the workbench never imports a content component.
 * Not carried over: the strip's edge fades (the arrows at its ends say there is more), the glass-dark
 * strip head, and Delete / Backspace / arrow keys moving along the tabs (Tab walks the controls).
 */
import { signal, effect, untracked, View, type PressEvent, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import type { LeafNode } from "../../m/workbench/layout-types.ts";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { EmptyPane, NewTabMenu } from "./leaf-menus";
import { LeafStrip } from "./leaf-strip";
import { liveTab } from "./live-tab";
import { PaneContextMenu } from "./PaneContextMenu";
import type { DragPhase, DragPoint, LeafRender, MenuRender, RowRegistry, TabAction, TabBody, TabClosing, TabLabel, WorkbenchTab } from "./types";

export type WorkbenchLeafProps = {
  leaf: LeafNode;
  focused: boolean;
  /** More than one pane is showing, so this one goes quiet when it is not the current one. */
  divided?: boolean;
  /** Inside a floating pane: no card margins, and the strip is the title bar. */
  floating?: boolean;
  /** The content of the active tab. The workbench never imports a content component itself. */
  tabBody: TabBody;
  tabLabel: TabLabel;
  onFocus: (leafId: string) => void;
  onActivate: (leafId: string, tabId: string) => void;
  onCloseTab: (leafId: string, tabId: string) => void;
  /** What a tab's ⋯ offers to close: it, the others, those to its right, all of them. */
  tabClosing?: (leafId: string, tabId: string) => TabClosing | null;
  /** What a tab's ⋯ offers for floating it on its own; null where that would change nothing. */
  tabFloating?: (leafId: string, tabId: string) => (() => void) | null;
  onClosePane?: (leafId: string) => void;
  /** The tab being dragged right now, if it is one of these. It stays put, faded. */
  draggedTab?: string | null;
  /** The pane being dragged by its strip; if it is this one, every tab stays put, faded. */
  draggedLeaf?: string | null;
  /** A tab pressed and moved: `start` where the press went down, then `move`s, then `end` or `cancel`. */
  onTabDrag?: (leafId: string, tabId: string, phase: DragPhase, point: DragPoint) => void;
  /** The strip's own bare part pressed and moved. */
  onStripDrag?: (leafId: string, phase: DragPhase, point: DragPoint) => void;
  /** The strip's bare part pressed (a double press docks a floating pane). */
  onStripPress?: (leafId: string, e: PressEvent) => void;
  /** A right click in the pane, on a tab (`tabId`) or off one. */
  onPaneMenu?: (e: { leafId: string; tabId: string | null; x: number; y: number }) => void;
  /** The strip's ⋯: where it was pressed, for the host's own menu. Left out, there is no ⋯. */
  onMenu?: (leafId: string, at: { x: number; y: number }) => void;
  /** What an empty pane offers to fill itself with. */
  emptyActions?: LeafRender;
  /** Under an empty pane's title, before its list: the ways to start something new. */
  emptyLead?: LeafRender;
  /** The same offer, shaped for the strip's menu: a fixed-width list rather than a wrapping row. */
  menuActions?: MenuRender;
  /** What a tab offers to do for what it shows. A tab with any gets a ⋯, shown while the pointer is on the tab. */
  tabActions?: (leafId: string, tab: WorkbenchTab) => TabAction[];
  /** Each pane's tab row says how to measure itself, for the workbench's drop zones. */
  rows?: RowRegistry;
};

export function WorkbenchLeaf(props: WorkbenchLeafProps) {
  const t = () => copy().pane;
  const narrow = () => narrowWindow() && !props.floating;
  const leaf = () => props.leaf;
  const dimmed = () => Boolean(props.divided) && !props.focused;
  const raised = () => Boolean(props.divided) && props.focused;
  const empty = () => leaf().tabs.length === 0;
  const canOpen = () => Boolean(props.menuActions ?? props.emptyActions);
  /** The strip of an empty pane sits in the card's corner: the card starts at the gutter like the window's edge. */
  const cornerStrip = () => empty() && !props.floating && !narrow();

  const newTabOpen = signal(false);
  const newTabFilter = signal("");
  const emptyFilter = signal("");
  let newTabButton: ViewRef | null = null;
  const more = signal<{ tabId: string; anchor: ViewRef } | null>(null);
  const moreTab = () => {
    const open = more();
    return open ? (leaf().tabs.find((tab) => tab.id === open.tabId) ?? null) : null;
  };
  const width = signal(0);

  /** A pane that changes what it holds should not leave the menu hanging open over it. */
  effect(() => {
    void leaf().tabs.length;
    untracked(() => {
      newTabOpen.set(false);
      emptyFilter.set("");
      more.set(null);
    });
  });

  const toggleNewTab = () => {
    const open = !newTabOpen();
    if (open) newTabFilter.set("");
    newTabOpen.set(open);
  };

  const activeIds = () => (leaf().activeTabId && leaf().tabs.some((tab) => tab.id === leaf().activeTabId) ? [leaf().activeTabId!] : []);

  const bodyClass = () => {
    if (props.floating || narrow()) return "bg-pane";
    return `mx-1 mb-1 rounded-(--radius-lg) bg-pane ${cornerStrip() ? "mt-1" : ""}`;
  };

  return (
    <View
      testID="wb-leaf"
      accessibilityLabel={t().title}
      onLayout={(e) => width.set(e.bounds.size.width)}
      onTouchStartCapture={() => props.onFocus(leaf().id)}
      onContextMenu={(e) => props.onPaneMenu?.({ leafId: leaf().id, tabId: null, x: e.pagePosition.x, y: e.pagePosition.y })}
      class={`flex-1 min-w-0 min-h-0 relative ${props.floating ? "overflow-hidden rounded-(--radius-lg)" : narrow() ? "overflow-hidden" : ""}`}
    >
      <If when={raised() && !props.floating && !narrow()}>
        <View
          accessible={false}
          class="absolute left-1 right-1 bottom-1 rounded-(--radius-lg)"
          style={{ top: cornerStrip() ? 4 : 40, boxShadow: shadow("pane-lift"), pointerEvents: "none" }}
        />
      </If>
      <If when={!(empty() && !props.onMenu && !props.onClosePane && !props.floating)}>
        <LeafStrip
          leaf={leaf}
          narrow={narrow}
          floating={Boolean(props.floating)}
          dimmed={dimmed}
          maxTabsWidth={props.floating ? () => Math.max(0, width() - 76) : undefined}
          tabLabel={props.tabLabel}
          draggedTab={() => props.draggedTab}
          draggedLeaf={() => props.draggedLeaf}
          rows={props.rows}
          tabActions={props.tabActions}
          onFocus={props.onFocus}
          onActivate={props.onActivate}
          onCloseTab={props.onCloseTab}
          onTabDrag={props.onTabDrag}
          onStripDrag={props.onStripDrag}
          onStripPress={props.onStripPress}
          onPaneMenu={props.onPaneMenu}
          onMenu={props.onMenu}
          onClosePane={props.onClosePane}
          canOpen={canOpen()}
          newTabOpen={newTabOpen}
          onToggleNewTab={toggleNewTab}
          setNewTabButton={(node) => (newTabButton = node)}
          more={more}
          onToggleMore={(tabId, anchor) => more.set(more()?.tabId === tabId ? null : { tabId, anchor })}
        />
      </If>
      <If when={newTabOpen() && canOpen()}>
        <NewTabMenu
          leafId={leaf().id}
          anchor={newTabButton}
          filter={newTabFilter}
          onFilter={(value) => newTabFilter.set(value)}
          menuActions={props.menuActions}
          emptyActions={props.emptyActions}
          onClose={() => newTabOpen.set(false)}
        />
      </If>
      <If when={more() && moreTab() && props.tabActions}>
        <PaneContextMenu
          x={0}
          y={0}
          label={t().tabActions}
          actions={props.tabActions?.(leaf().id, moreTab()!) ?? []}
          closeTabs={props.tabClosing?.(leaf().id, moreTab()!.id) ?? null}
          onFloat={props.tabFloating?.(leaf().id, moreTab()!.id) ?? undefined}
          anchor={more()?.anchor}
          onClose={() => more.set(null)}
        />
      </If>
      <View
        role="group"
        testID={`wb-body-${leaf().id}`}
        accessibilityLabel={t().title}
        class={`flex-1 min-h-0 overflow-hidden ${bodyClass()}`}
        style={{
          borderRadius: props.floating ? 0 : undefined,
          boxShadow: props.floating || narrow() ? undefined : shadow(dimmed() ? "pane-flat" : "pane"),
        }}
      >
        <Each of={activeIds()} key={(id) => id}>
          {(id) => {
            // Called once per tab, untracked: read inside the insert, `leaf()` made every layout commit
            // (a new leaf object each time) build the pane's content again, and that mount committed
            // the layout again — a pane dragged in from the sidebar never stopped remounting.
            const body = untracked(() => props.tabBody(liveTab(leaf, id()), leaf().id));
            return <View class="flex-1 min-h-0">{body}</View>;
          }}
        </Each>
        <If when={activeIds().length === 0}>
          <EmptyPane
            leafId={leaf().id}
            filter={emptyFilter}
            onFilter={(value) => emptyFilter.set(value)}
            menuActions={props.menuActions}
            emptyActions={props.emptyActions}
            emptyLead={props.emptyLead}
          />
        </If>
      </View>
    </View>
  );
}
