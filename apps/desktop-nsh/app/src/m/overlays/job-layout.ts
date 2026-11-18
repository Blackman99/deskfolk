import { persistedWidth } from "../storage.ts";

/**
 * A job's one tab (ADR 0086) lays out by its own width, in three ways. Narrow (a phone): the rail,
 * the trace and the inspector one at a time behind a switch, a pick as a sheet. Medium (a pane beside
 * a conversation, a tablet upright): the rail and the trace side by side, the inspector over the
 * trace's right edge while something is picked or the spec is asked for. Wide: all three across.
 */
/** A phone is at most about 430px; a pane beside a conversation on a laptop is rarely under 560. */
export const JOB_NARROW_BELOW = 520;
export const JOB_WIDE_FROM = 1080;

export type JobLayoutMode = "narrow" | "medium" | "wide";

/** How a job lays out at this width; before it is measured (0), a page is narrow and a pane is wide. */
export function jobLayoutMode(width: number, host: "pane" | "page"): JobLayoutMode {
  if (width <= 0) return host === "page" ? "narrow" : "wide";
  if (width < JOB_NARROW_BELOW) return "narrow";
  return width < JOB_WIDE_FROM ? "medium" : "wide";
}

/** The tickets' rail, beside the trace: kept per browser, never more than a third of the tab. */
export function jobRailWidth() {
  return persistedWidth({ key: "real-bot-job-rail-width", min: 200, default: 272, max: 440, ratio: 0.34 });
}

/** The inspector, beside the trace: kept per browser, never more than about half the tab. */
export function jobInspectorWidth() {
  return persistedWidth({ key: "real-bot-job-inspector-width", min: 300, default: 380, max: 680, ratio: 0.46 });
}
