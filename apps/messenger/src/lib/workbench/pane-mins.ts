/**
 * The smallest each kind of content stays usable at.
 *
 * Pixels, not fractions: a terminal column and the composer plus one bubble are real sizes that
 * do not scale with the window. Where a number matches one the app already uses, it is that
 * number rather than a second opinion about the same thing.
 */
import type { MinSizeLookup, PaneMin, WorkbenchTab } from "./layout-types.ts";

/** The tab strip above every pane's body, added to each height below. */
export const WB_STRIP_PX = 28;

export const PANE_MINS = {
  /**
   * Composer plus one bubble. Narrower than `--chat-max-width`, which is a ceiling, not a floor.
   * Not widened for the settings or the model-choice log: they slide over the transcript, so
   * opening one never shoves the neighbouring panes.
   */
  chat: { width: 360, height: 240 },
  /** Matches `PREVIEW_MIN` in overlays/preview-width.ts — the same panel, a different host. */
  preview: { width: 280, height: 240 },
  /** What the board needs before its cards stop making sense. */
  trace: { width: 300, height: 280 },
  /** Narrow enough to sit in a split column; the shell follows the pane via FitAddon. */
  terminal: { width: 200, height: 200 },
  workspace: { width: 260, height: 200 },
  /** Seven day columns; the `routine-card` story is shot at 520 wide for the same reason. */
  routines: { width: 520, height: 420 },
  spend: { width: 280, height: 220 },
} as const satisfies Record<string, PaneMin>;

export type PaneKind = keyof typeof PANE_MINS;

/** An unknown kind still has to fit somewhere, so it gets a floor rather than zero. */
export const WB_FALLBACK_MIN: PaneMin = { width: 240, height: 160 };

/**
 * A pane's minimum is its **active** tab's, not the largest of its tabs'.
 *
 * Taking the largest would mean adding a routines tab to a chat pane shoves every other pane
 * sideways, which is astonishing. Taking the active one means clicking a tab can leave it
 * cramped, which is merely annoying and explains itself.
 */
export const paneMin: MinSizeLookup = (tab: WorkbenchTab | null): PaneMin => {
  if (!tab) return WB_FALLBACK_MIN;
  const known = (PANE_MINS as Record<string, PaneMin | undefined>)[tab.kind];
  const base = known ?? WB_FALLBACK_MIN;
  return { width: base.width, height: base.height + WB_STRIP_PX };
};
