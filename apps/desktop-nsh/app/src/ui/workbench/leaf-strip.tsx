/**
 * A pane's tab strip (the top of `WorkbenchLeaf.svelte`): the row of tabs, scrolled sideways once
 * they no longer fit, the arrows at its ends while there is more past them, the + that opens the
 * new-tab menu, the pane's ⋯ and the × of an empty pane.
 *
 * A tab is pressed to activate it and dragged (past 4 points) to move it: the drag is the host's,
 * fed through `onTabDrag` in the window's coordinates. The tab's ⋯ and × stay out of the tab order.
 *
 * The strip's bare part is the window's title bar in a tiled pane (`windowDrag`): held, it moves the
 * whole window, and a double press zooms it, as the system's title bar does; only a tab moves what
 * the pane shows. Not as the messenger, where it carries the whole pane, every tab. A floating pane's
 * bar is that pane's own title bar (`onStripDrag`, `onStripPress`): it moves the pane, a double press
 * docks it.
 */
import { cleanup, effect, PanResponder, Scroll, signal, untracked, View, windowSize, type PressEvent, type ScrollRef, type ViewRef } from "nsh";
import { titleBar } from "nsh/desktop";
import { copy } from "../../runtime";
import { onWheel } from "../../platform/wheel";
import type { LeafNode } from "../../m/workbench/layout-types.ts";
import { WB_DRAG_THRESHOLD_PX } from "../../m/workbench/drop-zones.ts";
import { contentGlassShare, GLASS_EDGE, glassOf } from "../glass";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";
import { liveTab } from "./live-tab";
import type { DragPhase, DragPoint, MeasuredRow, RowRegistry, TabAction, TabLabel } from "./types";

/** One flare of an active tab on a phone, and the room a tab scrolled into view keeps around it. */
const FLARE = 8;

/**
 * A pan that starts where the press went down and reports where the finger is, in the window. The
 * responder is granted on the first move past the threshold and counts from there, so the distance
 * is taken from where the press began (what the should-set handler is told) to lose none of it.
 */
export function dragResponder(emit: (phase: DragPhase, point: DragPoint) => void, allowed: () => boolean = () => true, onEnd?: () => void) {
  let started = false;
  let from = { x: 0, y: 0 };
  const at = (g: { moveX: number; moveY: number }): DragPoint => ({ x: g.moveX, y: g.moveY, dx: g.moveX - from.x, dy: g.moveY - from.y });
  return PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => {
      if (!allowed() || Math.hypot(g.dx, g.dy) < WB_DRAG_THRESHOLD_PX) return false;
      from = { x: g.moveX - g.dx, y: g.moveY - g.dy };
      return true;
    },
    onPanResponderGrant: (_e, g) => {
      started = true;
      emit("start", { x: from.x, y: from.y, dx: 0, dy: 0 });
      emit("move", at(g));
    },
    onPanResponderMove: (_e, g) => emit("move", at(g)),
    onPanResponderRelease: (_e, g) => {
      if (!started) return;
      started = false;
      emit("end", at(g));
      onEnd?.();
    },
    onPanResponderTerminate: (_e, g) => {
      if (!started) return;
      started = false;
      emit("cancel", at(g));
      onEnd?.();
    },
  });
}

export type StripProps = {
  leaf: () => LeafNode;
  /** Beside the phone layout the tabs are pills on the window's ground; on a phone they sit on a band. */
  narrow: () => boolean;
  floating: boolean;
  /**
   * Dark on the window's material the strip is the card's head (`WorkbenchLeaf` draws the band): 4
   * points in from the leaf's edges, and its active tab is drawn on the band with no ground of its own.
   */
  head?: () => boolean;
  /** Another pane is the current one: this one steps back, its strip half faded. */
  dimmed: () => boolean;
  /** A floating pane's tabs leave this much of the bar bare, to take hold of. */
  maxTabsWidth?: () => number | undefined;
  tabLabel: TabLabel;
  draggedTab: () => string | null | undefined;
  draggedLeaf: () => string | null | undefined;
  rows?: RowRegistry;
  tabActions?: (leafId: string, tab: LeafNode["tabs"][number]) => TabAction[];
  onFocus: (leafId: string) => void;
  onActivate: (leafId: string, tabId: string) => void;
  onCloseTab: (leafId: string, tabId: string) => void;
  onTabDrag?: (leafId: string, tabId: string, phase: DragPhase, point: DragPoint) => void;
  onStripDrag?: (leafId: string, phase: DragPhase, point: DragPoint) => void;
  onStripPress?: (leafId: string, e: PressEvent) => void;
  onPaneMenu?: (e: { leafId: string; tabId: string | null; x: number; y: number }) => void;
  onMenu?: (leafId: string, at: { x: number; y: number }) => void;
  onClosePane?: (leafId: string) => void;
  /** The + is there when the pane has something to offer. */
  canOpen: boolean;
  newTabOpen: () => boolean;
  onToggleNewTab: () => void;
  setNewTabButton: (node: ViewRef) => void;
  more: () => { tabId: string; anchor: ViewRef } | null;
  onToggleMore: (tabId: string, anchor: ViewRef) => void;
};

export function LeafStrip(props: StripProps) {
  const leaf = props.leaf;
  const t = () => copy().pane;
  const height = () => (props.narrow() ? 32 : 40);
  const tabHeight = () => (props.narrow() ? 28 : 28);
  /** The active tab is the card's own top, so on a glass card it lets the same glass through (`glass.ts`). */
  const glassShare = () => (props.floating || props.narrow() ? null : contentGlassShare());
  /**
   * On the card's head the active tab paints nothing: no ground, ring or shadow, only its full ink
   * tells it from the others. A pill of the card's colour on the band, ringed in a hairline, stood
   * out in dark where light's tab, the card's colour on a lighter ground, reads as no ground at all.
   */
  const bare = () => Boolean(props.head?.());

  /** The tab row's own state: how far it is scrolled, how wide it shows, how wide each tab is. */
  const scroll = signal(0);
  const viewWidth = signal(0);
  const widths = signal<Record<string, number>>({});
  const hovered = signal<string | null>(null);
  let rowRef: ScrollRef | null = null;
  let stripRef: ViewRef | null = null;
  /** Where the strip is in the window (its top and its right end), measured after each layout. */
  const placed = signal<{ top: number; right: number } | null>(null);
  const measurePlace = () =>
    void stripRef?.measure().then((m) => placed.set(m ? { top: m.pagePosition.y, right: m.pagePosition.x + m.bounds.size.width } : null));
  /**
   * Room for the window's controls where the app hides the title bar and they sit over this strip's
   * end (Windows' caption buttons at the top right; `titleBar()` is all 0 elsewhere): its last
   * buttons stay clear of them.
   */
  const controlsRoom = () => {
    const bar = titleBar();
    const at = placed();
    if (!bar.right || !at || at.top >= bar.height) return 0;
    return at.right >= windowSize().width - bar.right ? bar.right : 0;
  };
  const tabRefs = new Map<string, ViewRef>();
  /** A press that began on one of the strip's own buttons does not move the pane. */
  let blockStripDrag = false;

  const widthOf = (id: string) => widths()[id] ?? 0;
  const widthsOfShown = (): Record<string, number> => {
    const kept: Record<string, number> = {};
    for (const tab of leaf().tabs) if (tab.id in widths()) kept[tab.id] = widths()[tab.id]!;
    return kept;
  };
  const contentWidth = () => leaf().tabs.reduce((sum, tab) => sum + widthOf(tab.id), 0);
  const moreStart = () => scroll() > 1;
  const moreEnd = () => viewWidth() > 0 && scroll() < contentWidth() - viewWidth() - 1;

  const scrollTo = (x: number, animated = false) => rowRef?.scrollTo({ x: Math.max(0, x), animated });

  /** A tab that is opened or switched to lands where it can be seen, flares and all. */
  effect(() => {
    const id = leaf().activeTabId;
    void leaf().tabs.length;
    void widths();
    void viewWidth();
    if (!id) return;
    untracked(() => {
      const index = leaf().tabs.findIndex((tab) => tab.id === id);
      if (index < 0 || !viewWidth()) return;
      const before = leaf().tabs.slice(0, index).reduce((sum, tab) => sum + widthOf(tab.id), 0);
      const start = before - FLARE;
      const end = before + widthOf(id) + FLARE;
      if (start < scroll()) scrollTo(start);
      else if (end > scroll() + viewWidth()) scrollTo(end - viewWidth());
    });
  });

  /** Most of a row's width at a time, so the tab cut off at the edge comes fully into view. */
  const stepTabs = (direction: -1 | 1) => scrollTo(scroll() + direction * viewWidth() * 0.7, true);

  /** A trackpad already scrolls the row sideways; a mouse wheel only turns up and down. */
  onWheel(
    () => rowRef,
    (e) => {
      if (Math.abs(e.dy) <= Math.abs(e.dx) || contentWidth() <= viewWidth()) return;
      scrollTo(scroll() + e.dy);
    },
  );

  /** The row as the drop zones need it, measured when a drag starts or its row has just scrolled. */
  const measureRow = async (): Promise<MeasuredRow | null> => {
    const strip = await stripRef?.measure();
    const row = await rowRef?.measure();
    const first = leaf().tabs[0] ? await tabRefs.get(leaf().tabs[0]!.id)?.measure() : null;
    if (!strip || !row) return null;
    return {
      strip: { x: strip.pagePosition.x, y: strip.pagePosition.y, width: strip.bounds.size.width, height: strip.bounds.size.height },
      visible: { x: row.pagePosition.x, width: row.bounds.size.width },
      start: first ? first.pagePosition.x : row.pagePosition.x,
      widths: leaf().tabs.map((tab) => widthOf(tab.id)),
    };
  };
  /** A row that overflows scrolls on its own while a dragged tab is held near either end. */
  const scrollRowBy = (dx: number): boolean => {
    const max = Math.max(0, contentWidth() - viewWidth());
    const next = Math.min(max, Math.max(0, scroll() + dx));
    if (next === scroll()) return false;
    scrollTo(next);
    // The scroll event is on its way; the drop zones are measured again from the offset it will report.
    scroll.set(next);
    return true;
  };
  const handle = { measure: measureRow, scrollBy: scrollRowBy };
  const registerRow = () => {
    const id = leaf().id;
    props.rows?.set(id, handle);
    return () => {
      if (props.rows?.get(id) === handle) props.rows.delete(id);
    };
  };
  effect(() => {
    void leaf().id;
    return registerRow();
  });

  const stripPan = dragResponder(
    (phase, point) => props.onStripDrag?.(leaf().id, phase, point),
    () => !blockStripDrag && Boolean(props.onStripDrag),
  );

  /** Wraps a strip control so that pressing it never starts a drag of the pane. */
  const ownTouch = { onTouchStart: () => (blockStripDrag = true) };

  /**
   * What the bare strip answers. A floating pane's bar moves and docks that pane. A tiled pane's is
   * the window's title bar, with no press, touch or pan of its own: those would keep it a button
   * where NSH looks for the nearest `windowDrag`. Its right click still opens the pane's menu (on
   * Windows and Linux a drag region's own listener keeps the window menu away).
   */
  const stripHandlers = props.floating
    ? { onTouchStartCapture: () => (blockStripDrag = false), onPress: (e: PressEvent) => props.onStripPress?.(leaf().id, e), ...stripPan.panHandlers }
    : {
        desktop: { windowDrag: true },
        onContextMenu: (e: { pagePosition: { x: number; y: number } }) =>
          props.onPaneMenu?.({ leafId: leaf().id, tabId: null, x: e.pagePosition.x, y: e.pagePosition.y }),
      };

  let swallowUntil = 0;
  const tabView = (tabId: string) => {
    const tab = () => leaf().tabs.find((candidate) => candidate.id === tabId)!;
    const active = () => tabId === leaf().activeTabId;
    const dragged = () => tabId === props.draggedTab() || leaf().id === props.draggedLeaf();
    const actions = () => props.tabActions?.(leaf().id, tab()) ?? [];
    const open = () => props.more()?.tabId === tabId;
    const shown = () => active() || hovered() === tabId;
    const pan = dragResponder(
      (phase, point) => {
        // A tab in hand is not also the pane being moved by its strip.
        if (phase === "start") blockStripDrag = true;
        props.onTabDrag?.(leaf().id, tabId, phase, point);
      },
      () => Boolean(props.onTabDrag),
      () => (swallowUntil = Date.now() + 300),
    );
    let moreRef: ViewRef | null = null;
    // The strip outlives the tabs it shows: a tab that goes takes its ref with it (a ref kept here kept its views).
    cleanup(() => tabRefs.delete(tabId));
    return (
      <View
        testID={`wb-tab-${tabId}`}
        ref={(node) => tabRefs.set(tabId, node)}
        // The whole tab is the tab's, its padding and the room round ⋯ and × too: not the strip's window drag.
        desktop={{ windowDrag: false }}
        onLayout={(e) => {
          const w = e.bounds.size.width;
          // Only the tabs still shown keep a width (dropped here, not as a tab goes: no write while it is torn down).
          if (widths()[tabId] !== w) widths.set({ ...widthsOfShown(), [tabId]: w });
        }}
        onMouseEnter={() => hovered.set(tabId)}
        onMouseLeave={() => hovered() === tabId && hovered.set(null)}
        onContextMenu={(e) => props.onPaneMenu?.({ leafId: leaf().id, tabId, x: e.pagePosition.x, y: e.pagePosition.y })}
        class={`flex-none flex-row items-center pl-2 pr-[2px] ${props.narrow() ? "rounded-t-(--radius-md)" : "rounded-(--radius-sm)"} ${active() ? (bare() ? "" : glassShare() === null ? "bg-pane" : GLASS_EDGE) : hovered() === tabId ? "bg-row-hover" : ""}`}
        style={{
          height: tabHeight(),
          opacity: dragged() ? 0.45 : 1,
          boxShadow: active() && !bare() && !props.narrow() && glassShare() === null ? shadow("pane") : undefined,
          backgroundColor: active() && !bare() && glassShare() !== null ? glassOf("pane", glassShare()!) : undefined,
        }}
      >
        <View
          role="tab"
          testID={`wb-tab-button-${tabId}`}
          accessibilityState={{ selected: active() }}
          onPressDown={() => props.onFocus(leaf().id)}
          onPress={() => {
            if (Date.now() < swallowUntil) return;
            props.onActivate(leaf().id, tabId);
          }}
          class="cursor-pointer select-none group max-w-[180px] h-full pr-1 justify-center"
          {...pan.panHandlers}
        >
          {props.tabLabel(liveTab(leaf, tabId))}
        </View>
        <If when={actions().length > 0}>
          <View
            role="button"
            testID={`wb-tab-more-${tabId}`}
            accessibilityLabel={t().tabActions}
            accessibilityState={{ expanded: open() }}
            focusable={false}
            tooltip={tip(t().tabActions)}
            ref={(node) => (moreRef = node)}
            onPress={() => {
              props.onFocus(leaf().id);
              if (moreRef) props.onToggleMore(tabId, moreRef);
            }}
            {...ownTouch}
            class={`cursor-pointer select-none w-[18px] h-[18px] shrink-0 rounded-full items-center justify-center hover:bg-row-hover ${open() ? "bg-row-hover" : ""}`}
            style={{ opacity: shown() || open() ? 1 : 0 }}
          >
            <Icon name="more" size={12} class="tint-ink-muted" />
          </View>
        </If>
        <View
          role="button"
          testID={`wb-tab-close-${tabId}`}
          accessibilityLabel={t().closeTab}
          focusable={false}
          tooltip={tip(t().closeTab)}
          onPress={() => props.onCloseTab(leaf().id, tabId)}
          {...ownTouch}
          class="cursor-pointer select-none w-[18px] h-[18px] mr-[2px] shrink-0 rounded-full items-center justify-center hover:bg-row-hover"
          style={{ opacity: shown() ? 1 : 0 }}
        >
          <Icon name="x" size={12} class="tint-ink-muted" />
        </View>
      </View>
    );
  };

  const button = (id: string, label: string, icon: "plus" | "more" | "x", onPress: (e: PressEvent) => void, extra: Record<string, unknown> = {}) => (
    <View
      role="button"
      testID={id}
      accessibilityLabel={label}
      focusable={false}
      tooltip={tip(label)}
      onPress={onPress}
      {...ownTouch}
      {...extra}
      class="cursor-pointer select-none w-6 h-6 mb-[2px] shrink-0 rounded-full items-center justify-center hover:bg-row-hover"
    >
      <Icon name={icon} size={icon === "x" ? 12 : 16} class="tint-ink-muted" />
    </View>
  );

  const bg = () => (props.floating ? "bg-sidebar-bg" : props.narrow() ? "bg-tab-strip" : "");
  return (
    <View
      role="tablist"
      testID={`wb-strip-${leaf().id}`}
      accessibilityLabel={t().tabsIn.replace("{name}", t().title)}
      ref={(node) => (stripRef = node)}
      onLayout={measurePlace}
      focusable={false}
      class={`flex-row items-center ${bg()} ${leaf().tabs.length === 0 && !props.floating ? "absolute top-1 right-1 pr-1 z-10" : props.head?.() ? "self-stretch mt-1 mx-1" : "w-full"}`}
      style={{ height: leaf().tabs.length === 0 && !props.floating ? 32 : height(), cursor: props.floating ? "grab" : undefined, opacity: props.dimmed() ? 0.5 : 1, paddingRight: controlsRoom() || undefined }}
      {...stripHandlers}
    >
      <View class="flex-row self-stretch min-w-0 shrink ml-1 relative" style={{ maxWidth: props.maxTabsWidth?.() }}>
        <Scroll
          horizontal
          scrollbar={false}
          testID={`wb-tabs-${leaf().id}`}
          ref={(node) => (rowRef = node as ScrollRef)}
          onLayout={(e) => viewWidth.set(e.bounds.size.width)}
          onScroll={(e) => scroll.set(e.offset.x)}
          contentClass="flex-row items-center"
          style={{ flexShrink: 1, flexGrow: 0 }}
        >
          <Each of={leaf().tabs} key={(tab) => tab.id}>
            {(tab) => tabView(tab().id)}
          </Each>
        </Scroll>
        <If when={moreStart()}>
          <View
            role="button"
            testID="wb-tabs-back"
            accessibilityLabel={t().tabsBack}
            focusable={false}
            tooltip={tip(t().tabsBack)}
            onPress={() => stepTabs(-1)}
            {...ownTouch}
            class="cursor-pointer select-none absolute left-[6px] w-5 h-5 rounded-full bg-pane items-center justify-center z-10"
            style={{ top: "50%", marginTop: -10, boxShadow: shadow("pane") }}
          >
            <Icon name="chevron-left" size={12} class="tint-ink hover:tint-brand" />
          </View>
        </If>
        <If when={moreEnd()}>
          <View
            role="button"
            testID="wb-tabs-forward"
            accessibilityLabel={t().tabsForward}
            focusable={false}
            tooltip={tip(t().tabsForward)}
            onPress={() => stepTabs(1)}
            {...ownTouch}
            class="cursor-pointer select-none absolute right-[2px] w-5 h-5 rounded-full bg-pane items-center justify-center z-10"
            style={{ top: "50%", marginTop: -10, boxShadow: shadow("pane") }}
          >
            <Icon name="chevron-right" size={12} class="tint-ink hover:tint-brand" />
          </View>
        </If>
      </View>
      <If when={props.canOpen && leaf().tabs.length > 0}>
        <View ref={props.setNewTabButton} class="ml-1">
          {button("wb-new-tab", t().newTab, "plus", () => props.onToggleNewTab(), { accessibilityState: { expanded: props.newTabOpen() } })}
        </View>
      </If>
      <If when={props.onMenu}>
        {(onMenu) => (
          <View class="ml-auto">
            {button("wb-pane-menu", t().title, "more", (e) => onMenu()(leaf().id, { x: e.pagePosition.x, y: e.pagePosition.y }))}
          </View>
        )}
      </If>
      <If when={leaf().tabs.length === 0 && props.onClosePane}>
        <View class={props.onMenu ? "" : "ml-auto"}>{button("wb-pane-close", t().close, "x", () => props.onClosePane?.(leaf().id))}</View>
      </If>
    </View>
  );
}
