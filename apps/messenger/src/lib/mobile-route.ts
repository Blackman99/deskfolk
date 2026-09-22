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
 * pushes, so Back retraces where you have been rather than dropping you at the roster.
 */
import type { UrlOverlay, UrlView } from "./session-url.ts";

/** The phone's three destinations, in the order the bottom bar shows them. */
export type MobileDestination = "sessions" | "workspace" | "settings";

export type RouteStep = "deeper" | "shallower" | "lateral";
export type UrlNavigation = "push" | "replace" | "back";

function overlayLayers(overlay: UrlOverlay): string[] {
  if (overlay.kind === "none") return [];
  if (overlay.kind === "bot") return [`bot:${overlay.botId}`];
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

export function routeStep(prev: UrlView, next: UrlView): RouteStep {
  const before = routeLayers(prev).length;
  const after = routeLayers(next).length;
  if (after > before) return "deeper";
  if (after < before) return "shallower";
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
  // Landing exactly on the entry underneath is a step back, whatever the depth says: closing a
  // Bot's profile inside a group drawer swaps one screen for another, and the drawer is where it
  // came from.
  if (args.stack[args.stack.length - 2] === args.target) return "back";
  if (args.step === "shallower") return "replace";
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
  | "theme-menu"
  | "create-menu"
  | "danger"
  | "create-bot"
  | "create-group"
  | "provider-editor"
  | "independent-confirm"
  | "search-page"
  | "settings"
  | "session-settings"
  | "terminal"
  | "route-log"
  | "thread"
  | "workspace"
  | "preview";

export type LayerState = {
  themeMenuOpen: boolean;
  createMenuOpen: boolean;
  dangerConfirm: boolean;
  createBotOpen: boolean;
  createGroupOpen: boolean;
  providerEditor: boolean;
  confirmingIndependent: boolean;
  searchPageOpen: boolean;
  settingsOpen: boolean;
  sessionSettingsOpen: boolean;
  terminalOpen: boolean;
  routeLogOpen: boolean;
  threadOpen: boolean;
  workspaceOpen: boolean;
  artifactPreview: boolean;
};

const LAYER_ORDER: ReadonlyArray<[BackLayer, keyof LayerState]> = [
  ["theme-menu", "themeMenuOpen"],
  // The phone's + menu, like any other menu: over everything, gone at the first Back.
  ["create-menu", "createMenuOpen"],
  ["danger", "dangerConfirm"],
  ["create-bot", "createBotOpen"],
  ["create-group", "createGroupOpen"],
  ["provider-editor", "providerEditor"],
  ["independent-confirm", "confirmingIndependent"],
  // The phone's search page is the sidebar's, not the URL's — it comes before the destinations
  // for the same reason the create sheets do: the app closes it itself, Back never navigates.
  ["search-page", "searchPageOpen"],
  ["settings", "settingsOpen"],
  ["session-settings", "sessionSettingsOpen"],
  // Yours, not a place in a conversation: the app closes it, Back never navigates to it.
  ["terminal", "terminalOpen"],
  ["route-log", "routeLogOpen"],
  ["thread", "threadOpen"],
  ["workspace", "workspaceOpen"],
  ["preview", "artifactPreview"],
];

export function topLayer(state: LayerState): BackLayer | null {
  for (const [layer, flag] of LAYER_ORDER) if (state[flag]) return layer;
  return null;
}
