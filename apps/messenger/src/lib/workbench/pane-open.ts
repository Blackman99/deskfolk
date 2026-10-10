/**
 * Putting something into the arrangement.
 *
 * If a pane already shows what is being asked for, that pane is focused and nothing else moves. A
 * conversation's preview and each view of its flow are one pane each, so a request for another file
 * or job of that conversation turns the one it has; its settings are not a pane at all but a sidebar
 * inside its own tab. Only when nothing shows it does it get a new tab, and where that tab goes is
 * the person's choice for that kind of window (`open-placement.ts`): beside the one in front, over
 * it, in a pane split off some way, in the pane already on that side, or floating. Nothing else is
 * ever moved to make room, and nothing is opened or split that the choice did not ask for.
 */
import type { Axis, FloatFrame, NodeId, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import type { TraceViewKind } from "../overlays/trace-view.ts";
import type { Direction } from "./layout-geometry.ts";
import type { OpenPlacement } from "./open-placement.ts";
import { SPLIT_TOWARDS } from "./workbench-commands.ts";
import {
  activateTab,
  addTab,
  closeTab,
  focusLeaf,
  isFloating,
  leafById,
  makeLeaf,
  replaceTabParams,
  splitLeaf,
  tiledLeaves,
} from "./layout-tree.ts";
import {
  contentOfTab,
  contentToParams,
  contentsEqual,
  tabFor,
  type ChatContent,
  type ChatSide,
  type PaneContent,
} from "./pane-content.ts";

export type Located = { leafId: NodeId; tab: WorkbenchTab };

function leavesOf(layout: WorkbenchLayout) {
  return [...tiledLeaves(layout.root), ...layout.floating.map((pane) => pane.leaf)];
}

/** The pane showing this kind of thing, whatever it is pointed at — the focused pane first. */
export function findKind(layout: WorkbenchLayout, kind: PaneContent["kind"]): Located | null {
  for (const leaf of focusedFirst(layout)) {
    const tab = leaf.tabs.find((candidate) => candidate.kind === kind);
    if (tab) return { leafId: leaf.id, tab };
  }
  return null;
}

function replaceTabContent(
  layout: WorkbenchLayout,
  leafId: NodeId,
  tabId: string,
  content: PaneContent,
): WorkbenchLayout {
  return replaceTabParams(layout, leafId, tabId, contentToParams(content));
}

function focusedFirst(layout: WorkbenchLayout) {
  const leaves = leavesOf(layout);
  return [
    ...leaves.filter((leaf) => leaf.id === layout.focus.leafId),
    ...leaves.filter((leaf) => leaf.id !== layout.focus.leafId),
  ];
}

/** Where this content is already open, preferring the focused pane when it is in more than one. */
export function findContent(layout: WorkbenchLayout, content: PaneContent): Located | null {
  for (const leaf of focusedFirst(layout)) {
    for (const tab of leaf.tabs) {
      const its = contentOfTab(tab);
      if (its && contentsEqual(its, content)) return { leafId: leaf.id, tab };
    }
  }
  return null;
}

/**
 * What a placement needs to know about the window that the tree alone cannot say. The shell
 * answers from the workbench it measured; without one (a test, a caller that does not care) there
 * is no pane next door, every split fits, and a float goes to a fixed spot.
 */
export type PlaceContext = {
  /** The pane next door to this one in that direction, or null. */
  neighbour: (layout: WorkbenchLayout, leafId: NodeId, dir: Direction) => NodeId | null;
  /** Whether this pane can be divided along `axis` and still give the new one room for its content. */
  fits: (layout: WorkbenchLayout, leafId: NodeId, axis: Axis, content: PaneContent) => boolean;
  /** Where a new floating pane for this content goes. */
  floatFrame: (layout: WorkbenchLayout, content: PaneContent) => FloatFrame;
  /** Whether this tab holds an edit not saved yet, which a replace must not throw away. */
  holdsEdit: (tabId: string) => boolean;
  /**
   * Which kind of window this is, as the settings list them, so a replace only takes the same
   * kind: a conversation not a Bot↔Bot direct, the board not the trace.
   */
  kindOf: (content: PaneContent) => string;
};

/** Without the conversations' kinds to hand: a tab's kind, and for the flow, which of its views. */
const tabKindOf = (content: PaneContent): string =>
  content.kind === "trace" ? `trace:${content.view ?? "trace"}` : content.kind;

const NO_PLACE: PlaceContext = {
  neighbour: () => null,
  fits: () => true,
  floatFrame: (layout) => ({ x: 40 + 28 * layout.floating.length, y: 40 + 28 * layout.floating.length, width: 640, height: 480 }),
  holdsEdit: () => false,
  kindOf: tabKindOf,
};

export type OpenOptions = {
  /** A fresh tab or pane id, for when one has to be made. */
  id: () => string;
  /** Where a new tab goes when nothing shows this yet. Left out, a new tab in front in the focused pane. */
  placement?: OpenPlacement;
  place?: PlaceContext;
};

const OPPOSITE: Readonly<Record<Direction, Direction>> = { up: "down", down: "up", left: "right", right: "left" };

/**
 * Kinds there can only be one of at a time. Asking for it again moves the single pane rather than
 * making a rival. (The settings sidebar has the same rule for the same reason; see `openChat`.)
 */
const SINGLE_INSTANCE = new Set<PaneContent["kind"]>(["routines", "spend", "usage"]);

/**
 * Kinds a conversation has exactly one of.
 *
 * A conversation's preview and its flow board are bound to it. Whatever inside it asks for a file
 * or a job — a message, the preview's own file tree, a card on the board — the pane it already has
 * turns to that, rather than a second one opening beside it. Each conversation keeps its own. The
 * flow is three views, each a tab of its own, so a conversation has one of each: one trace, one
 * board of tickets, one spec.
 */
const ONE_PER_SESSION = new Set<PaneContent["kind"]>(["preview", "trace"]);

function boundSession(content: PaneContent): string | null {
  return "sessionId" in content ? content.sessionId : null;
}

/** Which of a job's views a flow tab is; the same for every other kind. */
function boundView(content: PaneContent): TraceViewKind | null {
  return content.kind === "trace" ? (content.view ?? "trace") : null;
}

/**
 * The pane holding this conversation's one tab of this kind, the focused pane first. For the flow,
 * `view` says which of its three tabs; left out, the trace.
 */
export function findBound(
  layout: WorkbenchLayout,
  kind: PaneContent["kind"],
  sessionId: string | null,
  view: TraceViewKind | null = kind === "trace" ? "trace" : null,
): Located | null {
  for (const leaf of focusedFirst(layout)) {
    for (const tab of leaf.tabs) {
      if (tab.kind !== kind) continue;
      const its = contentOfTab(tab);
      if (its && boundSession(its) === sessionId && boundView(its) === view) return { leafId: leaf.id, tab };
    }
  }
  return null;
}

function retarget(layout: WorkbenchLayout, at: Located, content: PaneContent | null): WorkbenchLayout {
  const pointed = content ? replaceTabContent(layout, at.leafId, at.tab.id, content) : layout;
  return activateTab(focusLeaf(pointed, at.leafId), at.leafId, at.tab.id);
}

/**
 * Where `openContent` would put this in a pane that is already there, or null when it would make
 * a new tab. The shell asks first so a preview holding an unsaved edit can be asked before it is
 * turned to another file.
 */
export function existingTarget(layout: WorkbenchLayout, content: PaneContent): Located | null {
  if (SINGLE_INSTANCE.has(content.kind)) return findKind(layout, content.kind);
  if (ONE_PER_SESSION.has(content.kind)) {
    return findBound(layout, content.kind, boundSession(content), boundView(content));
  }
  return null;
}

/**
 * Show this content. Focuses it where it already is — turning the conversation's own preview or
 * board to it when it has one — or puts it in the pane the keyboard is in. Returns the layout it
 * was given when nothing has to change.
 */
export function openContent(
  layout: WorkbenchLayout,
  content: PaneContent,
  opts: OpenOptions,
): WorkbenchLayout {
  if (content.kind === "chat") return openChat(layout, content, opts);
  const existing = existingTarget(layout, content);
  if (existing) {
    // Asking for the board with no job in mind — or for the job it is already on — is asking to
    // see it, not to move it. A message's card, or another view asking it to show a ticket, is a
    // request to move, so it is applied.
    return retarget(layout, existing, keepsJob(existing, content) ? null : content);
  }
  const found = findContent(layout, content);
  if (found) {
    const focused = focusLeaf(layout, found.leafId);
    return activateTab(focused, found.leafId, found.tab.id);
  }
  return placeNew(layout, content, opts);
}

/** A flow tab asked for with nothing to move to: no card, no ticket, and no job or the one it is on. */
function keepsJob(existing: Located, content: PaneContent): boolean {
  if (content.kind !== "trace" || content.focus || content.askNonce) return false;
  if (!content.taskId) return true;
  const its = contentOfTab(existing.tab);
  return its?.kind === "trace" && its.taskId === content.taskId;
}

/**
 * A new tab for something nothing shows yet, where its kind's placement says. Every placement that
 * cannot be done here — a split with no room, a split of a floating pane, a replace with nothing of
 * that kind in front — falls back to a new tab in the focused pane, so asking always shows it.
 */
function placeNew(layout: WorkbenchLayout, content: PaneContent, opts: OpenOptions): WorkbenchLayout {
  const focusId = layout.focus.leafId;
  if (!leafById(layout, focusId)) return layout;
  const place = opts.place ?? NO_PLACE;
  const tab = tabFor(content, opts.id());
  const inPane = (leafId: NodeId) => focusLeaf(addTab(layout, leafId, tab), leafId);
  const split = (dir: Direction) => {
    const { axis, side } = SPLIT_TOWARDS[dir];
    // A floating pane is not divided: docking it first is one explicit motion, as in its menu.
    if (isFloating(layout, focusId) || !place.fits(layout, focusId, axis, content)) return inPane(focusId);
    return splitLeaf(layout, focusId, axis, side, [tab], { leaf: opts.id(), branch: opts.id() });
  };

  const placement = opts.placement ?? "tab";
  switch (placement) {
    case "tab":
      return inPane(focusId);
    case "tab-background":
      return addTab(layout, focusId, tab, undefined, false);
    case "replace":
      return replaceSameKind(layout, content, tab, place, opts) ?? inPane(focusId);
    case "float": {
      const id = opts.id();
      const floating = [...layout.floating, { leaf: makeLeaf(id, [tab]), frame: place.floatFrame(layout, content) }];
      return focusLeaf({ ...layout, floating }, id);
    }
    case "split-left":
    case "split-right":
    case "split-up":
    case "split-down":
      return split(placement.slice("split-".length) as Direction);
    case "side-left":
    case "side-right":
    case "side-up":
    case "side-down": {
      const dir = placement.slice("side-".length) as Direction;
      if (isFloating(layout, focusId)) return inPane(focusId);
      const beside = place.neighbour(layout, focusId, dir);
      if (beside) return inPane(beside);
      // Already the pane on that side — opened from it, there is no further side to go to.
      if (place.neighbour(layout, focusId, OPPOSITE[dir])) return inPane(focusId);
      return split(dir);
    }
  }
}

/**
 * Over the same kind of window in front of you — the same row in the settings, so the board never
 * takes the trace's place nor a conversation a Bot↔Bot direct's: the focused pane's when it shows
 * one, else the first pane that does, in the order the keyboard reaches them (the focused one, then the tiled
 * panes in reading order, then the floating ones). Null when none does, or when that one holds an
 * edit not saved yet — closing it would throw the edit away, so the new one goes beside it instead.
 */
function replaceSameKind(
  layout: WorkbenchLayout,
  content: PaneContent,
  tab: WorkbenchTab,
  place: PlaceContext,
  opts: OpenOptions,
): WorkbenchLayout | null {
  const kind = place.kindOf(content);
  for (const leaf of focusedFirst(layout)) {
    const index = leaf.tabs.findIndex((candidate) => candidate.id === leaf.activeTabId);
    const current = leaf.tabs[index];
    const currentContent = current ? contentOfTab(current) : null;
    if (!current || !currentContent || place.kindOf(currentContent) !== kind) continue;
    if (place.holdsEdit(current.id)) return null;
    const withNew = addTab(layout, leaf.id, tab, index);
    return focusLeaf(closeTab(withNew, leaf.id, current.id, opts.id()), leaf.id);
  }
  return null;
}

/**
 * A conversation is one tab, whatever it has open beside the transcript.
 *
 * Asking for it again brings that tab forward and leaves its sidebar as it is — clicking the
 * conversation in the roster is not asking to close its settings. A request that names a sidebar
 * opens that one there instead. The settings panels read state the shell holds one copy of — the
 * unsaved draft, which danger confirm is armed — so settings are beside one conversation at a
 * time: opening them here closes them wherever else they were, rather than showing the first
 * one's edits in a second.
 */
function openChat(layout: WorkbenchLayout, content: ChatContent, opts: OpenOptions): WorkbenchLayout {
  const existing = findBound(layout, "chat", content.sessionId);
  let next: WorkbenchLayout;
  if (existing) {
    const current = contentOfTab(existing.tab);
    const turned = content.side !== undefined && current?.kind === "chat" ? { ...current, side: content.side } : null;
    next = retarget(layout, existing, turned);
  } else {
    next = placeNew(layout, { ...content, side: content.side ?? null }, opts);
  }
  return content.side?.kind === "settings" ? closeSettingsBesideOthers(next, content.sessionId) : next;
}

function closeSettingsBesideOthers(layout: WorkbenchLayout, sessionId: string): WorkbenchLayout {
  let next = layout;
  for (const leaf of leavesOf(layout)) {
    for (const tab of leaf.tabs) {
      const its = contentOfTab(tab);
      if (its?.kind !== "chat" || its.sessionId === sessionId || its.side?.kind !== "settings") continue;
      next = replaceTabContent(next, leaf.id, tab.id, { ...its, side: null });
    }
  }
  return next;
}

/**
 * The header's buttons: open this sidebar beside the conversation, or close it when it is the one
 * already open there. A group member's settings are not the group's, so the group's button turns
 * the sidebar to the group rather than closing it. Closing leaves the tab where it is and the
 * keyboard where it was.
 */
export function toggleChatSide(
  layout: WorkbenchLayout,
  sessionId: string,
  side: ChatSide,
  opts: OpenOptions,
): WorkbenchLayout {
  const at = findBound(layout, "chat", sessionId);
  const current = at ? contentOfTab(at.tab) : null;
  if (at && current?.kind === "chat" && current.side && sameSide(current.side, side)) {
    return replaceTabContent(layout, at.leafId, at.tab.id, { ...current, side: null });
  }
  return openContent(layout, { kind: "chat", sessionId, side }, opts);
}

function sameSide(a: ChatSide, b: ChatSide): boolean {
  return a.kind === b.kind && a.botId === b.botId;
}

/** Close whatever this conversation has open beside its transcript. */
export function closeChatSide(layout: WorkbenchLayout, sessionId: string): WorkbenchLayout {
  const at = findBound(layout, "chat", sessionId);
  const current = at ? contentOfTab(at.tab) : null;
  if (!at || current?.kind !== "chat" || !current.side) return layout;
  return replaceTabContent(layout, at.leafId, at.tab.id, { ...current, side: null });
}

/** The conversation whose settings are open beside it, and which Bot they are on, if any. */
export function settingsSide(layout: WorkbenchLayout): { sessionId: string; botId: string | null } | null {
  for (const leaf of leavesOf(layout)) {
    for (const tab of leaf.tabs) {
      const its = contentOfTab(tab);
      if (its?.kind === "chat" && its.side?.kind === "settings") {
        return { sessionId: its.sessionId, botId: its.side.botId };
      }
    }
  }
  return null;
}

/**
 * Holds a layout to one preview per conversation, and one tab of each view of its flow.
 *
 * Opening never makes a second one, but a layout saved before that rule can carry several. The
 * one nearest the keyboard stays — the focused pane first, then reading order — and the rest
 * close the way a closed tab does. Returns the layout it was given when there is nothing to drop.
 */
export function dropDuplicateBoundTabs(layout: WorkbenchLayout, id: () => string): WorkbenchLayout {
  const seen = new Set<string>();
  const extra: Located[] = [];
  for (const leaf of focusedFirst(layout)) {
    for (const tab of leaf.tabs) {
      if (!ONE_PER_SESSION.has(tab.kind as PaneContent["kind"])) continue;
      const its = contentOfTab(tab);
      if (!its) continue;
      const key = `${its.kind}:${boundSession(its) ?? ""}:${boundView(its) ?? ""}`;
      if (seen.has(key)) extra.push({ leafId: leaf.id, tab });
      else seen.add(key);
    }
  }
  let next = layout;
  for (const at of extra) next = closeTab(next, at.leafId, at.tab.id, id());
  return next;
}

/** The conversation the focused pane is showing, which is the one Stop and the URL follow. */
export function activeSessionId(layout: WorkbenchLayout): string | null {
  const leaf = leafById(layout, layout.focus.leafId);
  const tab = leaf?.tabs.find((candidate) => candidate.id === leaf.activeTabId);
  const content = tab ? contentOfTab(tab) : null;
  if (!content) return null;
  return "sessionId" in content ? content.sessionId : null;
}
