/**
 * The time-point logic on its own: seconds → anchors, spans that order themselves and refuse what is
 * too short or past the end, where marks land on the timeline and in which lane, and the frame grab
 * a video crop is made of (against a stand-in element, since happy-dom has no media or canvas).
 */
import { expect, test } from "bun:test";
import { validateAnchor, type Annotation, type MediaTimeAnchor } from "@real-bot/protocol";
import {
  MAX_LANES,
  MIN_SPAN_MS,
  POINT_ROOM,
  captureFrame,
  drawnTimes,
  durationMs,
  extendTo,
  layoutTimeline,
  markTitle,
  percentOf,
  pointAt,
  pointRoom,
  secondsToMs,
  spanBetween,
  timeLabel,
  type FrameSource,
} from "./media-time.ts";
import type { EncodedCrop, PixelRect } from "./region-box.ts";

function row(id: string, anchor: MediaTimeAnchor, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    status: "open",
    relpath: "clips/demo.mp4",
    anchor_kind: "media_time",
    anchor,
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "s1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "s1",
    message_id: "m2",
    body: `remark ${id}`,
    crop_mime: null,
    resolved_by: null,
    resolved_note: null,
    resolved_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    stale: null,
    ...over,
  };
}

const valid = (anchor: MediaTimeAnchor) => validateAnchor("media_time", anchor).ok;

test("times read as mm:ss, grow an hour field past an hour, and floor to the second", () => {
  expect(timeLabel({ start_ms: 0 })).toBe("00:00");
  expect(timeLabel({ start_ms: 12_999 })).toBe("00:12");
  expect(timeLabel({ start_ms: 65_000, end_ms: 90_500 })).toBe("01:05–01:30");
  expect(timeLabel({ start_ms: 3_723_000 })).toBe("1:02:03");
  expect(timeLabel({ start_ms: 3_599_000, end_ms: 36_000_000 })).toBe("59:59–10:00:00");
  expect(timeLabel({ start_ms: 5_000, end_ms: null })).toBe("00:05");
  expect(markTitle({ n: 2, label: "00:12–00:30", stale: false, body: "太快了" }, "文件已变")).toBe("2 · 00:12–00:30\n太快了");
  expect(markTitle({ n: 3, label: "00:12", stale: true, body: "这里" }, "文件已变")).toBe("3 · 00:12 · 文件已变\n这里");
});

test("the element's seconds become whole milliseconds; an unknown duration is none at all", () => {
  expect(secondsToMs(12.3456)).toBe(12_346);
  expect(secondsToMs(Number.NaN)).toBe(0);
  expect(secondsToMs(-3)).toBe(0);
  expect(durationMs(120)).toBe(120_000);
  expect(durationMs(Number.NaN)).toBeNull();
  expect(durationMs(Number.POSITIVE_INFINITY)).toBeNull();
  expect(durationMs(0)).toBeNull();
  expect(durationMs(0.0001)).toBeNull();
});

test("「在此处批注」 is a point at the playback position, never past the end, and valid", () => {
  const point = pointAt(12.5, 120)!;
  expect(point).toEqual({ start_ms: 12_500, duration_ms: 120_000 });
  expect(valid(point)).toBe(true);
  // At the very end, and a position the element reports a hair past it.
  expect(pointAt(120, 120)).toEqual({ start_ms: 120_000, duration_ms: 120_000 });
  expect(pointAt(120.0004, 120)?.start_ms).toBe(120_000);
  expect(pointAt(0, 3.2)).toEqual({ start_ms: 0, duration_ms: 3_200 });
  expect(pointAt(4, Number.NaN)).toBeNull();
  expect(pointAt(4, Number.POSITIVE_INFINITY)).toBeNull();
});

test("a span runs from the earlier time to the later, whichever way the person went", () => {
  const forward = spanBetween(12_500, 40_000, 120_000);
  expect(forward).toEqual({ ok: true, anchor: { start_ms: 12_500, end_ms: 40_000, duration_ms: 120_000 } });
  // Seeking back before 「到此为止」 still gives start < end.
  const backward = spanBetween(40_000, 12_500, 120_000);
  expect(backward).toEqual(forward);
  if (!forward.ok) throw new Error("unreachable");
  expect(valid(forward.anchor)).toBe(true);
  // Up to the last millisecond is fine.
  const toEnd = spanBetween(100_000, 120_000, 120_000);
  expect(toEnd.ok && valid(toEnd.anchor)).toBe(true);
  // Fractional inputs are rounded to whole milliseconds, as the daemon wants.
  const rounded = spanBetween(1_000.4, 5_000.6, 120_000.2);
  expect(rounded).toEqual({ ok: true, anchor: { start_ms: 1_000, end_ms: 5_001, duration_ms: 120_000 } });
});

test("a zero-length or sub-second span is refused, and so is one past the end or with no duration", () => {
  expect(spanBetween(12_000, 12_000, 120_000)).toEqual({ ok: false, reason: "too-short" });
  expect(spanBetween(12_000, 12_000 + MIN_SPAN_MS - 1, 120_000)).toEqual({ ok: false, reason: "too-short" });
  expect(spanBetween(12_000 + MIN_SPAN_MS - 1, 12_000, 120_000)).toEqual({ ok: false, reason: "too-short" });
  expect(spanBetween(12_000, 12_000 + MIN_SPAN_MS, 120_000).ok).toBe(true);
  // The point was set before the player learned the file was shorter.
  expect(spanBetween(90_000, 30_000, 60_000)).toEqual({ ok: false, reason: "past-end" });
  expect(spanBetween(30_000, 60_001, 60_000)).toEqual({ ok: false, reason: "past-end" });
  expect(spanBetween(1_000, 5_000, null)).toEqual({ ok: false, reason: "no-duration" });
  expect(spanBetween(1_000, 5_000, 0)).toEqual({ ok: false, reason: "no-duration" });
  // What the element reports goes through the same checks.
  expect(extendTo(12_500, 40, 120)).toEqual({ ok: true, anchor: { start_ms: 12_500, end_ms: 40_000, duration_ms: 120_000 } });
  expect(extendTo(12_500, 12.9, 120)).toEqual({ ok: false, reason: "too-short" });
  expect(extendTo(12_500, 40, Number.NaN)).toEqual({ ok: false, reason: "no-duration" });
});

test("every point and span the buttons can make passes the daemon's check", () => {
  // Awkward durations and positions: fractions of a millisecond, the very ends, a hair past the end.
  const durations = [0.0015, 0.9994, 1, 1.0005, 3.2, 59.9996, 120, 3_723.4567, 36_000.0001];
  let spans = 0;
  for (const seconds of durations) {
    const positions = [0, 0.0004, 0.5, 1, seconds / 3, seconds / 2, seconds - 1, seconds - 0.0004, seconds, seconds + 0.0004, seconds + 5];
    for (const at of positions) {
      const point = pointAt(at, seconds);
      if (!point) continue;
      expect(validateAnchor("media_time", point)).toEqual({ ok: true, anchor: point });
      for (const to of positions) {
        const span = extendTo(point.start_ms, to, seconds);
        if (!span.ok) continue;
        spans += 1;
        expect(validateAnchor("media_time", span.anchor)).toEqual({ ok: true, anchor: span.anchor });
        expect(span.anchor.end_ms! - span.anchor.start_ms).toBeGreaterThanOrEqual(MIN_SPAN_MS);
      }
    }
  }
  expect(spans).toBeGreaterThan(50);
  // A time that is not a number never reaches an anchor as NaN.
  expect(spanBetween(Number.NaN, 5_000, 120_000)).toEqual({ ok: true, anchor: { start_ms: 0, end_ms: 5_000, duration_ms: 120_000 } });
  expect(spanBetween(5_000, Number.POSITIVE_INFINITY, 120_000)).toEqual({ ok: true, anchor: { start_ms: 0, end_ms: 5_000, duration_ms: 120_000 } });
});

test("marks land at their share of the duration, numbered in the order given", () => {
  const rows = [
    row("a", { start_ms: 30_000, duration_ms: 120_000 }),
    row("b", { start_ms: 60_000, end_ms: 90_000, duration_ms: 120_000 }, { status: "draft", message_id: null }),
    row("c", { start_ms: 0, duration_ms: 120_000 }, { status: "resolved" }),
    row("d", { start_ms: 120_000, duration_ms: 120_000 }, { stale: { kind: "changed" } }),
  ];
  const { marks } = layoutTimeline(rows, 120_000);
  expect(marks.map((m) => [m.id, m.n, m.left, m.width, m.status, m.stale])).toEqual([
    ["a", 1, 25, 0, "open", false],
    ["b", 2, 50, 25, "draft", false],
    ["c", 3, 0, 0, "resolved", false],
    ["d", 4, 100, 0, "open", true],
  ]);
  expect(marks[1]?.label).toBe("01:00–01:30");
  expect(marks[1]?.end_ms).toBe(90_000);
  expect(percentOf(30_000, 120_000)).toBe(25);
  expect(percentOf(200_000, 120_000)).toBe(100);
  expect(percentOf(5, 0)).toBe(0);
});

test("a row whose start is past the current duration, or whose file is gone, is not drawn but keeps its number", () => {
  const rows = [
    row("gone", { start_ms: 1_000, duration_ms: 120_000 }, { stale: { kind: "missing" } }),
    row("late", { start_ms: 100_000, duration_ms: 120_000 }, { stale: { kind: "changed" } }),
    row("cut", { start_ms: 50_000, end_ms: 100_000, duration_ms: 120_000 }, { stale: { kind: "changed" } }),
    row("edge", { start_ms: 80_000, end_ms: 100_000, duration_ms: 120_000 }, { stale: { kind: "changed" } }),
    row("ok", { start_ms: 20_000, duration_ms: 120_000 }),
  ];
  // The file was replaced by one 80 seconds long.
  const { marks } = layoutTimeline(rows, 80_000);
  expect(marks.map((m) => m.id)).toEqual(["cut", "edge", "ok"]);
  expect(marks.map((m) => m.n)).toEqual([3, 4, 5]);
  // A span that runs past the end is cut there; one cut down to nothing is drawn as a point.
  expect(drawnTimes(rows[2]!, 80_000)).toEqual({ start_ms: 50_000, end_ms: 80_000 });
  expect(marks[0]?.width).toBeCloseTo(37.5);
  expect(marks[0]?.label).toBe("00:50–01:40");
  expect(drawnTimes(rows[3]!, 80_000)).toEqual({ start_ms: 80_000, end_ms: null });
  // Another kind never lands on a timeline; nothing does while the duration is unknown.
  expect(drawnTimes({ ...rows[4]!, anchor_kind: "text_range" }, 80_000)).toBeNull();
  expect(layoutTimeline(rows, null)).toEqual({ marks: [], lanes: 1 });
});

test("overlapping spans and crowded points are dealt into lanes, at most three", () => {
  const d = 100_000;
  const { marks, lanes } = layoutTimeline(
    [
      row("s1", { start_ms: 10_000, end_ms: 50_000, duration_ms: d }),
      row("s2", { start_ms: 20_000, end_ms: 30_000, duration_ms: d }),
      // Starts where s2 ends: the second lane is free again.
      row("s3", { start_ms: 30_000, end_ms: 40_000, duration_ms: d }),
      // A point clear of everything goes back to the first lane.
      row("p1", { start_ms: 70_000, duration_ms: d }),
      // One a second later would sit on its badge.
      row("p2", { start_ms: 71_000, duration_ms: d }),
    ],
    d,
  );
  const lane = Object.fromEntries(marks.map((m) => [m.id, m.lane]));
  expect(lane).toEqual({ s1: 0, s2: 1, s3: 1, p1: 0, p2: 1 });
  expect(lanes).toBe(2);
  // Five spans on top of each other stop at three lanes.
  const piled = layoutTimeline(
    ["a", "b", "c", "e", "f"].map((id, i) => row(id, { start_ms: 1_000 * i, end_ms: 90_000, duration_ms: d })),
    d,
  );
  expect(piled.lanes).toBe(MAX_LANES);
  expect(Math.max(...piled.marks.map((m) => m.lane))).toBe(MAX_LANES - 1);
});

test("on a narrow timeline a point's mark takes its real width, so close points get their own lanes", () => {
  // Not laid out yet, or nothing to measure: the share the layout always had.
  expect(pointRoom(0, 40)).toBe(POINT_ROOM);
  expect(pointRoom(800, 0)).toBe(POINT_ROOM);
  expect(pointRoom(Number.NaN, 40)).toBe(POINT_ROOM);
  // A 20px mark on a wide desktop timeline is under the floor.
  expect(pointRoom(800, 20)).toBe(POINT_ROOM);
  // A phone: 40px tap targets on a 310px timeline.
  expect(pointRoom(310, 40)).toBeCloseTo(40 / 310);
  expect(pointRoom(50, 40)).toBe(0.5);

  // Three minutes, two remarks ten seconds (5.6%) apart.
  const d = 180_000;
  const rows = [row("p1", { start_ms: 60_000, duration_ms: d }), row("p2", { start_ms: 70_000, duration_ms: d })];
  expect(layoutTimeline(rows, d).marks.map((m) => m.lane)).toEqual([0, 0]);
  expect(layoutTimeline(rows, d, pointRoom(900, 20)).marks.map((m) => m.lane)).toEqual([0, 0]);
  const phone = layoutTimeline(rows, d, pointRoom(310, 40));
  expect(phone.marks.map((m) => m.lane)).toEqual([0, 1]);
  expect(phone.lanes).toBe(2);
  // A room that is not a number is the default one.
  expect(layoutTimeline(rows, d, Number.NaN).marks.map((m) => m.lane)).toEqual([0, 0]);
});

/** A `<video>` stand-in: seeks land on the next microtask unless told otherwise. */
function fakeVideo(init: { time: number; paused: boolean; width?: number; height?: number; seeks?: "land" | "hang" }) {
  const log: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let time = init.time;
  let paused = init.paused;
  const emit = (type: string) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn();
  };
  const video: FrameSource = {
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      time = value;
      log.push(`seek:${value}`);
      if (init.seeks !== "hang") queueMicrotask(() => emit("seeked"));
    },
    get paused() {
      return paused;
    },
    videoWidth: init.width ?? 1920,
    videoHeight: init.height ?? 1080,
    pause() {
      paused = true;
      log.push("pause");
    },
    play() {
      paused = false;
      log.push("play");
      return Promise.resolve();
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
  const listening = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
  return { video, log, listening };
}

const png: EncodedCrop = { mime: "image/png", base64: "AAAA" };

test("a video crop pauses, seeks to the start, draws the whole frame, then puts playback back", async () => {
  const { video, log, listening } = fakeVideo({ time: 30, paused: false });
  const rects: PixelRect[] = [];
  const crop = await captureFrame(video, 12_500, async (source, rect) => {
    log.push(`draw@${source.currentTime}`);
    rects.push(rect);
    return png;
  });
  expect(crop).toEqual(png);
  expect(log).toEqual(["pause", "seek:12.5", "draw@12.5", "seek:30", "play"]);
  expect(rects).toEqual([{ sx: 0, sy: 0, sw: 1920, sh: 1080 }]);
  expect(video.paused).toBe(false);
  expect(listening()).toBe(0);
});

test("a paused video stays paused where it was; no picture means no crop and no seeking", async () => {
  const paused = fakeVideo({ time: 7, paused: true });
  expect(await captureFrame(paused.video, 0, async () => png)).toEqual(png);
  expect(paused.log).toEqual(["seek:0", "seek:7"]);
  expect(paused.video.paused).toBe(true);

  const blank = fakeVideo({ time: 7, paused: false, width: 0, height: 0 });
  expect(await captureFrame(blank.video, 1_000, async () => png)).toBeNull();
  expect(blank.log).toEqual([]);
});

test("a seek that never lands gives up without a crop and still restores the position", async () => {
  const { video, log, listening } = fakeVideo({ time: 20, paused: false, seeks: "hang" });
  let drew = false;
  const crop = await captureFrame(
    video,
    5_000,
    async () => {
      drew = true;
      return png;
    },
    20,
  );
  expect(crop).toBeNull();
  expect(drew).toBe(false);
  expect(log).toEqual(["pause", "seek:5", "seek:20", "play"]);
  expect(video.currentTime).toBe(20);
  expect(listening()).toBe(0);
});

test("a video taken off the page during the crop is not started again", async () => {
  const { video, log } = fakeVideo({ time: 30, paused: false });
  let connected = true;
  Object.defineProperty(video, "isConnected", { get: () => connected });
  const crop = await captureFrame(video, 12_500, async () => {
    // The preview closes while the frame is being drawn.
    connected = false;
    return png;
  });
  expect(crop).toEqual(png);
  expect(log).toEqual(["pause", "seek:12.5", "seek:30"]);
  expect(video.paused).toBe(true);
});

test("a canvas that refuses to draw gives no crop, and playback is still put back", async () => {
  const { video, log } = fakeVideo({ time: 3, paused: false });
  const crop = await captureFrame(video, 1_000, async () => {
    throw new Error("tainted");
  });
  expect(crop).toBeNull();
  expect(log).toEqual(["pause", "seek:1", "seek:3", "play"]);
});
