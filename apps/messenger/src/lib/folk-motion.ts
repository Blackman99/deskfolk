import type { SessionStateKind } from "./sidebar/session-status.ts";

/** What a folk avatar acts out, one per kind of status the app shows for a Bot. */
export type FolkMotion = "idle" | "running" | "replying" | "waiting" | "failed" | "held";

/**
 * Thinking sways, replying types and talks, waiting on you hops and waves, a failed or interrupted
 * turn slumps with a drop of sweat, and idle only blinks. A stop shows no state of its own (ADR
 * 0081): a stopped Bot is idle until you speak to it.
 */
export function folkMotion(kind: SessionStateKind | undefined): FolkMotion {
  switch (kind) {
    case "running":
      return "running";
    case "replying":
      return "replying";
    case "waiting_approval":
    case "waiting_ask":
      return "waiting";
    case "failed":
    case "interrupted":
      return "failed";
    default:
      return "idle";
  }
}
