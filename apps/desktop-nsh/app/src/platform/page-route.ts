/**
 * The phone's page and the browser's history: the Svelte page's routing (`routes/+page.svelte`,
 * `back-floor.ts`), on NSH's `UrlScheme`. Hosted only; the desktop has no address.
 *
 * - The address says what is open, as on the Svelte page (`session-url.ts`): the conversation
 *   `?s=`, settings, a page over the roster or a pane of the conversation `?o=` (a Bot's `&b=`),
 *   an attachment `?a=` (a file no attachment backs as `a=file`: an entry, not a name). A reload,
 *   a link and the browser's back and forward land on what the
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
 *
 * Settings' pages on a phone (a tab, a section of it, the endpoint editor's form) each have an
 * entry of their own, at settings' address with `#l<depth>` (`LEVEL`), written under the press that
 * opens the page; Back between them steps out of one page and writes nothing. A dialog that took
 * Back and stayed open would have NSH push its entry again with no press, and Chromium's history
 * intervention then passes over every entry of the page: the next Back on a phone left the app.
 */
import { ATTACHMENT_UNNAMED, attachmentFromUrl, overlayApply, overlayFromFlags, overlayFromUrl, selectionFromUrl, sessionFromUrl, sessionUrl, viewFromUrl, type UrlOverlay, type UrlView } from "../m/session-url.ts";
import { planUrlNavigation, routeStep, stackAfter } from "../m/mobile-route.ts";

/** Where the floor's entry is: the first entry's address with this fragment. */
export const FLOOR = "#floor";

/** A page inside the dialog the address carries: its entry is the dialog's address with this fragment and how deep the page is. */
export const LEVEL = "#l";

/** How long a conversation opened from the roster waits for its entry (`PageRoute.entryFirst`) before it opens anyway. */
export const ENTRY_WAIT_MS = 250;

/** How deep `url`'s fragment says its page is inside the dialog the address carries (0: the dialog itself, or none). */
export function levelOf(url: string): number {
  const match = /#l(\d+)$/.exec(url);
  return match ? Number(match[1]) : 0;
}

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
  /** The page's own `history.go(delta)`. */
  go(delta: number): void;
  /** Runs `then` once the page is at `href`'s fragment `hash` (a replace lands a turn later). */
  whenAt(hash: string, then: () => void): void;
  /** Runs `then` once `ready()` holds (an address set lands a turn later), or after `ENTRY_WAIT_MS` without it. */
  whenThere(ready: () => boolean, then: () => void): void;
  /** Runs `then` after the current turn, once what it changed has been reported. */
  later(then: () => void): void;
  /** How many of NSH's dialogs the current entry is under (`history.state.nsh`): 0 at a screen of the app's own. */
  dialogDepth(): number;
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
  readonly gitOpen: boolean;
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
  /** Out of the deepest page of the dialog the address carries (`PageRoute.levels`), as its ‹ does; never the dialog itself. */
  stepOutOfDialog?(): void;
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

let live: PageRoute | null = null;

/** The page's route hears what has pages of its own (`reportLevels`) and opens them (`stepIn`); the returned function stops it. */
export function provideRoute(route: PageRoute): () => void {
  live = route;
  return () => {
    if (live === route) live = null;
  };
}

/**
 * A part of the page with pages of its own under one address, each with a history entry
 * (`#l<n>`): settings' tab and section, the endpoint editor's pages, a conversation's settings'
 * sections, an enlarged picture, a sheet's sub-list. `depth` is how many it has open now.
 * `inModal`: they lie inside an NSH dialog, whose closing takes their entries away with its own;
 * otherwise a page the app closes is gone back over. `stepOut` closes the deepest, as its ‹ does
 * (the shell's `stepOutOfDialog` when none is given).
 */
export type LevelSource = { key: string; depth: number; inModal: boolean; stepOut?: () => void };

/** The parts with pages of their own, bottom first (`PageRoute.levels`). Nothing without a page (the desktop). */
export function reportLevels(sources: readonly LevelSource[]): void {
  live?.levels(sources);
}

/**
 * Opens one page deeper (`apply`) after its history entry is written (`PageRoute.stepIn`), so the
 * picture Chrome on Android keeps of the page under it is that page. At once without a page.
 */
export function stepIn(apply: () => void): void {
  if (live) live.stepIn(apply);
  else apply();
}

/** `PageRoute.afterEntry` on the page's route; false without a page (the desktop), where nothing waits. */
export function afterEntry(then: () => void): boolean {
  if (!live) return false;
  live.afterEntry(then);
  return true;
}

const total = (sources: readonly LevelSource[]) => sources.reduce((sum, s) => sum + s.depth, 0);

/** Numbers as the dialogs that carry them, bottom first: what `levels` took before it had keys. */
const asDialogs = (layers: readonly (number | LevelSource)[]): LevelSource[] =>
  layers.map((layer, i) => (typeof layer === "number" ? { key: `dialog-${i}`, depth: layer, inModal: true } : layer));

/** What a fallback of the route's did, for `phone-web-e2e` to count: each is a picture taken late. */
function late(what: string): void {
  console.info(`[page-route] ${what}`);
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
    gitOpen: rt.gitOpen,
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
  /** How deep the page's entry is in the dialog the address carries (`LEVEL`), or will be once a move of ours lands. */
  private level = 0;
  /** The parts with pages of their own, as last reported (`levels`). */
  private sources: readonly LevelSource[] = [];
  /** Moves of ours over the dialog's pages' entries on their way: their `change`s are not the person's. */
  private ownMoves = 0;

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
      // A file no attachment backs (`ATTACHMENT_UNNAMED`) is not named: nothing to open again.
      if (from.previewAttachmentId && from.previewAttachmentId !== ATTACHMENT_UNNAMED) this.rt.previewAttachmentId = from.previewAttachmentId;
    }
    if (from.overlay.kind !== "none") this.rt.applyOverlay(from.overlay);
  }

  /** The floor under the first entry, unless a reload kept the first load's. */
  armFloor(): void {
    if (this.page.navigation() === "reload") {
      // Reloaded on a page of settings: settings opens on its list, and the entry says so.
      if (levelOf(this.page.href()) > 0) this.page.setUrl(this.address(), "replace");
      return;
    }
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
    const marker = levelOf(raw);
    if (move === "open") {
      // An earlier load's entry (a reload keeps them): none of its pages is open in this load.
      this.level = 0;
      this.ownMoves = 0;
      if (marker > 0) {
        // One of settings' pages: on back to settings' own entry, which is what this load shows.
        this.page.go(-1);
        return;
      }
    } else if ((marker > 0 || this.level > 0 || this.ownMoves > 0) && sameQuery(new URL(url), this.url())) {
      // Between the entries of the dialog's pages: no screen of the address changes.
      this.toLevel(marker);
      return;
    }
    if (move === "back" && this.selfBack) {
      this.selfBack = false;
      this.land(url);
      return;
    }
    // A layer the address does not carry closes first; the entry Back left goes up again. Settings
    // is a dialog the address carries: Back reached its `onCancel` first, it stepped out of a tab's
    // page and stayed, and NSH has given its entry back already, at the address under it; the
    // address goes onto that entry, as another would be one Back too many. A layer with pages of
    // its own (`levels`) never comes here: its entry is its own.
    if (move === "back" && this.chainOf()?.backMobileLayer()) {
      if (!this.rt.settingsOpen) late("a layer with no entry of its own took Back; its screen's entry went up again");
      this.page.setUrl(this.address(), this.rt.settingsOpen ? "replace" : "push");
      return;
    }
    if (move === "open") this.stack = [new URL(url).search];
    this.land(url);
    // Returning by Back onto a page entry that carried a drill-down fragment (e.g. a file preview
    // pushed over `#l1`) restores the level depth so the next Back steps out one level cleanly.
    if (move !== "open" && marker > 0) this.level = marker;
  }

  /**
   * The parts with pages of their own (`LevelSource`), bottom first: settings under its list (a
   * tab, a section of it), the endpoint editor over it under its first page, a conversation's
   * settings' sections, an enlarged picture… (numbers: dialogs, as before keys). A page opened gets
   * an entry after the one showing: under the press, by `stepIn`, before it shows; here, after it
   * shows, only as a fallback. A page the app stepped out of itself (‹, ✕, Escape) is gone back
   * over. A dialog that closed took its pages' entries with its own (NSH goes back over them), so
   * nothing of ours moves for those.
   */
  levels(reported: readonly (number | LevelSource)[]): void {
    const next = asDialogs(reported);
    const keys = new Set(next.map((s) => s.key));
    const gone = this.sources.filter((s) => s.inModal && !keys.has(s.key));
    let before = total(this.sources);
    if (gone.length > 0) {
      before -= total(gone);
      this.level = Math.min(this.level, before);
    }
    this.sources = next;
    const now = total(next);
    // Only a page opened writes an entry: never what a Back stepped out of, which counts down.
    if (now > before && now > this.level) {
      late(`a page opened before its entry was written (level ${now}): the one under it is pictured with it`);
      this.level = now;
      this.page.setUrl(`${this.address()}${LEVEL}${now}`, "push");
      return;
    }
    if (now < this.level) {
      const delta = now - this.level;
      this.level = now;
      // One move at a time: one on its way goes on from where it lands (`toLevel`).
      if (this.ownMoves === 0) this.travel(delta);
    }
  }

  /**
   * One page deeper, its entry first: `apply` opens it once the page is at that entry, so the
   * frame the browser drew as it left the entry under it (Chrome on Android's picture of that
   * entry, under a back swipe) is the page it was. `levels` then finds the entry there already. A
   * press that opened nothing deeper after all (`apply` changed no depth) leaves no entry behind.
   * A menu the press came from closes before this, not in `apply`: an entry written while an NSH
   * dialog's own entry is the current one goes with that dialog when it closes.
   */
  stepIn(apply: () => void): void {
    if (this.onFloor || this.ownMoves > 0) {
      apply();
      return;
    }
    const deeper = this.level + 1;
    this.level = deeper;
    this.page.setUrl(`${this.address()}${LEVEL}${deeper}`, "push");
    this.page.whenThere(
      () => levelOf(this.page.href()) === deeper,
      () => {
        apply();
        this.page.later(() => {
          const now = total(this.sources);
          if (this.level === deeper && now < deeper && this.ownMoves === 0) {
            this.level = now;
            this.travel(now - deeper);
          }
        });
      },
    );
  }

  private travel(delta: number): void {
    this.ownMoves += 1;
    this.page.go(delta);
  }

  /** The page landed on the entry of the dialog's page `marker` deep. */
  private toLevel(marker: number): void {
    if (this.ownMoves > 0) {
      this.ownMoves -= 1;
      // Pages stepped out of while it was on its way: on to where the app is now.
      if (this.ownMoves === 0 && marker !== this.level) this.travel(this.level - marker);
      return;
    }
    if (marker > this.level) {
      // Forward onto a page the app has closed since: back to the one showing.
      this.travel(this.level - marker);
      return;
    }
    // Back: out of as many pages as the entry is under the one showing, counted before the first
    // step, as each step reports the levels again; the deepest part's first.
    let steps = this.level - marker;
    this.level = marker;
    for (const source of [...this.sources].reverse()) {
      for (let i = 0; i < source.depth && steps > 0; i++, steps--) (source.stepOut ?? (() => this.chainOf()?.stepOutOfDialog?.()))();
      if (steps === 0) break;
    }
    for (; steps > 0; steps--) this.chainOf()?.stepOutOfDialog?.();
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
    // The entry of a file no attachment backs: whatever is open stays (the address cannot say which).
    if (wanted === ATTACHMENT_UNNAMED) return;
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
    if ((wanted.kind === "session" || wanted.kind === "bot" || wanted.kind === "trace" || wanted.kind === "git") && sessionFromUrl(url) !== selectedId) return;
    // The window follows the conversation, so a stale job id in the address must not win.
    if (wanted.kind === "trace" && this.rt.traceOpen) return;
    // The page's address never names the workspace's file (`sessionUrl` drops it on a remote
    // page): at the workspace it only says the workspace is open. Applied again while it was (this
    // runs on every change of the snapshot), it put the file picked in it back to none, so a file
    // pressed there went the moment a conversation moved on the Mac.
    if (wanted.kind === "workspace" && this.rt.workspaceOpen) return;
    const next = overlayApply(wanted, overlayOf(this.rt), {
      selectedId,
      knownSessionIds: this.rt.snapshot.sessions.map((s) => s.id),
      knownBotIds: this.rt.snapshot.bots.map((b) => b.id),
      hasWorkspacePath: Boolean(this.rt.snapshot.settings.workspace_path),
      snapshotReady: this.rt.connection === "connected",
    });
    if (next.action === "set") this.rt.applyOverlay(next.overlay);
  }

  /**
   * A conversation opened from the roster or from another one (a row, a link, a notification): its
   * entry first, the conversation once the page is there. Chrome on Android pictures an entry as
   * the page leaves it and slides the page off that picture under a back swipe. NSH writes the
   * app's address a turn after the press, when the browser has drawn what the press opened
   * already, so the entry under was pictured with the conversation over it and the swipe back
   * showed the conversation under itself. Written before anything changes, the screen it opens from
   * is what the browser drew last; `write` then finds the page there. Only where `write` would push
   * an entry of its own, from a screen the address names alone (no page, file or dialog over it: a
   * dialog's closing in the same turn would take an entry pushed now away with its own). Null when
   * there is nothing to wait for.
   */
  entryFirst(id: string): Promise<void> | null {
    if (this.onFloor || this.page.dialogDepth() > 0) return null;
    const view = viewOf(this.rt);
    if (view.selectedId === id || view.previewRelpath || view.previewAttachmentId || view.overlay.kind !== "none") return null;
    const current = this.url();
    const wanted = { ...view, selectedId: id };
    const target = sessionUrl(current, wanted, true);
    if (!target) return null;
    const next = new URL(target, current);
    const there = () => sameQuery(new URL(withoutHash(this.page.href())), next);
    if (there()) return null;
    if (planUrlNavigation({ target: next.search, stack: this.stack, step: routeStep(viewFromUrl(current, true), wanted) }) !== "push") return null;
    this.page.setUrl(next.href, "push");
    return new Promise((resolve) => this.page.whenThere(there, resolve));
  }

  /**
   * Runs `then` once the page is at the address the app is at, which NSH writes a turn or more
   * after the app moved there (at most `ENTRY_WAIT_MS` later). A view that covers the screen under
   * it (a file's preview, settings, a conversation's settings) shows from then (`revealOnEntry`),
   * so the frame the browser draws before the entry exists is the screen under it: what Chrome on
   * Android pictures as the entry left (see `entryFirst`).
   */
  afterEntry(then: () => void): void {
    this.page.whenThere(() => sameQuery(new URL(withoutHash(this.page.href())), this.url()), then);
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
    // Another address: the pages of the one it leaves stay behind it in history, not counted here.
    const dropLevels = this.level;
    this.level = 0;
    if (plan === "back") {
      this.selfBack = true;
      // The address is the target already, so a snapshot that comes before Back lands reads it.
      this.address.set(next.href);
      if (dropLevels > 0) this.page.go(-(dropLevels + 1));
      else this.page.back();
      return;
    }
    this.page.setUrl(next.href, plan);
    this.stack = stackAfter(this.stack, next.search, plan === "replace");
    this.address.set(next.href);
  }
}
