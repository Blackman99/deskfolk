/**
 * 照样片 (a standard check, ADR 0060): one unit of a large job held to the sample you approved.
 * The content differs from unit to unit; what is compared is the craft and the form — a moving
 * picture where the sample moved, as many different pictures for the length, the sound and
 * subtitles the sample had, prose as finished as the sample's. The app gathers the evidence itself
 * (frames, a count of different pictures, image thumbnails, text excerpts) from the sample's
 * approved hand-over and the unit's latest one, and a model compares them.
 *
 * Unlike a seams check on pictures it is a gate (ADR 0046 keeps those a reference): you set the bar
 * by approving the sample, the comparison is relative rather than absolute, and the judge is told
 * to pass whatever it is unsure of. A judgement it could not make (no model, your stop, today's
 * picture budget spent, nothing handed over yet) is neither a pass nor a fail, and holds nothing.
 */
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptanceCheck, Locale } from "@real-bot/protocol";
import type { CheckVerdict } from "./acceptance-eval";
import { resolveFfmpegBins, runProcess } from "./seams-check";
import { ENV_WHITELIST } from "./terminal-env";
import { classifyPath } from "./workspace-paths";

export type StandardEvidence = { kind: "text"; text: string } | { kind: "image"; label: string; dataUri: string };

/** Asks a model to compare: the system prompt is {@link standardJudgePrompt}; returns its raw answer. */
export type JudgeStandard = (evidence: StandardEvidence[], system: string, sessionId: string | null) => Promise<string>;

/** The two hand-overs compared: the sample's approved one and the unit's latest, as workspace paths. */
export type StandardSides = {
  sample: { label: string; paths: string[] };
  current: { label: string; paths: string[] } | null;
};

export type StandardEvalDeps = {
  sides: StandardSides | null;
  judge: JudgeStandard;
  rules: readonly string[];
  sessionId: string | null;
  locale?: Locale;
  signal?: AbortSignal;
  env?: Record<string, string>;
};

/** Frames taken from each side's video. */
const FRAMES_PER_SIDE = 5;
/** Images taken from each side when the sample is pictures. */
const IMAGES_PER_SIDE = 4;
const THUMB_WIDTH = 480;
/** A keyframe this close to an earlier one (mean absolute difference of 32×18 greys, 0–255) shows the same picture. */
const SAME_PICTURE = 10;
const KEYFRAME_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 30_000;
const EXCERPT = 600;

const VIDEO = new Set(["mp4", "mov", "mkv", "webm", "m4v"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "webp"]);
const TEXT = new Set(["md", "txt", "html", "htm"]);

type Modality = "video" | "image" | "text";

function ext(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function modalityOf(paths: readonly string[]): Modality | null {
  if (paths.some((path) => VIDEO.has(ext(path)))) return "video";
  if (paths.some((path) => IMAGE.has(ext(path)))) return "image";
  if (paths.some((path) => TEXT.has(ext(path)))) return "text";
  return null;
}

function say(locale: Locale): (zh: string, en: string) => string {
  return (zh, en) => (locale === "en" ? en : zh);
}

function envOf(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_WHITELIST) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The files of a side that exist inside the workspace, as absolute paths. */
function present(root: string, paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    let abs: string;
    try {
      const where = classifyPath(root, path);
      if (where.zone !== "inside") return [];
      abs = where.abs;
    } catch {
      return [];
    }
    try {
      return statSync(abs).isFile() ? [abs] : [];
    } catch {
      return [];
    }
  });
}

/** The system prompt: what is compared, the plan's rules, and the JSON it answers with. */
export function standardJudgePrompt(item: string, rules: readonly string[], locale: Locale): string {
  const zh = locale !== "en";
  const rulesText = rules.length ? rules.map((rule) => `- ${rule}`).join("\n") : zh ? "（这个规划没有定过额外规则）" : "(this plan has no extra rules)";
  if (zh) {
    return [
      `你在核对一件大活里的一部分有没有达到用户放行的样片的水准，为这条验收作证：${item}`,
      "先给的是样片（用户亲自看过并放行，就是要达到的水准），后给的是这次交上来的那一部分。两者内容不同是正常的（不同的场、章、页）；只比做工和形式：",
      [
        "1. 形式：样片是什么东西，这次是不是同样的东西。样片画面在动，这次却大多是静止图片加推拉摇移，就是没达到；样片是成段的正文，这次只有提纲，也是没达到。",
        "2. 丰富度：按长度折算，这次不同画面、不同内容的多少不比样片少太多；同一张画面、同一段话反复出现是没达到。",
        "3. 完整：样片有的东西（声音、对白、字幕、配色、排版、清晰度），这次也要有。",
        "4. 质量：画面清楚、人物和画风前后一致、文字通顺，不比样片明显差。",
      ].join("\n"),
      `这个规划定过的规则：\n${rulesText}`,
      "拿不准就判达到：只有看得出、说得出的差距才算没达到。",
      `只输出 JSON，不要 markdown 围栏，不要前言后语：{"ok":true,"issues":[]}。ok 是这次是否达到样片的水准；没达到时 issues 每条一句话，说清这次哪里不如样片、在哪（第几帧、哪一段）。`,
    ].join("\n\n");
  }
  return [
    `You are checking whether one part of a large job keeps the standard of the sample the user approved, to prove this acceptance line: ${item}`,
    "First comes the sample (the user looked at it and approved it: it is the bar), then the part handed over now. Their content differs, as it should (another scene, chapter or page); compare only the craft and the form:",
    [
      "1. Form: is this the same kind of thing as the sample? Mostly still pictures under camera moves where the sample's picture moves falls short; an outline where the sample is finished prose falls short.",
      "2. Richness: for its length, not far fewer different pictures or different content than the sample; the same picture or passage over and over falls short.",
      "3. Completeness: what the sample has (sound, dialogue, subtitles, colour, layout, sharpness), this has too.",
      "4. Quality: clear pictures, characters and style consistent, readable text — not clearly worse than the sample.",
    ].join("\n"),
    `Rules this plan has settled on:\n${rulesText}`,
    "When unsure, pass it: only a gap you can see and name falls short.",
    `Answer with JSON only, no markdown fences, no preamble: {"ok":true,"issues":[]}. ok is whether this keeps the sample's standard; when it does not, issues has one line each saying where this falls short of the sample (which frame, which passage).`,
  ].join("\n\n");
}

/** Strict: valid JSON with a boolean `ok`; issues kept as strings. Null when it does not read. */
export function parseStandardAnswer(raw: string): { ok: boolean; issues: string[] } | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { ok?: unknown; issues?: unknown };
    if (typeof parsed.ok !== "boolean") return null;
    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((issue): issue is string => typeof issue === "string" && issue.trim().length > 0) : [];
    return { ok: parsed.ok, issues: issues.map((issue) => issue.trim()) };
  } catch {
    return null;
  }
}

type Bins = { ffmpeg: string; ffprobe: string };

async function duration(bins: Bins, abs: string, env: Record<string, string>, signal?: AbortSignal): Promise<number | null> {
  const result = await runProcess(bins.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", abs],
    { cwd: tmpdir(), env, timeoutMs: STEP_TIMEOUT_MS, signal });
  const value = Number.parseFloat(result.stdout.trim());
  return result.code === 0 && Number.isFinite(value) ? value : null;
}

async function videoFacts(bins: Bins, abs: string, env: Record<string, string>, signal?: AbortSignal): Promise<{ width: number; height: number; audio: boolean }> {
  const result = await runProcess(bins.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", abs],
    { cwd: tmpdir(), env, timeoutMs: STEP_TIMEOUT_MS, signal });
  try {
    const streams = (JSON.parse(result.stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number }> }).streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video");
    return { width: video?.width ?? 0, height: video?.height ?? 0, audio: streams.some((stream) => stream.codec_type === "audio") };
  } catch {
    return { width: 0, height: 0, audio: false };
  }
}

/**
 * How many different pictures a video shows: its keyframes (an encoder puts one at every cut and at
 * least every few seconds) at 32×18 grey, grouped when two are nearly the same picture. A still
 * moved by a camera move stays one picture; a reused still comes back as the same one.
 */
async function pictureCount(bins: Bins, abs: string, dir: string, env: Record<string, string>, signal?: AbortSignal): Promise<{ keyframes: number; pictures: number; mostShown: number } | null> {
  const out = join(dir, `keys-${Math.random().toString(36).slice(2)}.gray`);
  const result = await runProcess(bins.ffmpeg, ["-v", "error", "-y", "-skip_frame", "nokey", "-i", abs, "-an", "-fps_mode", "vfr",
    "-vf", "scale=32:18,format=gray", "-f", "rawvideo", out], { cwd: dir, env, timeoutMs: KEYFRAME_TIMEOUT_MS, signal });
  if (result.code !== 0) return null;
  let raw: Buffer;
  try {
    raw = readFileSync(out);
  } catch {
    return null;
  }
  const size = 32 * 18;
  const groups: Array<{ rep: Buffer; count: number }> = [];
  for (let offset = 0; offset + size <= raw.length; offset += size) {
    const frame = raw.subarray(offset, offset + size);
    const same = groups.find((group) => {
      let total = 0;
      for (let i = 0; i < size; i++) total += Math.abs(group.rep[i]! - frame[i]!);
      return total / size < SAME_PICTURE;
    });
    if (same) same.count++;
    else groups.push({ rep: frame, count: 1 });
  }
  const keyframes = groups.reduce((sum, group) => sum + group.count, 0);
  return keyframes === 0 ? null : { keyframes, pictures: groups.length, mostShown: Math.max(...groups.map((group) => group.count)) };
}

async function thumbnail(bins: Bins, args: string[], out: string, env: Record<string, string>, signal?: AbortSignal): Promise<string | null> {
  const result = await runProcess(bins.ffmpeg, ["-v", "error", "-y", ...args, "-frames:v", "1", "-vf", `scale=${THUMB_WIDTH}:-2`, "-q:v", "5", out],
    { cwd: tmpdir(), env, timeoutMs: STEP_TIMEOUT_MS, signal });
  if (result.code !== 0) return null;
  try {
    return `data:image/jpeg;base64,${readFileSync(out).toString("base64")}`;
  } catch {
    return null;
  }
}

/** The video of a side that runs longest: its master, not one of its clips. */
async function longestVideo(bins: Bins, files: readonly string[], env: Record<string, string>, signal?: AbortSignal): Promise<{ abs: string; seconds: number } | null> {
  let best: { abs: string; seconds: number } | null = null;
  for (const abs of files.filter((file) => VIDEO.has(ext(file)))) {
    const seconds = await duration(bins, abs, env, signal);
    if (seconds !== null && (!best || seconds > best.seconds)) best = { abs, seconds };
  }
  return best;
}

async function videoSide(bins: Bins, label: string, files: readonly string[], dir: string, tag: string, env: Record<string, string>, locale: Locale, signal?: AbortSignal): Promise<StandardEvidence[]> {
  const t = say(locale);
  const video = await longestVideo(bins, files, env, signal);
  if (!video) return [{ kind: "text", text: t(`${label}：里面没有视频。`, `${label}: there is no video in it.`) }];
  const facts = await videoFacts(bins, video.abs, env, signal);
  const count = await pictureCount(bins, video.abs, dir, env, signal);
  const minutes = video.seconds / 60;
  const stats = [
    t(`时长 ${video.seconds.toFixed(1)} 秒`, `${video.seconds.toFixed(1)} s long`),
    `${facts.width}×${facts.height}`,
    facts.audio ? t("有声音", "with sound") : t("没有声音", "no sound"),
    ...(count ? [t(`关键帧 ${count.keyframes} 个，其中不同的画面 ${count.pictures} 个（约每分钟 ${(count.pictures / Math.max(minutes, 1 / 60)).toFixed(1)} 个），同一画面最多出现 ${count.mostShown} 次`,
      `${count.keyframes} keyframes showing ${count.pictures} different pictures (about ${(count.pictures / Math.max(minutes, 1 / 60)).toFixed(1)} a minute), the same picture at most ${count.mostShown} times`)] : []),
  ];
  const evidence: StandardEvidence[] = [{ kind: "text", text: `${label}：${stats.join(t("，", ", "))}${t("。下面是均匀取的几帧。", ". Evenly spaced frames follow.")}` }];
  for (let i = 0; i < FRAMES_PER_SIDE; i++) {
    const at = video.seconds * (0.05 + (0.9 * i) / Math.max(1, FRAMES_PER_SIDE - 1));
    const uri = await thumbnail(bins, ["-ss", at.toFixed(2), "-i", video.abs], join(dir, `${tag}_${i + 1}.jpg`), env, signal);
    if (uri) evidence.push({ kind: "image", label: t(`${label}，第 ${i + 1} 帧（${at.toFixed(1)} 秒）`, `${label}, frame ${i + 1} (${at.toFixed(1)} s)`), dataUri: uri });
  }
  return evidence;
}

async function imageSide(bins: Bins, label: string, files: readonly string[], dir: string, tag: string, env: Record<string, string>, locale: Locale, signal?: AbortSignal): Promise<StandardEvidence[]> {
  const t = say(locale);
  const images = files.filter((file) => IMAGE.has(ext(file))).slice(0, IMAGES_PER_SIDE);
  if (images.length === 0) return [{ kind: "text", text: t(`${label}：里面没有图片。`, `${label}: there are no pictures in it.`) }];
  const evidence: StandardEvidence[] = [{ kind: "text", text: t(`${label}：${files.filter((file) => IMAGE.has(ext(file))).length} 张图，下面是前几张。`,
    `${label}: ${files.filter((file) => IMAGE.has(ext(file))).length} pictures; the first few follow.`) }];
  for (const [i, abs] of images.entries()) {
    const uri = await thumbnail(bins, ["-i", abs], join(dir, `${tag}_${i + 1}.jpg`), env, signal);
    if (uri) evidence.push({ kind: "image", label: t(`${label}，第 ${i + 1} 张`, `${label}, picture ${i + 1}`), dataUri: uri });
  }
  return evidence;
}

function textSide(label: string, files: readonly string[], locale: Locale): StandardEvidence[] {
  const t = say(locale);
  const texts = files.filter((file) => TEXT.has(ext(file)));
  let main: { abs: string; body: string } | null = null;
  for (const abs of texts) {
    try {
      const body = readFileSync(abs, "utf8").replace(/<[^>]+>/g, " ");
      if (!main || body.length > main.body.length) main = { abs, body };
    } catch {
      // gone meanwhile
    }
  }
  if (!main) return [{ kind: "text", text: t(`${label}：里面没有文字稿。`, `${label}: there is no text in it.`) }];
  const chars = [...main.body];
  const middle = Math.max(0, Math.floor(chars.length / 2) - EXCERPT / 2);
  const cut = (from: number) => chars.slice(from, from + EXCERPT).join("").trim();
  return [{ kind: "text", text: [
    t(`${label}：共 ${chars.length} 字。`, `${label}: ${chars.length} characters.`),
    t("开头：", "Opening:"), cut(0),
    t("中间：", "Middle:"), cut(middle),
    t("结尾：", "Ending:"), cut(Math.max(0, chars.length - EXCERPT)),
  ].join("\n") }];
}

/** Runs a standard check: gathers both sides' evidence, asks the judge, reads its answer. */
export async function runStandardCheck(root: string, check: Pick<AcceptanceCheck, "id" | "item">, deps: StandardEvalDeps): Promise<CheckVerdict & { pictures: boolean }> {
  const locale = deps.locale ?? "zh";
  const t = say(locale);
  const verdict = (outcome: CheckVerdict["outcome"], detail: string, output: string | null = null, pictures = false) =>
    ({ outcome, exitCode: null, detail, output, pictures });
  if (!deps.sides) return verdict("blocked", t("样片还没有放行过的交付", "the sample has no approved hand-over"));
  if (!deps.sides.current) return verdict("blocked", t("这张任务还没交东西", "nothing handed over on this ticket yet"));
  const sampleFiles = present(root, deps.sides.sample.paths);
  const currentFiles = present(root, deps.sides.current.paths);
  const modality = modalityOf(sampleFiles);
  if (!modality) return verdict("blocked", t("样片里没有能对照的视频、图片或文字", "the sample has no video, pictures or text to compare with"));
  const env = deps.env ?? envOf(process.env);
  const bins = modality === "text" ? null : resolveFfmpegBins(env);
  if (modality !== "text" && !bins) return verdict("error", t("找不到 ffmpeg/ffprobe", "ffmpeg/ffprobe not found"));
  const dir = join(tmpdir(), `deskfolk-standard-${check.id}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const sampleLabel = t(`样片（${deps.sides.sample.label}）`, `The sample (${deps.sides.sample.label})`);
    const currentLabel = t(`这次交的（${deps.sides.current.label}）`, `This hand-over (${deps.sides.current.label})`);
    const side = async (label: string, files: string[], tag: string) => modality === "video"
      ? videoSide(bins!, label, files, dir, tag, env, locale, deps.signal)
      : modality === "image" ? imageSide(bins!, label, files, dir, tag, env, locale, deps.signal) : textSide(label, files, locale);
    const evidence = [...await side(sampleLabel, sampleFiles, "sample"), ...await side(currentLabel, currentFiles, "this")];
    if (deps.signal?.aborted) return verdict("blocked", t("检查被中止", "the check was stopped"));
    const pictures = evidence.some((item) => item.kind === "image");
    let raw: string;
    try {
      raw = await deps.judge(evidence, standardJudgePrompt(check.item, deps.rules, locale), deps.sessionId);
    } catch (error) {
      return verdict("error", error instanceof Error ? error.message : t("判定失败", "the judgement failed"), null, pictures);
    }
    const answer = parseStandardAnswer(raw);
    if (!answer) return verdict("error", t("判定模型的回答读不懂", "the judge's answer did not read"), raw.slice(0, 2000), pictures);
    const stats = evidence.filter((item): item is Extract<StandardEvidence, { kind: "text" }> => item.kind === "text").map((item) => item.text.split("\n")[0]).join("\n");
    return answer.ok
      ? verdict("pass", t("达到样片的水准", "keeps the sample's standard"), stats, pictures)
      : verdict("fail", answer.issues.slice(0, 4).join(t("；", "; ")) || t("没达到样片的水准", "falls short of the sample"), `${answer.issues.join("\n")}\n\n${stats}`, pictures);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
