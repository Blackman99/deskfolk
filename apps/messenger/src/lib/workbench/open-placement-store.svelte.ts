/**
 * The open placements this window uses, as one shared value: the settings write it, the workbench
 * reads it at the moment something opens, so a change applies to the next thing opened. Since ADR
 * 0106 the choices are part of your interface profile, which every desktop window follows; this
 * machine's own are kept too, for a daemon that predates it.
 */
import type { InterfaceOpenKind, InterfaceOpenPlacement } from "@real-bot/protocol";
import {
  OPEN_KINDS,
  OPEN_PLACEMENT_DEFAULTS,
  forgetFloatFrames,
  loadOpenPlacements,
  saveOpenPlacements,
  type OpenKind,
  type OpenPlacement,
  type OpenPlacements,
} from "./open-placement.ts";

type Kept = Partial<Record<InterfaceOpenKind, InterfaceOpenPlacement>>;
type Writer = (changes: Partial<Record<OpenKind, OpenPlacement | null>>) => void;

class OpenPlacementStore {
  private local = $state<OpenPlacements>(loadOpenPlacements());
  /** The profile's choices; undefined where it says nothing, so this machine's apply. */
  private kept = $state<Kept | undefined>(undefined);
  private write: Writer | null = null;

  get current(): OpenPlacements {
    return this.kept ? { ...OPEN_PLACEMENT_DEFAULTS, ...this.kept } : this.local;
  }

  get(kind: OpenKind): OpenPlacement {
    return this.current[kind];
  }

  set(kind: OpenKind, placement: OpenPlacement): void {
    if (this.current[kind] === placement) return;
    this.local = { ...this.local, [kind]: placement };
    saveOpenPlacements(this.local);
    if (this.write) {
      const next: Kept = { ...(this.kept ?? {}) };
      if (placement === OPEN_PLACEMENT_DEFAULTS[kind]) delete next[kind];
      else next[kind] = placement;
      this.kept = next;
      this.write({ [kind]: placement === OPEN_PLACEMENT_DEFAULTS[kind] ? null : placement });
    }
  }

  isDefault(kind: OpenKind): boolean {
    return this.current[kind] === OPEN_PLACEMENT_DEFAULTS[kind];
  }

  /** Whether anything differs from the defaults, so "back to defaults" has something to do. */
  get changed(): boolean {
    return OPEN_KINDS.some((kind) => !this.isDefault(kind));
  }

  /** What differs from the defaults on this machine alone, for carrying it into the profile once. */
  get localChanges(): Kept {
    const out: Kept = {};
    for (const kind of OPEN_KINDS) if (this.local[kind] !== OPEN_PLACEMENT_DEFAULTS[kind]) out[kind] = this.local[kind];
    return out;
  }

  /** Back to how a new install opens things: the choices, and where floats were last left. */
  reset(): void {
    const changed = OPEN_KINDS.filter((kind) => !this.isDefault(kind));
    this.local = { ...OPEN_PLACEMENT_DEFAULTS };
    saveOpenPlacements(this.local);
    forgetFloatFrames();
    if (this.write && changed.length > 0) {
      this.kept = {};
      this.write(Object.fromEntries(changed.map((kind) => [kind, null])));
    }
  }

  /** What the interface profile says, and how to change it there; a null writer keeps them on this machine only. */
  adopt(kept: Kept | undefined, writer: Writer | null): void {
    this.kept = kept;
    this.write = writer;
  }

  /** Read storage again: for tests, which change it under the store. */
  reload(): void {
    this.local = loadOpenPlacements();
    this.kept = undefined;
    this.write = null;
  }
}

export const openPlacements = new OpenPlacementStore();
