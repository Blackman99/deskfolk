/**
 * What the URL means as a stack of screens, and what a change to it should do to history.
 *
 * The rule that matters: **opening a screen pushes, closing one never does.** Closing used to
 * push too, which put the state you had just left in front of you — press Back after closing a
 * drawer and the drawer came back, then closed again, forever. So a change that removes a screen
 * either walks back to the entry that opened it (when that is where the URL already points) or
 * rewrites the current entry, and Back keeps retreating instead of bouncing.
 *
 * Switching to another screen at the same depth — a different session, another Bot's profile —
 * pushes, so Back retraces where you have been rather than dropping you at the roster. Picking
 * another file inside a preview is not one of those: it is still the same screen, so it rewrites
 * the entry and Back leaves the preview instead of stepping through every file looked at.
 */
import type { UrlOverlay, UrlView } from "./session-url.ts";

/** The phone's three destinations, in the order the bottom bar shows them. */
export type MobileDestination = "sessions" | "workspace" | "settings";

export type RouteStep = "deeper" | "shallower" | "lateral" | "swap";
export type UrlNavigation = "push" | "replace" | "back";

function overlayLayers(overlay: UrlOverlay): string[] {
  if (overlay.kind === "none") return [];
  if (overlay.kind === "bot") return [`bot:${overlay.botId}`];
  if (overlay.kind === "trace") return [overlay.taskId ? `trace:${overlay.taskId}` : "trace"];
  if (overlay.kind === "workspace") {
    // The file open inside the workspace is its own screen: closing it keeps the workspace.
    return overlay.selected ? ["workspace", `workspace-file:${overlay.selected}`] : ["workspace"];
  }
  return [overlay.kind];
}

/** The screens this URL stands for, outermost first. */
export function routeLayers(view: UrlView): string[] {
  const layers: string[] = [];
  if (view.selectedId) layers.push(`session:${view.selectedId}`);
  layers.push(...overlayLayers(view.overlay));
  if (view.previewRelpath) layers.push(`preview:${view.previewRelpath}`);
  if (view.previewAttachmentId) layers.push(`attachment:${view.previewAttachmentId}`);
  return layers;
}

/** The screens that show one file, where picking another file is not going anywhere. */
const FILE_LAYERS = ["preview:", "attachment:", "workspace-file:"];

function fileLayer(layer: string): string | null {
  return FILE_LAYERS.find((prefix) => layer.startsWith(prefix)) ?? null;
}

export function routeStep(prev: UrlView, next: UrlView): RouteStep {
  const before = routeLayers(prev);
  const after = routeLayers(next);
  if (after.length > before.length) return "deeper";
  if (after.length < before.length) return "shallower";
  const changed = before.flatMap((layer, i) => (layer === after[i] ? [] : [i]));
  if (changed.length === 1) {
    const kind = fileLayer(before[changed[0]]);
    if (kind && kind === fileLayer(after[changed[0]])) return "swap";
  }
  // A Bot opened from a group's settings is that Bot's settings page. It takes the group's
  // place, so leaving it returns to the conversation rather than to the group.
  if (
    prev.selectedId === next.selectedId &&
    prev.overlay.kind === "session" &&
    next.overlay.kind === "bot"
  ) return "swap";
  return "lateral";
}

/**
 * `stack` is the entries this page created, oldest first, the last one being where the URL is
 * now. A `back` is only proposed when the entry underneath is exactly the target, so a deep link
 * (nothing of ours underneath) rewrites its entry rather than walking out of the app.
 */
export function planUrlNavigation(args: {
  target: string;
  stack: readonly string[];
  step: RouteStep;
}): UrlNavigation {
  // Landing exactly on the entry underneath is a step back, whatever the depth says. A Bot
  // opened from a group takes that group's settings entry, so the conversation is what is
  // underneath when it closes.
  if (args.stack[args.stack.length - 2] === args.target) return "back";
  if (args.step === "shallower" || args.step === "swap") return "replace";
  return "push";
}

/**
 * The stack after the URL became `search`, given what we knew. A step back pops; anything else
 * is a new top — a replacement rewrites it, a push extends it.
 */
export function stackAfter(stack: readonly string[], search: string, replaced: boolean): string[] {
  const next = [...stack];
  if (next[next.length - 1] === search) return next;
  if (next[next.length - 2] === search) {
    next.pop();
    return next;
  }
  if (replaced && next.length > 0) {
    next[next.length - 1] = search;
    return next;
  }
  next.push(search);
  return next;
}

/**
 * What Back closes, innermost first.
 *
 * The order is the one Escape has always walked in `Shell.svelte`; it lives here so the phone's
 * Back and that keyboard chain cannot drift apart silently. Screens the URL carries — the
 * session, an overlay, a preview — come last: by then Back is a real navigation and history
 * takes it from there.
 */
export type BackLayer =
  | "image"
  | "tools-menu"
  | "create-menu"
  | "danger"
  | "create-bot"
  | "create-group"
  | "provider-editor"
  | "independent-confirm"
  | "search"
  | "settings"
  | "session-settings"
  | "terminal"
  | "trace"
  | "routines"
  | "spend"
  | "thread"
  | "workspace"
  | "preview";

export type LayerState = {
  imageOpen: boolean;
  toolsMenuOpen: boolean;
  createMenuOpen: boolean;
  dangerConfirm: boolean;
  createBotOpen: boolean;
  createGroupOpen: boolean;
  providerEditor: boolean;
  confirmingIndependent: boolean;
  searchOpen: boolean;
  settingsOpen: boolean;
  sessionSettingsOpen: boolean;
  terminalOpen: boolean;
  traceOpen: boolean;
  routinesOpen: boolean;
  spendOpen: boolean;
  threadOpen: boolean;
  workspaceOpen: boolean;
  artifactPreview: boolean;
};

const LAYER_ORDER: ReadonlyArray<[BackLayer, keyof LayerState]> = [
  // An enlarged picture covers everything, whatever it was opened from; Back puts it away first.
  ["image", "imageOpen"],
  // Close the tools menu before navigating.
  ["tools-menu", "toolsMenuOpen"],
  // The phone's + menu, like any other menu: over everything, gone at the first Back.
  ["create-menu", "createMenuOpen"],
  ["danger", "dangerConfirm"],
  ["create-bot", "createBotOpen"],
  ["create-group", "createGroupOpen"],
  ["provider-editor", "providerEditor"],
  ["independent-confirm", "confirmingIndependent"],
  // Global search is an app-owned modal; Back closes it before navigating the page underneath.
  ["search", "searchOpen"],
  ["settings", "settingsOpen"],
  ["session-settings", "sessionSettingsOpen"],
  // A history entry, like the calendar. The page's button closes it, and Back walks the URL.
  ["terminal", "terminalOpen"],
  ["trace", "traceOpen"],
  ["routines", "routinesOpen"],
  ["spend", "spendOpen"],
  ["thread", "threadOpen"],
  ["workspace", "workspaceOpen"],
  ["preview", "artifactPreview"],
];

export function topLayer(state: LayerState): BackLayer | null {
  for (const [layer, flag] of LAYER_ORDER) if (state[flag]) return layer;
  return null;
}
