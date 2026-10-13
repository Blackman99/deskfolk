import { expect, test } from "bun:test";
import { ArrivalTracker } from "./arrivals.ts";
import { ReadMark } from "./read-mark.ts";
import { waitingCards } from "./waiting.ts";
import type { TranscriptItem } from "./transcript.ts";
import { aMessage, aTurn, anApproval } from "../test-fixtures.ts";

const msg = (id: string, at: string, over: Parameters<typeof aMessage>[0] = {}): TranscriptItem => ({
  type: "message",
  message: aMessage({ id, created_at: `2026-09-19T02:00:${at}.000Z`, ...over }),
});

function manualClock() {
  const due: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => void due.push(fn),
    runAll: () => due.splice(0).forEach((fn) => fn()),
  };
}

test("a conversation's history never animates, only what comes in afterwards", () => {
  const clock = manualClock();
  const tracker = new ArrivalTracker(clock.schedule);
  const history = [msg("a", "01"), msg("b", "02")];
  expect([...tracker.observe("s1", history)]).toEqual([]);
  const next = [...history, msg("c", "03")];
  expect([...tracker.observe("s1", next)]).toEqual(["c"]);
  // Asked again before the animation is over, the answer holds.
  expect([...tracker.observe("s1", next)]).toEqual(["c"]);
  clock.runAll();
  expect([...tracker.observe("s1", next)]).toEqual([]);
});

test("earlier messages brought in above do not animate", () => {
  const tracker = new ArrivalTracker(() => {});
  tracker.observe("s1", [msg("b", "05"), msg("c", "06")]);
  expect([...tracker.observe("s1", [msg("a", "01"), msg("b", "05"), msg("c", "06")])]).toEqual([]);
});

test("switching conversations sets a new baseline instead of animating it", () => {
  const tracker = new ArrivalTracker(() => {});
  tracker.observe("s1", [msg("a", "01")]);
  expect([...tracker.observe("s2", [msg("x", "01"), msg("y", "02")])]).toEqual([]);
});

test("a reply that replaces its working bubble does not rise again", () => {
  const tracker = new ArrivalTracker(() => {});
  tracker.observe("s1", [msg("a", "01")]);
  const working: TranscriptItem = { type: "streaming", turn: aTurn({ id: "t1" }) };
  expect([...tracker.observe("s1", [msg("a", "01"), working])]).toEqual(["t1"]);
  const reply = msg("r", "09", { kind: "bot", author: "bot-1", turn_id: "t1" });
  expect([...tracker.observe("s1", [msg("a", "01"), reply])]).not.toContain("r");
});

test("the New line goes above the first message someone else sent after your last read", () => {
  const mark = new ReadMark();
  const items = [
    msg("a", "01"),
    msg("b", "05", { kind: "bot", author: "bot-1" }),
    msg("c", "06", { kind: "bot", author: "bot-1" }),
  ];
  expect(mark.observe("s1", "2026-09-19T02:00:03.000Z", items)).toBe("b");
  // Later reads of the same opening keep it where it was.
  expect(mark.observe("s1", "2026-09-19T02:00:09.000Z", items)).toBe("b");
});

test("nothing unread when opened means no New line, even as replies come in", () => {
  const mark = new ReadMark();
  expect(mark.observe("s1", "2026-09-19T02:00:09.000Z", [msg("a", "01")])).toBeNull();
  expect(
    mark.observe("s1", "2026-09-19T02:00:09.000Z", [msg("a", "01"), msg("b", "10", { kind: "bot", author: "bot-1" })]),
  ).toBeNull();
});

test("a conversation never read draws no New line", () => {
  const mark = new ReadMark();
  expect(mark.observe("s1", null, [msg("b", "05", { kind: "bot", author: "bot-1" })])).toBeNull();
});

test("only approvals and questions still waiting are listed for the jump chip", () => {
  const items = [
    msg("ap", "01", { kind: "approval", author: "bot-1", turn_id: "turn-1" }),
    msg("done", "02", { kind: "approval", author: "bot-1", turn_id: "turn-1" }),
    msg("q", "03", { kind: "ask", author: "bot-1", turn_id: "turn-2", ask: { options: [] } as never }),
  ];
  const approvals = [
    anApproval({ id: "a1", message_id: "ap", status: "pending" }),
    anApproval({ id: "a2", message_id: "done", status: "allowed_once" }),
  ];
  const turns = [aTurn({ id: "turn-2", status: "waiting_ask" })];
  const waiting = waitingCards(items, approvals, turns, false);
  expect(waiting.find((w) => w.id === "ap")).toEqual({ id: "ap", kind: "approval" });
  expect(waiting.find((w) => w.id === "done")).toBeUndefined();
});
