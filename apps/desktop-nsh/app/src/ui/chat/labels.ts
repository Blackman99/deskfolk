/** The words and colours the chat headers and chips share: roster and status labels from the copy, status inks. */
import { createMotion, effect, reduceMotion, token, type Motion } from "nsh";
import type { StatusLabels } from "../../m/sidebar/session-status";
import type { RosterLabels } from "../../m/sidebar/session-title";
import type { Copy } from "../../m/copy";

export function rosterLabelsOf(t: Copy): RosterLabels {
  return { deleted: t.top.deleted, archived: t.top.archived, fileDrop: t.sidebar.fileDrop, projectUntitled: t.project.untitled };
}

export function statusLabelsOf(t: Copy): StatusLabels {
  return {
    running: t.sidebar.statusRunning,
    replying: t.sidebar.statusReplying,
    waitingApproval: t.sidebar.statusWaitingApproval,
    waitingAsk: t.sidebar.statusWaitingAsk,
    failed: t.sidebar.statusFailed,
    interrupted: t.sidebar.statusInterrupted,
    idle: t.sidebar.statusIdle,
  };
}

/** A status kind's text colour: working is the accent, waiting on your approval warn, on your answer purple, a failure red. */
export function statusInk(kind: string): string {
  switch (kind) {
    case "running":
    case "replying":
      return "text-brand";
    case "waiting_approval":
      return "text-warn-text";
    case "waiting_ask":
      return "text-purple-text";
    case "failed":
    case "interrupted":
      return "text-danger-text";
    default:
      return "text-ink-muted";
  }
}

/** A status kind's fill, for the dots drawn beside its words. */
export function statusFill(kind: string): string {
  switch (kind) {
    case "waiting_approval":
      return "bg-warn-text";
    case "waiting_ask":
      return "bg-purple-text";
    case "failed":
    case "interrupted":
      return "bg-danger-text";
    default:
      return "bg-brand";
  }
}

/** The dot's colour for a status kind (the avatar's dot: idle is green, but idle shows no dot). */
export function statusColor(kind: string): string {
  switch (kind) {
    case "running":
    case "replying":
      return token("brand");
    case "waiting_approval":
      return token("warn");
    case "waiting_ask":
      return token("purple");
    case "failed":
    case "interrupted":
      return token("danger");
    default:
      return token("ok");
  }
}

/** A motion that breathes (opacity 1 to `low` and back) while `on()` holds; still with reduced motion. */
export function pulseMotion(on: () => boolean, duration = 1800, low = 0.35): Motion {
  const m = createMotion();
  effect(() => {
    if (on() && !reduceMotion()) void m.play({ duration, iterations: "infinite", direction: "alternate", keyframes: { opacity: [1, low] } });
    else m.reset();
  });
  return m;
}

/** A card's entrance: fades in, rising 3 points, once (`replyingFadeIn`). */
export function enterMotion(): Motion {
  const m = createMotion();
  if (!reduceMotion()) void m.play({ duration: 200, keyframes: { opacity: [0, 1], translateY: [3, 0] } });
  return m;
}
