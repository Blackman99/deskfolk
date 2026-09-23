/**
 * Putting something into the arrangement.
 *
 * The rule everything here follows: **never rearrange the layout behind the person's back.** If a
 * pane already shows what is being asked for, that pane is focused and nothing else moves. A
 * conversation's preview and flow board are one pane each, so a request for another file or job
 * of that conversation turns the one it has; its settings are not a pane at all but a sidebar
 * inside its own tab. Only when nothing shows it does the active pane take it,
 * and even then the layout's shape is untouched — a tab is added or replaced, never a pane opened
 * or closed.
 */
import type { NodeId, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import {
  activateTab,
  addTab,
  closeTab,
  focusLeaf,
  leafById,
  replaceTabParams,
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

export type OpenOptions = {
  /** A fresh tab id, for when one has to be made. */
  id: () => string;
  /**
   * Replace the active pane's current tab rather than sitting beside it. What clicking a
   * conversation in the roster does: you asked to go there, not to collect tabs.
   */
  replaceActive?: boolean;
};

/**
 * Kinds there can only be one of at a time. Asking for it again moves the single pane rather than
 * making a rival. (The settings sidebar has the same rule for the same reason; see `openChat`.)
 */
const SINGLE_INSTANCE = new Set<PaneContent["kind"]>(["routines"]);

/**
 * Kinds a conversation has exactly one of.
 *
 * A conversation's preview and its flow board are bound to it. Whatever inside it asks for a file
 * or a job — a message, the preview's own file tree, a card on the board — the pane it already has
 * turns to that, rather than a second one opening beside it. Each conversation keeps its own.
 */
const ONE_PER_SESSION = new Set<PaneContent["kind"]>(["preview", "trace"]);

function boundSession(content: PaneContent): string | null {
  return "sessionId" in content ? content.sessionId : null;
}

/** The pane holding this conversation's one tab of this kind, the focused pane first. */
export function findBound(
  layout: WorkbenchLayout,
  kind: PaneContent["kind"],
  sessionId: string | null,
): Located | null {
  for (const leaf of focusedFirst(layout)) {
    for (const tab of leaf.tabs) {
      if (tab.kind !== kind) continue;
      const its = contentOfTab(tab);
      if (its && boundSession(its) === sessionId) return { leafId: leaf.id, tab };
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
  if (ONE_PER_SESSION.has(content.kind)) return findBound(layout, content.kind, boundSession(content));
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
    // Asking for the board with no job in mind is asking to see it, not to move it off the job
    // it is showing. A message's card is a request to move, so it is applied.
    const keep = content.kind === "trace" && !content.taskId && !content.focus;
    return retarget(layout, existing, keep ? null : content);
  }
  const found = findContent(layout, content);
  if (found) {
    const focused = focusLeaf(layout, found.leafId);
    return activateTab(focused, found.leafId, found.tab.id);
  }
  return placeInActivePane(layout, content, opts);
}

/** A new tab in the pane the keyboard is in. */
function placeInActivePane(
  layout: WorkbenchLayout,
  content: PaneContent,
  opts: OpenOptions,
): WorkbenchLayout {
  const leafId = layout.focus.leafId;
  const leaf = leafById(layout, leafId);
  if (!leaf) return layout;

  const tab = tabFor(content, opts.id());
  if (opts.replaceActive && leaf.activeTabId) {
    const current = leaf.tabs.find((candidate) => candidate.id === leaf.activeTabId);
    const currentContent = current ? contentOfTab(current) : null;
    // Only a conversation gives way to another conversation. A terminal or the workspace in this
    // pane is something you put there on purpose, so it is kept and the new tab sits beside it.
    if (current && currentContent?.kind === content.kind && content.kind === "chat") {
      const withNew = addTab(layout, leafId, tab);
      return focusLeaf(closeTab(withNew, leafId, current.id, opts.id()), leafId);
    }
  }
  return focusLeaf(addTab(layout, leafId, tab), leafId);
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
    next = placeInActivePane(layout, { ...content, side: content.side ?? null }, opts);
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
 * Holds a layout to one preview and one flow board per conversation.
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
      const key = `${its.kind}:${boundSession(its) ?? ""}`;
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
