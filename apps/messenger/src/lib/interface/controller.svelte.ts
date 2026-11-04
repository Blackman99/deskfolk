/**
 * This window's side of your interface profile (ADR 0106): applies what the daemon holds, keeps the
 * floor (Stop, cards waiting on you, the way to Settings) on screen by dropping the token and CSS
 * layers where they would hide it, offers two ways back no stylesheet can take away (`?ui=default`
 * and a key), and tells the daemon what it found so a Bot can tell what took.
 *
 * One per window. `Shell` starts it and feeds it each snapshot; the behaviour readers
 * (`interfaceBehaviour`) and the settings read it.
 */
import {
  applyInterfacePatch,
  emptyInterfaceProfile,
  type InterfaceBehaviour,
  type InterfaceCatalog,
  type InterfacePatch,
  type InterfaceProfile,
  type InterfaceState,
  type InterfaceSurface,
  type InterfaceWindowReport,
} from "@real-bot/protocol";
import { adoptFocusMode, localFocusMode } from "../chat/focus-mode.svelte.ts";
import { formatShortcut, isPrimaryModifier } from "../keymap.ts";
import { openPlacements } from "../workbench/open-placement-store.svelte.ts";
import {
  applyInterfaceCss,
  applyMotion,
  cacheInterfaceCss,
  defaultAskedInUrl,
  interfaceCss,
  INTERFACE_STYLE_ID,
  trackSurface,
} from "./apply.ts";
import { interfaceCatalog, tokenDefaults } from "./catalog.ts";
import { floorsHiddenByProfile, FLOOR_SELECTOR, type FloorFailure } from "./floor.ts";
import { setInterfaceBehaviour } from "./behaviour.svelte.ts";
import { badTokens, droppedBlocks, unmatchedSelectors } from "./report.ts";

export type InterfaceApi = {
  patchInterface(body: { patch: InterfacePatch; reason?: string }): Promise<unknown>;
  reportInterfaceWindow(body: { report: Omit<InterfaceWindowReport, "at">; catalog?: InterfaceCatalog }): Promise<void>;
};

export type PausedBy = "url" | "key" | "floor";

/** Settles after a change before the floor is checked and the report sent: layout and fonts first. */
const SETTLE_MS = 400;
const OBSERVE_DEBOUNCE_MS = 250;

/** ⌥⇧⌘U / Ctrl+Alt+Shift+U: this window shows the app's own look until pressed again. */
export function isEscapeKey(event: KeyboardEvent): boolean {
  return event.code === "KeyU" && event.shiftKey && event.altKey && isPrimaryModifier(event);
}

export function escapeKeyLabel(): string {
  return formatShortcut(["alt", "shift", "mod", "U"]);
}

export type InterfaceNotices = {
  floorFailed?: (failures: FloorFailure[]) => void;
  paused?: () => void;
  resumed?: () => void;
};

class InterfaceController {
  /** What the daemon holds; null before it answers, or from a daemon older than ADR 0106. */
  state = $state<InterfaceState | null>(null);
  /** Why this window shows the app's own look now; null when it shows yours. */
  pausedBy = $state<PausedBy | null>(defaultAskedInUrl() ? "url" : null);
  /** The floors your profile hid in this window, when that is why it paused. */
  floorFailed = $state<FloorFailure[]>([]);
  /** A Bot's change you are trying here before you allow it (its card's 试看). */
  trying = $state<{ approvalId: string; profile: InterfaceProfile } | null>(null);
  surface = $state<InterfaceSurface>("desktop");

  private api: InterfaceApi | null = null;
  private appVersion: string | null = null;
  private notices: InterfaceNotices = {};
  private catalogSent = false;
  private started = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private observeTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  private stops: Array<() => void> = [];

  /** The profile in force here: one being tried, else the daemon's. */
  get profile(): InterfaceProfile {
    return this.trying?.profile ?? this.state?.profile ?? emptyInterfaceProfile();
  }

  get behaviour(): InterfaceBehaviour {
    return this.profile.behaviour;
  }

  /** Whether the look (tokens, stylesheet, words) is on in this window. */
  get lookOn(): boolean {
    return this.pausedBy === null && this.profile.enabled;
  }

  /** The words you changed in a language, when the look is on here. */
  copyIn(locale: "zh" | "en"): Readonly<Record<string, string>> | null {
    if (this.pausedBy === "url" || !this.profile.enabled) return null;
    const words = this.profile.copy[locale];
    return Object.keys(words).length ? words : null;
  }

  /** The build this window runs, for the reports and the catalog (`$app/environment`'s version). */
  setAppVersion(version: string | null): void {
    this.appVersion = version;
  }

  start(options: { api: InterfaceApi | null; notices?: InterfaceNotices }): () => void {
    this.api = options.api;
    this.notices = options.notices ?? {};
    this.catalogSent = false;
    if (this.started || typeof window === "undefined") return () => this.stop();
    this.started = true;
    // A sheet loaded later (a view opened for the first time) would come after the profile's and
    // win its ties: the profile's moves back to the end.
    const head = new MutationObserver(() => {
      const style = document.getElementById(INTERFACE_STYLE_ID);
      if (style && document.head.lastElementChild !== style) document.head.appendChild(style);
    });
    head.observe(document.head, { childList: true });
    this.stops.push(() => head.disconnect());
    this.stops.push(trackSurface(document, (surface) => {
      this.surface = surface;
    }));
    const onKey = (event: KeyboardEvent) => {
      if (!isEscapeKey(event)) return;
      event.preventDefault();
      if (this.pausedBy === null) {
        this.pausedBy = "key";
        this.apply();
        this.notices.paused?.();
      } else {
        this.resume();
      }
    };
    // Capture: no handler of the page, and nothing a stylesheet does, comes before it.
    window.addEventListener("keydown", onKey, true);
    this.stops.push(() => window.removeEventListener("keydown", onKey, true));
    return () => this.stop();
  }

  /** A new connection: the api to report through, and the catalog to send again. */
  connect(api: InterfaceApi | null): void {
    if (api !== this.api) this.catalogSent = false;
    this.api = api;
  }

  private stop(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.observer?.disconnect();
    this.observer = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.observeTimer) clearTimeout(this.observeTimer);
    this.started = false;
  }

  /**
   * Focus mode and where windows open follow the profile once the daemon keeps it; a choice this
   * window made before that is carried into it once, so nothing you set is lost.
   */
  private adoptBehaviour(state: InterfaceState | null): void {
    const writable = state !== null && this.api !== null;
    const behaviour = state?.profile.behaviour ?? {};
    adoptFocusMode(behaviour.focus_mode, writable ? (value) => void this.writeBehaviour({ focus_mode: value }) : null);
    openPlacements.adopt(behaviour.open_placement, writable ? (changes) => void this.writeBehaviour({ open_placement: changes }) : null);
    if (!writable || this.seeded) return;
    this.seeded = true;
    const seed: NonNullable<InterfacePatch["behaviour"]> = {};
    if (behaviour.focus_mode === undefined && localFocusMode()) seed.focus_mode = true;
    const placements = openPlacements.localChanges;
    if (behaviour.open_placement === undefined && this.surface === "desktop" && Object.keys(placements).length > 0) seed.open_placement = placements;
    if (Object.keys(seed).length > 0) void this.writeBehaviour(seed, "carried over from this window's own settings");
  }

  private seeded = false;

  /** What the daemon holds now; applied at once. */
  sync(state: InterfaceState | null): void {
    this.adoptBehaviour(state);
    const same = this.state !== null && state !== null && this.state.revision_id === state.revision_id
      && JSON.stringify(this.state.profile) === JSON.stringify(state.profile);
    this.state = state;
    if (same) return;
    // A new profile gets its own chance at the floor.
    if (this.pausedBy === "floor") {
      this.pausedBy = null;
      this.floorFailed = [];
    }
    if (this.trying && state?.recent.some((head) => head.approval_id === this.trying!.approvalId)) this.trying = null;
    this.apply();
  }

  /** Back to your interface in this window, from a key, a floor or (not from the address) a click. */
  resume(): void {
    if (this.pausedBy === null) return;
    this.pausedBy = null;
    this.floorFailed = [];
    this.apply();
    this.notices.resumed?.();
  }

  /** Try a card's change in this window until it is decided (or you stop). */
  tryPatch(approvalId: string, patch: InterfacePatch): boolean {
    try {
      this.trying = { approvalId, profile: applyInterfacePatch(this.state?.profile ?? emptyInterfaceProfile(), patch) };
    } catch {
      return false;
    }
    this.apply();
    return true;
  }

  tryProfile(approvalId: string, profile: InterfaceProfile): void {
    this.trying = { approvalId, profile };
    this.apply();
  }

  stopTrying(): void {
    if (!this.trying) return;
    this.trying = null;
    this.apply();
  }

  /** Puts the profile in force on the page, then checks the floor and reports once things settle. */
  apply(): void {
    if (typeof document === "undefined") return;
    const css = interfaceCss(this.profile);
    applyInterfaceCss(css, this.lookOn, document);
    applyMotion(this.behaviour.motion, document);
    setInterfaceBehaviour(this.behaviour);
    // Only the daemon's is kept for the next start; a card being tried is not yours yet.
    if (!this.trying && this.state) cacheInterfaceCss(css);
    this.watchFloors(css !== "" && this.lookOn);
    this.schedule();
  }

  private schedule(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.checkFloors();
      void this.report();
    }, SETTLE_MS);
  }

  private watchFloors(on: boolean): void {
    if (!on || typeof MutationObserver === "undefined") {
      this.observer?.disconnect();
      this.observer = null;
      return;
    }
    if (this.observer) return;
    this.observer = new MutationObserver((records) => {
      const appeared = records.some((record) => Array.from(record.addedNodes).some((node) =>
        node instanceof Element && (node.matches(FLOOR_SELECTOR) || node.querySelector(FLOOR_SELECTOR) !== null)));
      if (!appeared) return;
      if (this.observeTimer) clearTimeout(this.observeTimer);
      this.observeTimer = setTimeout(() => {
        this.observeTimer = null;
        if (this.checkFloors()) void this.report();
      }, OBSERVE_DEBOUNCE_MS);
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  /** Drops the look in this window when it hides a floor; true when it did. */
  checkFloors(): boolean {
    if (typeof document === "undefined" || !this.lookOn) return false;
    const style = document.getElementById(INTERFACE_STYLE_ID) as HTMLStyleElement | null;
    if (!style) return false;
    const hidden = floorsHiddenByProfile((on) => {
      style.media = on ? "all" : "not all";
    });
    if (hidden.length === 0) return false;
    this.pausedBy = "floor";
    this.floorFailed = hidden;
    // A card being tried that hides a floor is not tried any longer.
    this.trying = null;
    this.apply();
    this.notices.floorFailed?.(hidden);
    return true;
  }

  /** What this window found, and on the desktop the catalog once per connection. */
  async report(): Promise<void> {
    const api = this.api;
    if (!api || !this.state || typeof document === "undefined") return;
    const profile = this.state.profile;
    const style = document.getElementById(INTERFACE_STYLE_ID) as HTMLStyleElement | null;
    const on = this.lookOn && !this.trying;
    const defaults = tokenDefaults(document);
    const report: Omit<InterfaceWindowReport, "at"> = {
      surface: this.surface,
      app_version: this.appVersion,
      revision_id: this.state.revision_id,
      applied: on,
      unmatched: on && profile.css.trim() ? unmatchedSelectors(style?.sheet ?? null, document) : [],
      dropped: profile.css.trim() ? droppedBlocks(profile.css) ?? 0 : 0,
      bad_tokens: badTokens(profile, new Map([...defaults.dark, ...defaults.light])),
      floor_failed: this.pausedBy === "floor" ? this.floorFailed : [],
    };
    const withCatalog = this.surface === "desktop" && !this.catalogSent;
    try {
      await api.reportInterfaceWindow(withCatalog ? { report, catalog: interfaceCatalog(this.appVersion, document) } : { report });
      if (withCatalog) this.catalogSent = true;
    } catch {
      // The next change reports again.
    }
  }

  /** A behaviour changed here (a switch, the placement card): into the profile, for every window. */
  async writeBehaviour(behaviour: InterfacePatch["behaviour"], reason?: string): Promise<boolean> {
    if (!this.api || !this.state) return false;
    try {
      await this.api.patchInterface({ patch: { behaviour }, ...(reason ? { reason } : {}) });
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the daemon keeps behaviour (ADR 0106) and this window can write it there. */
  get keepsBehaviour(): boolean {
    return this.api !== null && this.state !== null;
  }
}

export const interfaceController = new InterfaceController();

export { interfaceBehaviour } from "./behaviour.svelte.ts";
