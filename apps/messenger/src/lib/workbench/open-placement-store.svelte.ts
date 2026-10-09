/**
 * The open placements this window uses, as one shared value: the settings write it, the workbench
 * reads it at the moment something opens, so a change applies to the next thing opened.
 */
import {
  OPEN_KINDS,
  OPEN_PLACEMENT_DEFAULTS,
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

  reset(): void {
    this.current = { ...OPEN_PLACEMENT_DEFAULTS };
    saveOpenPlacements(this.current);
  }

  /** Read storage again: for tests, which change it under the store. */
  reload(): void {
    this.current = loadOpenPlacements();
  }
}

export const openPlacements = new OpenPlacementStore();
