import type { Copy } from "../copy.ts";
import { verbOf } from "./frame.ts";
import { modelLabel } from "./model-label.ts";
import type { Moment } from "./timeline.ts";

type T = Copy["taskmap"];

/** A moment's dot on the timeline and its card: amber for loops and long calls, red for failures and refusals. */
export const MOMENT_COLOR: Readonly<Record<Moment["kind"], string>> = {
  spawn: "#7d4fa3", ask: "#146a7c", say: "#146a7c", idle: "#95a2a8", reject: "#dc2626", approve: "#16a34a", fail: "#dc2626", long: "#d97706", loop: "#d97706",
};

export type MomentText = { title: string; sub: string; color: string };

/** How long, in the copy's words; under a minute counts as quick. */
function waitText(ms: number, t: T): string {
  const min = ms / 60000;
  if (min < 1) return "";
  return min >= 90 ? t.hours(Math.round(min / 60)) : t.minutes(Math.round(min));
}

/**
 * A moment in words. `who` names a character, `place` a district, `when` a clock time, and
 * `sentTo` what a subagent was sent to do (its name when nothing says); the words describe what
 * happened, not whether it was good.
 */
export function momentText(m: Moment, t: T, who: (b: number) => string, place: (q: number) => string, when: (at: number) => string, sentTo: (b: number) => string = who): MomentText {
  const color = MOMENT_COLOR[m.kind];
  switch (m.kind) {
    case "spawn":
      return { title: t.moments.spawn(sentTo(m.who), waitText(m.to - m.from, t) || t.minutes(1), m.steps, place(m.places[0] ?? 0)), sub: `${who(m.who)} · ${when(m.from)}–${when(m.to)}${m.model ? ` · ${modelLabel(m.model)}` : ""}`, color };
    case "ask":
      return { title: t.moments.ask(waitText(m.waitMs, t)), sub: `${when(m.askedAt)} · ${m.answers.join("；").slice(0, 80)}`, color };
    case "say":
      return { title: t.moments.say, sub: `${when(m.at)} · ${m.text.slice(0, 80)}`, color };
    case "idle":
      return { title: t.moments.idle(waitText(m.t1 - m.t0, t), m.waitingForYou), sub: `${when(m.t0)} → ${when(m.t1)}`, color };
    case "reject":
      return { title: t.moments.reject(t.moments.rejectBy[m.source ?? ""] ?? t.moments.rejectBy.hook!), sub: `${when(m.at)} · ${place(m.places[0] ?? 0)} · ${who(m.who)}`, color };
    case "approve":
      return { title: t.moments.approve, sub: `${when(m.at)} · ${place(m.places[0] ?? 0)} · ${who(m.who)}`, color };
    case "fail":
      return { title: t.moments.fail(m.count), sub: m.byWho.map(([b, n]) => `${who(b)} ${n}`).join(" · "), color };
    case "long":
      return { title: t.moments.long(verbOf({ tool: m.tool, ...(m.action ? { action: m.action } : {}), place: m.place }, t), Math.round(m.ms / 1000)), sub: `${who(m.who)} · ${place(m.places[0] ?? 0)}${m.file ? ` · ${m.file}` : ""}`, color };
    case "loop":
      return { title: t.moments.loop(Math.max(1, Math.round((m.to - m.from) / 60000)), place(m.places[0]), place(m.places[1]), m.trips), sub: `${when(m.from)}–${when(m.to)}`, color };
  }
}
