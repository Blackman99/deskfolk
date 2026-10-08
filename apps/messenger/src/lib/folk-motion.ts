import type { SessionStateKind } from "./sidebar/session-status.ts";

/** What a folk avatar acts out, one per kind of status the app shows for a Bot. */
export type FolkMotion = "idle" | "running" | "replying" | "waiting" | "failed" | "held";

/**
 * Thinking sways, replying types and talks, waiting on you hops and waves, a failed or interrupted
 * turn slumps with a drop of sweat, a stop of yours puts it to sleep, and idle only blinks.
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
    case "held":
      return "held";
    default:
      return "idle";
  }
}
