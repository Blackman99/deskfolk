/**
 * The phone's page and the browser's history: the Svelte page's routing (`routes/+page.svelte`,
 * `back-floor.ts`), on NSH's `UrlScheme`. Hosted only; the desktop has no address.
 *
 * - The address says what is open, as on the Svelte page (`session-url.ts`): the conversation
 *   `?s=`, settings, a page over the roster or a pane of the conversation `?o=` (a Bot's `&b=`),
 *   an attachment `?a=`. A reload, a link and the browser's back and forward land on what the
 *   address names.
 * - History is a stack of screens (`mobile-route.ts`): opening one pushes an entry, closing one
 *   walks back to the entry that opened it, or rewrites the entry when nothing of ours is under it.
 * - Back closes what the address does not carry (a search, a thread, a find bar) before it leaves
 *   a screen (`backMobileLayer`), and the entry it left goes up again.
 * - A floor under the first entry (`#floor`, the Svelte page's `armBackFloor`): Back there closes
 *   the screen showing, down to the roster (`backFromFloor`), and the app goes up again over it;
 *   with nothing left to close Back goes on out of the page. A reload keeps the first load's floor
 *   below it, which NSH hands over as an `open` of `#floor`.
 *
 * NSH writes history too: an entry per sheet, dialog and menu (a modal), which Back closes on its
 * own. Measured on 48559f8 (Chromium and WebKit): `setUrl` with `push` is one entry and Back off it
 * is a `change` with the address under it; the app's own `history.back()` is a `change` as well;
 * a replace and a push in one turn are the push alone, so the floor's push waits for its replace.
 * Settings is a modal that the address carries too: a Back that closes it has moved the page
 * already, so where to go is decided from where the page is (`href`), not only from our stack.
 */
import { attachmentFromUrl, overlayApply, overlayFromFlags, overlayFromUrl, selectionFromUrl, sessionFromUrl, sessionUrl, viewFromUrl, type UrlOverlay, type UrlView } from "../m/session-url.ts";
import { planUrlNavigation, routeStep, stackAfter } from "../m/mobile-route.ts";

/** Where the floor's entry is: the first entry's address with this fragment. */
export const FLOOR = "#floor";

/** How the page's address moved without the app moving it (NSH's `change` reasons, and `open`). */
export type AddressMove = "back" | "forward" | "address" | "open";

/** The page's history, as the app reaches it: NSH's `UrlScheme` and the page's own window. */
export interface PageHistory {
  /** Where the page is now. */
  href(): string;
  /** The page load's kind (`PerformanceNavigationTiming.type`): `"reload"` keeps the first load's floor. */
  navigation(): string | undefined;
  setUrl(url: string, history: "push" | "replace"): void;
  /** The page's own `history.back()`. */
  back(): void;
  /** Runs `then` once the page is at `href`'s fragment `hash` (a replace lands a turn later). */
  whenAt(hash: string, then: () => void): void;
  onAddress(listener: (url: string, move: AddressMove) => void): () => void;
}

/** What this reads and writes of the runtime (`MessengerRuntime`). */
export interface RouteRuntime {
  selectedId: string | null;
  previewRelpath: string | null;
  previewAttachmentId: string | null;
  readonly settingsOpen: boolean;
  readonly sessionSettingsOpen: boolean;
  readonly profileBotId: string | null;
  readonly workspaceOpen: boolean;
  readonly workspaceSelected: string | null;
  readonly traceOpen: boolean;
  readonly traceTaskId: string | null;
  readonly routinesOpen: boolean;
  readonly spendOpen: boolean;
  readonly terminalOpen: boolean;
  readonly screenOpen: boolean;
  readonly listPage: "usage" | "archived" | "roles" | null;
  readonly connection: string;
  readonly snapshot: { sessions: readonly { id: string }[]; bots: readonly { id: string }[]; settings: { workspace_path?: string | null } };
  applyOverlay(overlay: UrlOverlay): void;
  selectSession(id: string, opts?: { preservePage?: boolean }): Promise<void>;
}

/** The shell's Back (`shell-state.ts`), once it is up. */
export interface BackChain {
  backMobileLayer(): boolean;
  backFromFloor(): boolean;
}

/** A value whose reads the caller's effect follows (an NSH `signal`). */
export interface Cell<T> {
  (): T;
  set(value: T): void;
}

let chain: BackChain | null = null;

/** The shell gives its Back to the page; the returned function takes it away. */
export function provideBackChain(next: BackChain): () => void {
  chain = next;
  return () => {
    if (chain === next) chain = null;
  };
}

/** `url` without its fragment. */
export function withoutHash(url: string): string {
  const at = url.indexOf("#");
  return at === -1 ? url : url.slice(0, at);
}

function sameQuery(a: URL, b: URL): boolean {
  const entries = (url: URL) => [...url.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort().join("&");
  return a.pathname === b.pathname && entries(a) === entries(b);
}

/** The overlays that are NSH dialogs, each with a history entry of NSH's own. */
const DIALOG_OVERLAYS = new Set(["settings", "session", "bot"]);

/** The overlays that need nothing from the snapshot to be applied (`+page.svelte`). */
const PLAIN_OVERLAYS = new Set(["none", "routines", "spend", "terminal", "screen", "usage", "archived"]);

export function overlayOf(rt: RouteRuntime): UrlOverlay {
  return overlayFromFlags({
    settingsOpen: rt.settingsOpen,
    sessionSettingsOpen: rt.sessionSettingsOpen,
    profileBotId: rt.profileBotId,
    workspaceOpen: rt.workspaceOpen,
    workspaceSelected: rt.workspaceSelected,
    traceOpen: rt.traceOpen,
    traceTaskId: rt.traceTaskId,
    routinesOpen: rt.routinesOpen,
    spendOpen: rt.spendOpen,
    terminalOpen: rt.terminalOpen,
    screenOpen: rt.screenOpen,
    listPage: rt.listPage,
  });
}

export function viewOf(rt: RouteRuntime): UrlView {
  return { selectedId: rt.selectedId, previewRelpath: rt.previewRelpath, previewAttachmentId: rt.previewAttachmentId, overlay: overlayOf(rt) };
}

export class PageRoute {
  /** The entries this page made, oldest first, the last being where the page is (`+page.svelte`'s `routeStack`). */
  stack: string[];
  /** A `back()` of ours, so its `change` is not the person pressing Back. */
  private selfBack = false;
  /** Back landed on the floor and is being answered: what it closes writes no address of its own. */
  private onFloor = false;

  constructor(
    private readonly page: PageHistory,
    private readonly rt: RouteRuntime,
    /** The address the app is at, without the floor's fragment; effects that read it follow it. */
    readonly address: Cell<string>,
    private readonly chainOf: () => BackChain | null = () => chain,
  ) {
    this.stack = [new URL(address()).search];
  }

  url(): URL {
    return new URL(this.address());
  }

  /** Before the runtime connects: what the address names, as the Svelte page seeds it. */
  seed(): void {
    const from = viewFromUrl(this.url(), true);
    if (from.selectedId) this.rt.selectedId = from.selectedId;
    // The calendar drops a file preview: seeding one and then clearing it would flash the pane.
    if (from.overlay.kind !== "routines" && from.overlay.kind !== "spend" && from.overlay.kind !== "terminal") {
      if (from.previewAttachmentId) this.rt.previewAttachmentId = from.previewAttachmentId;
    }
    if (from.overlay.kind !== "none") this.rt.applyOverlay(from.overlay);
  }

  /** The floor under the first entry, unless a reload kept the first load's. */
  armFloor(): void {
    if (this.page.navigation() === "reload") return;
    const here = this.address();
    this.page.setUrl(`${here}${FLOOR}`, "replace");
    this.page.whenAt(FLOOR, () => this.page.setUrl(here, "push"));
  }

  /** The page's address moved without the app moving it. */
  moved(raw: string, move: AddressMove): void {
    if (new URL(raw).hash === FLOOR) {
      this.landOnFloor();
      return;
    }
    const url = withoutHash(raw);
    if (move === "back" && this.selfBack) {
      this.selfBack = false;
      this.land(url);
      return;
    }
    // A layer the address does not carry closes first; the entry Back left goes up again. Settings
    // is a dialog the address carries: Back reached its `onCancel` first, it stepped out of a tab's
    // page and stayed, and NSH has given its entry back already, at the address under it; the
    // address goes onto that entry, as another would be one Back too many.
    if (move === "back" && this.chainOf()?.backMobileLayer()) {
      this.page.setUrl(this.address(), this.rt.settingsOpen ? "replace" : "push");
      return;
    }
    if (move === "open") this.stack = [new URL(url).search];
    this.land(url);
  }

  private land(url: string): void {
    this.stack = stackAfter(this.stack, new URL(url).search, false);
    if (url !== this.address()) this.address.set(url);
  }

  private landOnFloor(): void {
    this.onFloor = true;
    try {
      if (this.chainOf()?.backFromFloor()) {
        // Something closed: the app goes up again over the floor, at what is open now.
        const current = this.url();
        const target = sessionUrl(current, viewOf(this.rt), true);
        const next = target ? new URL(target, current).href : current.href;
        this.page.setUrl(next, "push");
        this.stack = [new URL(next).search];
        this.address.set(next);
      } else {
        // Nothing left to close: on out of the page.
        this.page.back();
      }
    } finally {
      this.onFloor = false;
    }
  }

  /** The address says another conversation (a link, Back, Forward): `+page.svelte`'s first effect. */
  applySession(url: URL): void {
    const next = selectionFromUrl(sessionFromUrl(url), this.rt.selectedId, this.rt.snapshot.sessions.map((s) => s.id));
    if (next.action === "clear") this.rt.selectedId = null;
    else if (next.action === "select") void this.rt.selectSession(next.id, { preservePage: true });
  }

  applyAttachment(url: URL): void {
    const wanted = attachmentFromUrl(url);
    if (wanted !== this.rt.previewAttachmentId) this.rt.previewAttachmentId = wanted;
  }

  /** The address says another overlay. Those that name a session or a Bot wait for the snapshot to know it. */
  applyOverlay(url: URL): void {
    const wanted = overlayFromUrl(url, true);
    if (PLAIN_OVERLAYS.has(wanted.kind)) {
      if (overlayOf(this.rt).kind !== wanted.kind) this.rt.applyOverlay(wanted);
      return;
    }
    const selectedId = this.rt.selectedId;
    // Session and overlay can land a tick apart: wait until they name the same session.
    if ((wanted.kind === "session" || wanted.kind === "bot" || wanted.kind === "trace") && sessionFromUrl(url) !== selectedId) return;
    // The window follows the conversation, so a stale job id in the address must not win.
    if (wanted.kind === "trace" && this.rt.traceOpen) return;
    const next = overlayApply(wanted, overlayOf(this.rt), {
      selectedId,
      knownSessionIds: this.rt.snapshot.sessions.map((s) => s.id),
      knownBotIds: this.rt.snapshot.bots.map((b) => b.id),
      hasWorkspacePath: Boolean(this.rt.snapshot.settings.workspace_path),
      snapshotReady: this.rt.connection === "connected",
    });
    if (next.action === "set") this.rt.applyOverlay(next.overlay);
  }

  /** What is open moved (a row, a page, a pane, a close): the address follows (`+page.svelte`'s write effect). */
  write(wanted: UrlView): void {
    if (this.onFloor) return;
    const current = this.url();
    const target = sessionUrl(current, wanted, true);
    if (!target) return;
    const next = new URL(target, current);
    // A Back the browser took already (a sheet that the address carries, settings) left the page
    // where this would go: only our books move.
    if (sameQuery(new URL(withoutHash(this.page.href())), next)) {
      this.land(next.href);
      return;
    }
    const from = viewFromUrl(current, true);
    // A dialog the address carries (settings, a conversation's settings) closed by the app (its ✕
    // or ‹, the bottom bar), not by Back. NSH takes the dialog's entry away itself, going back over
    // it (`history.go`), and puts an address set meanwhile on the entry it lands on. A back of ours
    // as well landed after the dialog was gone: NSH took it for a Back the app refused and put the
    // dialog's address back, and our `selfBack` waited for a `change` that never came.
    if (DIALOG_OVERLAYS.has(from.overlay.kind) && !DIALOG_OVERLAYS.has(wanted.overlay.kind)) {
      this.page.setUrl(next.href, "replace");
      const under = this.stack.slice(0, -1);
      this.stack = under.length > 0 ? stackAfter(under, next.search, true) : [next.search];
      this.address.set(next.href);
      return;
    }
    const step = routeStep(from, wanted);
    // A Bot opened from a group's settings takes that page's place: the entry under it is the conversation.
    if (step === "swap" && from.overlay.kind === "session" && wanted.overlay.kind === "bot" && this.stack.length > 0) {
      const under = sessionUrl(current, { ...wanted, overlay: { kind: "none" } }, true);
      if (under) this.stack[this.stack.length - 1] = new URL(under, current).search;
    }
    const plan = planUrlNavigation({ target: next.search, stack: this.stack, step });
    if (plan === "back") {
      this.selfBack = true;
      // The address is the target already, so a snapshot that comes before Back lands reads it.
      this.address.set(next.href);
      this.page.back();
      return;
    }
    this.page.setUrl(next.href, plan);
    this.stack = stackAfter(this.stack, next.search, plan === "replace");
    this.address.set(next.href);
  }
}
