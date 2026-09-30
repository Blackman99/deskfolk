/**
 * Running one `measure` check (ADR 0040 P3): ffprobe reads the video the check is bound to, and the
 * number it gives is held against the range the check took from your words. Nothing is decoded;
 * one ffprobe call reads the container's own figures. Jailed like every other check: the path must
 * resolve inside the workspace when it runs, whatever it was when it was bound.
 */
import { statSync } from "node:fs";
import type { AcceptanceCheck, CheckMeasure, Locale } from "@real-bot/protocol";
import { checkEnv, type CheckVerdict } from "./acceptance-eval";
import { ASPECT_TOLERANCE, formatNumber, measureLabel } from "./derived-checks";
import { resolveFfmpegBins, runProcess } from "./seams-check";
import { classifyPath } from "./workspace-paths";

const PROBE_TIMEOUT_MS = 15_000;

/** What ffprobe says about a video: its running time and the first video stream's picture. */
export type MediaProbe = {
  seconds: number | null;
  /**
   * As displayed: the stored width times the sample aspect ratio, and turned a quarter when the
   * stream says to show it rotated (a phone's portrait clip is often stored 1920×1080 with a 90°
   * display matrix).
   */
  width: number | null;
  height: number | null;
  fps: number | null;
};

function rate(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const [n, d] = text.split("/").map(Number);
  if (!Number.isFinite(n) || !n) return null;
  if (d === undefined) return n!;
  return Number.isFinite(d) && d ? n! / d : null;
}

/** ffprobe's JSON for `-show_entries stream=…:format=duration`, read into a {@link MediaProbe}. */
export function readProbe(json: string): MediaProbe | null {
  let parsed: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return null;
  }
  const stream = parsed.streams?.[0];
  if (!stream) return null;
  const number = (value: unknown): number | null => {
    const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const stored = number(stream.width);
  const height = number(stream.height);
  const sar = rate(stream.sample_aspect_ratio === "0:1" ? undefined : String(stream.sample_aspect_ratio ?? "").replace(":", "/"));
  const width = stored === null ? null : Math.round(stored * (sar ?? 1));
  const quarter = Math.abs(Math.round(rotation(stream) / 90)) % 2 === 1;
  return {
    seconds: number(parsed.format?.duration) ?? number(stream.duration),
    width: quarter ? height : width,
    height: quarter ? width : height,
    fps: rate(stream.avg_frame_rate) ?? rate(stream.r_frame_rate),
  };
}

/** Degrees the stream is shown rotated by: its display matrix, else the older `rotate` tag; 0 when neither says. */
function rotation(stream: Record<string, unknown>): number {
  const sideData = Array.isArray(stream.side_data_list) ? (stream.side_data_list as Array<Record<string, unknown>>) : [];
  for (const entry of sideData) {
    const degrees = Number(entry.rotation);
    if (entry.rotation !== undefined && Number.isFinite(degrees)) return degrees;
  }
  const tags = stream.tags as Record<string, unknown> | undefined;
  const tagged = Number(tags?.rotate);
  return tags?.rotate !== undefined && Number.isFinite(tagged) ? tagged : 0;
}

function within(value: number, min: number | null, max: number | null): boolean {
  return (min === null || value >= min) && (max === null || value <= max);
}

/** The verdict on a probe: pass when its number falls in the measure's range, with the number said. */
export function measureVerdict(probe: MediaProbe, measure: CheckMeasure, locale: Locale): CheckVerdict {
  const say = (zh: string, en: string) => (locale === "en" ? en : zh);
  const asked = measureLabel(measure, locale);
  const verdict = (ok: boolean, got: string): CheckVerdict => ({
    outcome: ok ? "pass" : "fail",
    exitCode: null,
    detail: ok ? got : say(`${got}，要${asked}`, `${got}; needs ${asked}`),
    output: null,
  });
  const unread = (what: string): CheckVerdict => ({ outcome: "error", exitCode: null, detail: say(`读不出这个视频的${what}`, `could not read the video's ${what}`), output: null });
  if (measure.dimension === "duration") {
    if (probe.seconds === null) return unread(say("时长", "running time"));
    return verdict(within(probe.seconds, measure.min, measure.max), say(`${probe.seconds.toFixed(2)} 秒`, `${probe.seconds.toFixed(2)} s`));
  }
  if (probe.width === null || probe.height === null) return unread(say("画面大小", "picture size"));
  const size = `${probe.width}×${probe.height}`;
  if (measure.dimension === "resolution") {
    const short = Math.min(probe.width, probe.height);
    return verdict(within(short, measure.min, measure.max), say(`${size}，短边 ${short}`, `${size}, short side ${short}`));
  }
  if (measure.dimension !== "aspect") {
    if (probe.fps === null) return unread(say("帧率", "frame rate"));
    return verdict(within(probe.fps, measure.min, measure.max), `${formatNumber(probe.fps)} fps`);
  }
  if (measure.ratio === "portrait") return verdict(probe.height > probe.width, size);
  if (measure.ratio === "landscape") return verdict(probe.width > probe.height, size);
  const [w, h] = measure.ratio.split(":").map(Number);
  const wanted = w! / h!;
  return verdict(Math.abs(probe.width / probe.height - wanted) <= wanted * ASPECT_TOLERANCE, size);
}

/** `measure`: probes the bound file (`check.path`, workspace-relative) and judges it. */
export async function runMeasureCheck(
  root: string,
  check: AcceptanceCheck,
  opts: { signal?: AbortSignal; env?: Record<string, string>; locale?: Locale } = {},
): Promise<CheckVerdict> {
  const locale = opts.locale ?? "zh";
  const say = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (!check.measure) return { outcome: "error", exitCode: null, detail: say("这条检查没有写要量什么", "no measure set on this check"), output: null };
  if (!check.path) return { outcome: "blocked", exitCode: null, detail: say("还没对上交付的文件", "not bound to a delivered file yet"), output: null };
  let classified;
  try {
    classified = classifyPath(root, check.path);
  } catch {
    return { outcome: "blocked", exitCode: null, detail: say("在工作区外", "outside the workspace"), output: null };
  }
  if (classified.zone !== "inside") return { outcome: "blocked", exitCode: null, detail: say("在工作区外", "outside the workspace"), output: null };
  try {
    if (!statSync(classified.abs).isFile()) throw new Error("not a file");
  } catch {
    return { outcome: "fail", exitCode: null, detail: say("文件不在", "missing file"), output: null };
  }
  const env = opts.env ?? checkEnv(process.env);
  const bins = resolveFfmpegBins(env);
  if (!bins) return { outcome: "error", exitCode: null, detail: say("需要 ffprobe", "ffprobe is required"), output: null };
  const result = await runProcess(
    bins.ffprobe,
    [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,sample_aspect_ratio,avg_frame_rate,r_frame_rate,duration:stream_tags=rotate:stream_side_data=rotation:format=duration",
      "-of", "json", classified.abs,
    ],
    { cwd: root, env, timeoutMs: PROBE_TIMEOUT_MS, signal: opts.signal },
  );
  if (opts.signal?.aborted) return { outcome: "error", exitCode: null, detail: say("跑到一半被打断", "interrupted"), output: null };
  const probe = result.code === 0 ? readProbe(result.stdout) : null;
  if (!probe) return { outcome: "error", exitCode: null, detail: say("读不出这个视频", "could not read the video"), output: result.stderr.trim() || null };
  return measureVerdict(probe, check.measure, locale);
}
