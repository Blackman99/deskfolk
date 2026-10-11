import { persistedWidth } from "../storage.ts";

/**
 * A job's one tab (ADR 0086) lays out by its own width: below this the rail, the trace and the
 * inspector are one at a time behind a switch, and a pick comes up as a sheet.
 */
export const JOB_NARROW_BELOW = 900;

/** The tickets' rail, beside the trace: kept per browser, never more than a third of the tab. */
export function jobRailWidth() {
  return persistedWidth({ key: "real-bot-job-rail-width", min: 200, default: 272, max: 440, ratio: 0.34 });
}

/** The inspector, beside the trace: kept per browser, never more than about half the tab. */
export function jobInspectorWidth() {
  return persistedWidth({ key: "real-bot-job-inspector-width", min: 300, default: 380, max: 680, ratio: 0.46 });
}
