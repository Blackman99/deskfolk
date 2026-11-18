/**
 * 音视频时间点批注（#29）的纯逻辑：播放位置（秒）→ 锚点（毫秒）；时间段的排序与校验（倒着拖也照样
 * 从早到晚、太短或超出时长的不收）；时间轴上的百分比、编号和分道；标记上的文字。外加从视频里取一帧
 * 当裁图：元素和画图都由调用方传进来，这里不碰 DOM 全局。
 */
import { formatMediaTime, type Annotation, type MediaTimeAnchor } from "@real-bot/protocol";
import { cropDrawable, type EncodedCrop, type PixelRect } from "./region-box.ts";

/**
 * A span shorter than this is refused: the labels show whole seconds, so anything less would read as
 * `00:12–00:12`. A point is the right anchor for a single moment.
 */
export const MIN_SPAN_MS = 1000;
/** At most this many rows of marks under the player; more overlaps share the least busy one. */
export const MAX_LANES = 3;
/**
 * The least share of the timeline a point's mark takes up around it, for dealing marks into lanes;
 * on a narrow timeline the mark's real width in pixels ({@link pointRoom}) takes more.
 */
export const POINT_ROOM = 0.03;
/** A seek that has not landed after this long is given up on: a crop is never worth hanging a save. */
export const SEEK_TIMEOUT_MS = 3000;

/** A media element's seconds as whole milliseconds; anything not a finite, non-negative number is 0. */
export function secondsToMs(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

/**
 * The element's duration in milliseconds, or null while there is none to measure against: no
 * metadata yet (NaN), a stream with no end (Infinity), or nothing at all.
 */
export function durationMs(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = Math.round(seconds * 1000);
  return ms >= 1 ? ms : null;
}

/** 「在此处批注」: a point at the playback position. Null while the duration is unknown. */
export function pointAt(currentSeconds: number, durationSeconds: number): MediaTimeAnchor | null {
  const total = durationMs(durationSeconds);
  if (total === null) return null;
  return { start_ms: Math.min(secondsToMs(currentSeconds), total), duration_ms: total };
}

export type SpanProblem = "no-duration" | "too-short" | "past-end";
export type SpanCheck = { ok: true; anchor: MediaTimeAnchor } | { ok: false; reason: SpanProblem };

/**
 * A span between two times, whichever came first: someone who seeks back before pressing 「到此为止」
 * still gets a start before the end. Shorter than {@link MIN_SPAN_MS} (a zero-length one included)
 * or running past the duration is refused, with the reason.
 */
export function spanBetween(aMs: number, bMs: number, duration: number | null): SpanCheck {
  if (duration === null || !Number.isFinite(duration) || duration < 1) return { ok: false, reason: "no-duration" };
  const total = Math.round(duration);
  // A time that is not a number is the start, as `secondsToMs` reads it: never a NaN in an anchor.
  const whole = (ms: number): number => (Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0);
  const a = whole(aMs);
  const b = whole(bMs);
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  if (end > total) return { ok: false, reason: "past-end" };
  if (end - start < MIN_SPAN_MS) return { ok: false, reason: "too-short" };
  return { ok: true, anchor: { start_ms: start, end_ms: end, duration_ms: total } };
}

/** 「到此为止」: the span from where the point was set to the playback position now. */
export function extendTo(originMs: number, currentSeconds: number, durationSeconds: number): SpanCheck {
  return spanBetween(originMs, secondsToMs(currentSeconds), durationMs(durationSeconds));
}

/** How an anchor reads on the timeline and in its tooltip: `00:12`, `00:12–00:30`, `1:02:03`. */
export function timeLabel(anchor: { start_ms: number; end_ms?: number | null }): string {
  const start = formatMediaTime(anchor.start_ms);
  return anchor.end_ms === undefined || anchor.end_ms === null ? start : `${start}–${formatMediaTime(anchor.end_ms)}`;
}

/**
 * The share of the timeline one point's mark covers on screen: its width over the timeline's, in
 * pixels, never under {@link POINT_ROOM}. A phone's 40px tap target on a 300px timeline is 13% of it,
 * and two points closer than that must go to different lanes or their badges and targets overlap.
 * Unmeasured (no layout yet), it is {@link POINT_ROOM}.
 */
export function pointRoom(trackPx: number, pointPx: number): number {
  if (!(trackPx > 0) || !(pointPx > 0)) return POINT_ROOM;
  return Math.min(0.5, Math.max(POINT_ROOM, pointPx / trackPx));
}

/** A time as a share of the duration, in percent, kept on the timeline. */
export function percentOf(ms: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.min(100, Math.max(0, (ms / duration) * 100));
}

export type MarkStatus = "open" | "draft" | "resolved";

export type TimelineMark = {
  id: string;
  /** 1-based, by place in the rows given: the list's number, even when rows before it are not drawn. */
  n: number;
  status: MarkStatus;
  /** The file changed since the remark was written: drawn dashed. */
  stale: boolean;
  start_ms: number;
  /** The end as drawn, cut at the duration; null for a point. */
  end_ms: number | null;
  /** Percentages of the timeline: where it starts and how wide it is (0 for a point). */
  left: number;
  width: number;
  /** Which row under the player it sits in, from 0. */
  lane: number;
  /** The stored times, as the list shows them. */
  label: string;
  body: string;
};

export type TimelineLayout = { marks: TimelineMark[]; lanes: number };

const statusOf = (row: Annotation): MarkStatus => (row.status === "draft" ? "draft" : row.status === "resolved" ? "resolved" : "open");

/**
 * Where a row sits on a timeline of `duration` ms, or null when it is not drawn: another kind, a
 * file that is gone, or a start past the end (the file got shorter); those only appear in the list.
 * A span that runs past the end is cut there; one cut down to nothing is drawn as a point.
 */
export function drawnTimes(row: Annotation, duration: number): { start_ms: number; end_ms: number | null } | null {
  if (row.anchor_kind !== "media_time" || row.stale?.kind === "missing") return null;
  const anchor = row.anchor as MediaTimeAnchor;
  if (typeof anchor.start_ms !== "number" || !Number.isFinite(anchor.start_ms)) return null;
  const start = Math.max(0, anchor.start_ms);
  if (start > duration) return null;
  const rawEnd = typeof anchor.end_ms === "number" && Number.isFinite(anchor.end_ms) ? Math.min(anchor.end_ms, duration) : null;
  return { start_ms: start, end_ms: rawEnd !== null && rawEnd > start ? rawEnd : null };
}

/**
 * The marks for one file's rows on a timeline of `duration` ms, numbered in the order given and dealt
 * into lanes so overlapping spans and crowded points stay apart: each takes the first lane where it
 * clears the last mark, up to {@link MAX_LANES}; past that, the lane that frees up soonest. `room` is
 * the share of the timeline a point's mark covers ({@link pointRoom}). Nothing is drawn while the
 * duration is unknown.
 */
export function layoutTimeline(rows: readonly Annotation[], duration: number | null, room = POINT_ROOM): TimelineLayout {
  if (duration === null || !(duration > 0)) return { marks: [], lanes: 1 };
  const marks: TimelineMark[] = [];
  rows.forEach((row, index) => {
    const times = drawnTimes(row, duration);
    if (!times) return;
    const left = percentOf(times.start_ms, duration);
    const width = times.end_ms === null ? 0 : percentOf(times.end_ms, duration) - left;
    const anchor = row.anchor as MediaTimeAnchor;
    marks.push({
      id: row.id,
      n: index + 1,
      status: statusOf(row),
      stale: Boolean(row.stale),
      start_ms: times.start_ms,
      end_ms: times.end_ms,
      left,
      width,
      lane: 0,
      label: timeLabel(anchor),
      body: row.body,
    });
  });
  // In milliseconds, not percentages: 0.3 * 100 is 30.000000000000004, and touching spans must fit.
  const badge = (Number.isFinite(room) && room > 0 ? room : POINT_ROOM) * duration;
  const extent = (mark: TimelineMark): [number, number] => {
    if (mark.end_ms === null) return [mark.start_ms - badge / 2, mark.start_ms + badge / 2];
    return [mark.start_ms, Math.max(mark.end_ms, mark.start_ms + badge)];
  };
  const laneEnds: number[] = [];
  const order = [...marks].sort((a, b) => a.start_ms - b.start_ms || a.n - b.n);
  for (const mark of order) {
    const [lo, hi] = extent(mark);
    let lane = laneEnds.findIndex((end) => end <= lo);
    if (lane < 0) {
      if (laneEnds.length < MAX_LANES) lane = laneEnds.length;
      else lane = laneEnds.indexOf(Math.min(...laneEnds));
    }
    laneEnds[lane] = Math.max(laneEnds[lane] ?? Number.NEGATIVE_INFINITY, hi);
    mark.lane = lane;
  }
  return { marks, lanes: Math.max(1, laneEnds.length) };
}

/** A mark's tooltip: number, times, the stale note when it has one, then the remark on its own line. */
export function markTitle(mark: Pick<TimelineMark, "n" | "label" | "stale" | "body">, staleNote: string): string {
  return `${mark.n} · ${mark.label}${mark.stale ? ` · ${staleNote}` : ""}\n${mark.body}`;
}

/** What frame capture needs of a `<video>`; the real element and a test double both provide it. */
export type FrameSource = {
  currentTime: number;
  readonly paused: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  /** False once the element has left the page: it is not started again then. */
  readonly isConnected?: boolean;
  pause(): void;
  play(): Promise<void> | void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/** Draws `rect` of the frame on screen into an encoded crop; {@link cropDrawable} unless a test says otherwise. */
export type FrameDrawer = (source: FrameSource, rect: PixelRect) => Promise<EncodedCrop | null>;

export const drawVideoFrame: FrameDrawer = (source, rect) => cropDrawable(source as unknown as CanvasImageSource, rect);

/** Move the playback position and wait for it to land: `seeked`, else `error` or the timeout (false). */
export function seekTo(media: FrameSource, seconds: number, timeoutMs = SEEK_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (landed: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      media.removeEventListener("seeked", onSeeked);
      media.removeEventListener("error", onError);
      resolve(landed);
    };
    const onSeeked = (): void => finish(true);
    const onError = (): void => finish(false);
    media.addEventListener("seeked", onSeeked);
    media.addEventListener("error", onError);
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      media.currentTime = Math.max(0, seconds);
    } catch {
      finish(false);
    }
  });
}

/**
 * The frame at `startMs` as the annotation's crop: pause, seek there, wait for the frame, draw it
 * whole (long side ≤ 1024 and ≤ 1 MB, which `cropDrawable` sees to), then put the playback position
 * and the playing state back as they were. Null when the video has no picture yet, the seek never
 * lands, or the canvas refuses — the annotation is saved without a crop.
 */
export async function captureFrame(
  video: FrameSource,
  startMs: number,
  draw: FrameDrawer = drawVideoFrame,
  timeoutMs = SEEK_TIMEOUT_MS,
): Promise<EncodedCrop | null> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!(width > 0) || !(height > 0)) return null;
  const was = { time: video.currentTime, paused: video.paused };
  if (!was.paused) video.pause();
  try {
    if (!(await seekTo(video, startMs / 1000, timeoutMs))) return null;
    return await draw(video, { sx: 0, sy: 0, sw: width, sh: height });
  } catch {
    return null;
  } finally {
    await seekTo(video, Number.isFinite(was.time) ? was.time : 0, timeoutMs);
    // The preview may have closed during the detour: a detached element that plays is sound with no
    // player left to stop it.
    if (!was.paused && video.isConnected !== false) {
      try {
        await video.play();
      } catch {
        // Autoplay rules may refuse; the person presses play again.
      }
    }
  }
}
