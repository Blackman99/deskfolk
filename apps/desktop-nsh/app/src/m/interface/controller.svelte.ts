// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: 2144ae82cd15b3f8
import { state } from "../../lib/reactive";
/**
 * This window's side of your interface profile (ADR 0106): applies what the daemon holds, keeps the
 * floor (Stop, cards waiting on you, the way to Settings) on screen by dropping the token and CSS
 * layers where they would hide it, offers two ways back no stylesheet can take away (`?ui=default`
 * and a key), and tells the daemon what it found so a Bot can tell what took.
 *
 * One per window. `Shell` starts it and feeds it each snapshot; the behaviour readers
 * (`interfaceBehaviour`) and the settings read it.
 *
 * What differs from the Svelte (ADR 0108): this controller touches no page. NSH has no DOM on the
 * desktops, and on the web it runs on NSH's own page, where the original's `<style>`, root
 * attributes, `MutationObserver`s, window `keydown` and catalog read off the stylesheets would
 * change and report NSH's page instead of the app. Everything the original did to the document
 * comes from an `InterfaceLook` the platform hands to `start()`: painting the profile (NSH: the
 * theme's tokens), measuring the floors (NSH: the contrast of each `floor()` against its grounds),
 * the way-back key, the kind of window, and (milestone 2) the report and the catalog. Without one
 * nothing is painted or reported, and the behaviour still applies. The floor check is asynchronous
 * (views are measured), so a profile applied meanwhile wins over a stale answer. Code colours and
 * the stylesheet cache are the look's to do (none in milestone 1); glass content reads the
 * behaviour in `ui/glass.ts`.
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
import { defaultAskedInUrl } from "./apply.ts";
import type { FloorFailure } from "./floor.ts";
import { setInterfaceBehaviour } from "./behaviour.svelte.ts";

export type InterfaceApi = {
  patchInterface(body: { patch: InterfacePatch; reason?: string }): Promise<unknown>;
  reportInterfaceWindow(body: { report: Omit<InterfaceWindowReport, "at">; catalog?: InterfaceCatalog }): Promise<void>;
};

export type PausedBy = "url" | "key" | "floor";

/** What the platform does for the controller where the original used the document (ADR 0108). */
export type InterfaceLook = {
  /** Puts the profile's look in force (`on`), or the app's own (`on` false). */
  paint(profile: InterfaceProfile, on: boolean): void;
  /** The floors the look in force hides that the app's own does not; empty when none. */
  floorsHidden(): Promise<FloorFailure[]>;
  /**
   * Starts listening: `escape` on the way-back key, `floors` when a floor appears or the look
   * changes under one, `surface` with the kind of window now and on every change. Returns the stop.
   */
  start(hooks: { escape: () => void; floors: () => void; surface: (surface: InterfaceSurface) => void }): () => void;
  /** What this window found for the daemon beside the floors; absent: nothing is reported. */
  found?(profile: InterfaceProfile, on: boolean): Pick<InterfaceWindowReport, "unmatched" | "dropped" | "bad_tokens">;
  /** What the app has for a Bot to look things up in, sent once per connection by a desktop window. */
  catalog?(appVersion: string | null): InterfaceCatalog;
};

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
  #state$s = state<InterfaceState | null>(null);
	get state(): InterfaceState | null { return this.#state$s.get(); }
	set state(value: InterfaceState | null) { this.#state$s.set(value); }
  /** Why this window shows the app's own look now; null when it shows yours. */
  #pausedBy$s = state<PausedBy | null>(defaultAskedInUrl() ? "url" : null);
	get pausedBy(): PausedBy | null { return this.#pausedBy$s.get(); }
	set pausedBy(value: PausedBy | null) { this.#pausedBy$s.set(value); }
  /** The floors your profile hid in this window, when that is why it paused. */
  #floorFailed$s = state<FloorFailure[]>([]);
	get floorFailed(): FloorFailure[] { return this.#floorFailed$s.get(); }
	set floorFailed(value: FloorFailure[]) { this.#floorFailed$s.set(value); }
  /** A Bot's change you are trying here before you allow it (its card's 试看). */
  #trying$s = state<{ approvalId: string; profile: InterfaceProfile } | null>(null);
	get trying(): { approvalId: string; profile: InterfaceProfile } | null { return this.#trying$s.get(); }
	set trying(value: { approvalId: string; profile: InterfaceProfile } | null) { this.#trying$s.set(value); }
  #surface$s = state<InterfaceSurface>("desktop");
	get surface(): InterfaceSurface { return this.#surface$s.get(); }
	set surface(value: InterfaceSurface) { this.#surface$s.set(value); }

  private api: InterfaceApi | null = null;
  private appVersion: string | null = null;
  private notices: InterfaceNotices = {};
  private look: InterfaceLook | null = null;
  private catalogSent = false;
  private started = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private observeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Counts the applies: a floor check begun before the latest one answers about a look gone by. */
  private applied = 0;
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

  start(options: { api: InterfaceApi | null; notices?: InterfaceNotices; look?: InterfaceLook | null }): () => void {
    this.api = options.api;
    this.notices = options.notices ?? {};
    this.catalogSent = false;
    if (this.started) return () => this.stop();
    this.started = true;
    this.look = options.look ?? null;
    if (this.look) {
      this.stops.push(this.look.start({
        escape: () => {
          if (this.pausedBy === null) {
            this.pausedBy = "key";
            this.apply();
            this.notices.paused?.();
          } else {
            this.resume();
          }
        },
        floors: () => this.floorsMayHaveMoved(),
        surface: (surface) => {
          this.surface = surface;
        },
      }));
    }
    // A sync before the look was handed in set the behaviour but painted nothing.
    this.apply();
    return () => this.stop();
  }

  /** A new connection: the api to report through, and the catalog to send again. */
  connect(api: InterfaceApi | null): void {
    if (api !== this.api) this.catalogSent = false;
    this.api = api;
  }

  private stop(): void {
    for (const stop of this.stops.splice(0)) stop();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.observeTimer) clearTimeout(this.observeTimer);
    this.look = null;
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

  /** Puts the profile in force through the look, then checks the floor and reports once things settle. */
  apply(): void {
    this.applied += 1;
    setInterfaceBehaviour(this.behaviour);
    if (!this.look) return;
    this.look.paint(this.profile, this.lookOn);
    this.schedule();
  }

  private schedule(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.checkFloors().then(() => this.report());
    }, SETTLE_MS);
  }

  /** A floor appeared, or the look changed under one: checked once things settle. */
  private floorsMayHaveMoved(): void {
    if (!this.lookOn) return;
    if (this.observeTimer) clearTimeout(this.observeTimer);
    this.observeTimer = setTimeout(() => {
      this.observeTimer = null;
      void this.checkFloors().then((dropped) => {
        if (dropped) void this.report();
      });
    }, OBSERVE_DEBOUNCE_MS);
  }

  /** Drops the look in this window when it hides a floor; true when it did. */
  async checkFloors(): Promise<boolean> {
    const look = this.look;
    if (!look || !this.lookOn) return false;
    const at = this.applied;
    const hidden = await look.floorsHidden();
    // Another profile, the key or a stop came meanwhile: the answer is about a look no longer in force.
    if (hidden.length === 0 || at !== this.applied || !this.lookOn) return false;
    this.pausedBy = "floor";
    this.floorFailed = hidden;
    // A card being tried that hides a floor is not tried any longer.
    this.trying = null;
    this.apply();
    this.notices.floorFailed?.(hidden);
    return true;
  }

  /** What this window found, and on the desktop the catalog once per connection, when the look tells them. */
  async report(): Promise<void> {
    const api = this.api;
    const look = this.look;
    if (!api || !this.state || !look?.found) return;
    const on = this.lookOn && !this.trying;
    const report: Omit<InterfaceWindowReport, "at"> = {
      surface: this.surface,
      app_version: this.appVersion,
      revision_id: this.state.revision_id,
      applied: on,
      ...look.found(this.state.profile, on),
      floor_failed: this.pausedBy === "floor" ? this.floorFailed : [],
    };
    const catalog = this.surface === "desktop" && !this.catalogSent ? look.catalog?.(this.appVersion) : undefined;
    try {
      await api.reportInterfaceWindow(catalog ? { report, catalog } : { report });
      if (catalog) this.catalogSent = true;
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
