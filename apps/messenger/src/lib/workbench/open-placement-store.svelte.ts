/**
 * The open placements this window uses, as one shared value: the settings write it, the workbench
 * reads it at the moment something opens, so a change applies to the next thing opened.
 */
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

class OpenPlacementStore {
  current = $state<OpenPlacements>(loadOpenPlacements());

  get(kind: OpenKind): OpenPlacement {
    return this.current[kind];
  }

  set(kind: OpenKind, placement: OpenPlacement): void {
    if (this.current[kind] === placement) return;
    this.current = { ...this.current, [kind]: placement };
    saveOpenPlacements(this.current);
  }

  isDefault(kind: OpenKind): boolean {
    return this.current[kind] === OPEN_PLACEMENT_DEFAULTS[kind];
  }

  /** Whether anything differs from the defaults, so "back to defaults" has something to do. */
  get changed(): boolean {
    return OPEN_KINDS.some((kind) => !this.isDefault(kind));
  }

  /** Back to how a new install opens things: the choices, and where floats were last left. */
  reset(): void {
    this.current = { ...OPEN_PLACEMENT_DEFAULTS };
    saveOpenPlacements(this.current);
    forgetFloatFrames();
  }

  /** Read storage again: for tests, which change it under the store. */
  reload(): void {
    this.current = loadOpenPlacements();
  }
}

export const openPlacements = new OpenPlacementStore();
