import { expect, test } from "bun:test";
import { jobStatusOf } from "../src/engine/job-adapter";
import { checkArgs } from "./demo-tape-keys";
import { checkState, stillGoing, Turnstile, type Slot } from "./demo-tape-order";

/** A turnstile on a hand-driven clock: `sleep` moves time on instead of waiting. */
function rig(order: Slot[], patience = 60_000) {
  let clock = 0;
  const lines: string[] = [];
  const next: string[] = [];
  const turnstile = new Turnstile(order, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await Promise.resolve();
    },
    log: (line) => lines.push(line),
    onNext: (slot) => next.push(`${slot.queue} #${slot.index}`),
    patience: () => patience,
  });
  return { turnstile, lines, next, advance: (ms: number) => (clock += ms) };
}

const P = "model:turn:制片";
const R = "model:turn:审片";
const DONE = "mcp:call:check_video:593c";

test("answers go out in the order the shoot recorded them, across Bots and a render's end", async () => {
  const { turnstile, next } = rig([
    { queue: P, index: 0 },
    { queue: DONE, index: 0 },
    { queue: P, index: 1 },
    { queue: R, index: 0 },
    { queue: P, index: 2 },
  ]);
  expect(turnstile.due(P, 0)).toBe(true);
  expect(turnstile.due(P, 1)).toBe(false);
  turnstile.served(P, 0);
  // The render's end is next: whoever is told it comes up asks the app to poll.
  expect(next.at(-1)).toBe(`${DONE} #0`);
  expect(turnstile.due(DONE, 0)).toBe(true);
  expect(turnstile.due(P, 1)).toBe(false);
  turnstile.served(DONE, 0);
  turnstile.served(P, 1);
  // The Producer's third answer waits for the Reviewer's first, as in the shoot.
  let passed = false;
  const waiting = turnstile.wait(P, 2).then((ok) => (passed = ok));
  await Promise.resolve();
  expect(passed).toBe(false);
  turnstile.served(R, 0);
  await waiting;
  expect(passed).toBe(true);
  // Entries outside the order (side calls, a render's "still going") never wait.
  expect(turnstile.due("model:read_user:abc", 0)).toBe(true);
});

test("an entry that never comes holds the rest up only for its patience, then is skipped and logged", async () => {
  const { turnstile, lines } = rig([
    { queue: R, index: 0 },
    { queue: P, index: 0 },
  ], 1_000);
  expect(await turnstile.wait(P, 0)).toBe(true);
  expect(lines.some((line) => line.startsWith(`SKIP ${R} #0`))).toBe(true);
  expect(turnstile.skipped).toEqual([`${R} #0`]);
  // If it comes after all, it goes out at once: it no longer holds anything up.
  expect(turnstile.due(R, 0)).toBe(true);
});

test("an abandoned request's entry is next in line again, and a waiter gives up with its request", async () => {
  const { turnstile } = rig([
    { queue: P, index: 0 },
    { queue: R, index: 0 },
  ]);
  turnstile.served(P, 0);
  expect(turnstile.due(R, 0)).toBe(true);
  turnstile.unserved(P, 0);
  expect(turnstile.due(R, 0)).toBe(false);
  const abort = new AbortController();
  abort.abort();
  expect(await turnstile.wait(R, 0, abort.signal)).toBe(false);
  expect(turnstile.remaining()).toEqual([`${P} #0`, `${R} #0`]);
});

test("the entry next in line is nudged again while it stands there", () => {
  const { turnstile, next, advance } = rig([{ queue: DONE, index: 0 }]);
  expect(next).toEqual([`${DONE} #0`]);
  advance(5_000);
  turnstile.tick();
  expect(next.length).toBe(1);
  advance(20_000);
  turnstile.tick();
  expect(next.length).toBe(2);
});

/** grok-imagine's recorded answers to check_video, as the shoot's tape holds them. */
const lines = (text: string) => ({ jsonrpc: "2.0", id: 31, result: { content: [{ type: "text", text }], structuredContent: { result: text }, isError: false } });
const PENDING = lines("status: pending\nprogress: 40\nrequest_id: 99d4 (poll check_video again)");
const ENDED = lines("status: done\nurl: https://vidgen.x.ai/xai-video-593c.mp4\nduration_s: 6\n(url is TEMPORARY — fetch promptly)");

test("a check's recorded answer is read the way the daemon reads it", () => {
  expect(checkState(PENDING)).toBe("pending");
  expect(checkState(ENDED)).toBe("ended");
  expect(checkState(lines(JSON.stringify({ status: "failed", error: "nsfw" })))).toBe("ended");
  expect(checkState({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "down" } })).toBe("pending");
});

test("a check asked before its end is due hears 'still going', in the job's own words or its server's format", () => {
  const check = checkArgs({ method: "tools/call", params: { name: "check_video", arguments: { request_id: "593c" } } })!;
  expect(check).toEqual({ tool: "check_video", param: "request_id", id: "593c" });
  // The job's own last "still going", when the shoot heard one.
  expect(stillGoing(ENDED, PENDING, check)).toBe(PENDING);
  // None recorded (the shoot's first poll found it done): written the way its end was.
  const written = stillGoing(ENDED, undefined, check);
  expect(written.result.content[0].text).toBe("status: pending\nrequest_id: 593c (poll check_video again)");
  expect(jobStatusOf(written.result).state).toBe("pending");
  const json = stillGoing(lines(JSON.stringify({ job_id: "j1", status: "succeeded", url: "https://x/y.mp4" })), undefined, { tool: "check_render", param: "job_id", id: "j1" });
  expect(JSON.parse(json.result.content[0].text)).toEqual({ job_id: "j1", status: "pending" });
  expect(jobStatusOf(json.result).state).toBe("pending");
});

test("another Bot's answer keeps a gap after the one before it went out; the same Bot's does not", async () => {
  let clock = 0;
  const order = [
    { queue: P, index: 0 },
    { queue: R, index: 0 },
    { queue: R, index: 1 },
  ];
  const turnstile = new Turnstile(order, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await Promise.resolve();
    },
    gap: (previous, next) => (previous.queue !== next.queue ? 2000 : 0),
  });
  turnstile.served(P, 0);
  const from = clock;
  expect(await turnstile.wait(R, 0)).toBe(true);
  expect(clock - from).toBeGreaterThanOrEqual(2000);
  turnstile.served(R, 0);
  const again = clock;
  expect(await turnstile.wait(R, 1)).toBe(true);
  expect(clock).toBe(again);
});
