/**
 * The `continuity` acceptance check (labelled 衔接一致 / "Seams" everywhere but the stored `kind`
 * value, which stays `continuity` — one row already exists on a real install): the app's own proof
 * that the *parts* of a deliverable several Bots made piecemeal actually fit together, not just
 * that each part alone looks fine. Written after a maintainer's own AI video job kept shipping
 * 11-shot episodes where a reviewer Bot passed every shot alone while the style jumped from
 * realistic 3D to 2D, a face changed race, a mechanical arm swapped sides, a door's side flipped
 * against the corridor, a crawl direction reversed against a door, a transition went missing, or
 * content repeated — every one of those is a *between-parts* problem no single-part review ever
 * catches. The same shape of problem shows up whenever a deliverable is assembled from parts each
 * Bot only reviewed on its own: chapters of a report, a storyboard or poster set, slide decks, a
 * multi-shot video.
 *
 * Parts, in order, come from one of three sources (see {@link resolveParts}): a `command` that
 * prints the ordered part files; a `path` glob (all matches, naturally sorted — unless the glob
 * matches video files and no command is given, in which case the newest match is a re-cut master
 * and falls back to scene detection within it); or a `path` naming one file that is itself split
 * into parts (a video via ffmpeg scene detection, a Markdown/text file at its `#`/`##` headings, an
 * HTML file the same way after stripping tags).
 *
 * Evidence for one seam (the join between two adjacent parts) depends on the parts' file type:
 * video gets the existing tail/head frame pair image; images get the two images side by side;
 * text gets the tail of the earlier part and the head of the later one. A whole-set pass (text
 * only) also hands the judge a cheap digest of every part, to catch a term, name or number that
 * drifts across the whole deliverable rather than right at one seam.
 *
 * `judge` is injected so tests can fake the model; everything else here — glob resolution, scene
 * detection, frame/image extraction, document splitting, batching, strict JSON parsing with one
 * retry — is real and runs against real ffmpeg (video/image evidence only; text evidence needs
 * nothing but the file system, and never asks a vision-capable model).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AcceptanceCheck, Locale } from "@real-bot/protocol";
import type { CheckVerdict } from "./acceptance-eval";
import { checkEnv } from "./acceptance-eval";
import { globToRegExp, isGlobPattern, splitGlobDir } from "./glob";
import { takeCodePoints } from "./text";
import { classifyPath, classifyShell } from "./workspace-paths";

/** One seam's evidence, ready to send to the judge. Homogeneous within one batch. */
export type SeamImageEvidence = { kind: "image"; n: number; dataUri: string };
export type SeamTextEvidence = { kind: "text"; n: number; label: string; before: string; after: string };
/** The whole-set digest call: one call, one evidence entry, no `n` (there is no single seam). */
export type SeamDigestEvidence = { kind: "digest"; text: string };
export type SeamEvidence = SeamImageEvidence | SeamTextEvidence | SeamDigestEvidence;

/**
 * One raw call to the vision-or-text model — either a batch of seam evidence (at most
 * {@link SEAM_MEDIA_BATCH_MAX} image seams or {@link SEAM_TEXT_BATCH_MAX} text seams), or the
 * one-item whole-set digest call. Returns the model's raw answer text; parsing (and the one retry
 * on an unparsable answer) happens in this file, not inside the judge, so a test fake only ever
 * has to hand back canned text. A text-only or digest call never carries an image part, so it
 * never requires a vision-capable model.
 */
export type JudgeSeams = (
  evidence: readonly SeamEvidence[],
  rules: readonly string[],
  item: string,
  locale: Locale,
  sessionId: string | null,
) => Promise<string>;

export type SeamsDeps = {
  judge: JudgeSeams;
  rules: readonly string[];
  /** The plan dir, workspace-relative (`work/foo-1a2b`) — image evidence lands under its `checks/` subdir. */
  planDir: string;
  /** The plan's session, for the judge call's spend attribution. */
  sessionId: string | null;
  locale?: Locale;
  signal?: AbortSignal;
  env?: Record<string, string>;
};

/** Image/video seams per call; more than this splits into several calls. */
export const SEAM_MEDIA_BATCH_MAX = 6;
/** Text seams per call — cheaper per item, so more fit in one bounded prompt. */
export const SEAM_TEXT_BATCH_MAX = 12;
/** The judge's own per-call timeout — a caller wiring the real model in reads this. */
export const SEAMS_JUDGE_TIMEOUT_MS = 120_000;

const FRAME_SCALE = "640:-1";
const IMAGE_PAIR_SCALE = "'min(640,iw)':'min(480,ih)':force_original_aspect_ratio=decrease";
const SCENE_THRESHOLD = "0.20";
const SCENE_HALF_WINDOW_SEC = 0.08;
const TAIL_OFFSET_SEC = 0.1;
const FFMPEG_STEP_TIMEOUT_MS = 30_000;
const PARTS_LIST_TIMEOUT_MS = 60_000;
/** Code points of a text seam's before/after excerpt. */
const TEXT_EXCERPT_MAX = 700;
/** Code points of one part's digest head. */
const DIGEST_PART_HEAD_MAX = 300;
/** Code points of the whole-set digest, all parts combined. */
const DIGEST_TOTAL_MAX = 6000;
/** A text part over this many bytes reads as `error`, not silently truncated. */
const TEXT_READ_MAX = 2_000_000;

const CHECKLIST_ZH = [
  "与规划的规则和这条验收一致",
  "前后衔接：前一部分的结尾能否接上后一部分的开头（缺的过渡要点名）",
  "同一对象前后一致：人物/角色、产品和专有名词、术语、数字与单位、方位与方向",
  "风格一致：视频和图片看画风、渲染、配色、角色设定；文字看语气、格式、编号",
  "重复或遗漏：后一部分是否重演前一部分已有的内容（两份证据看不出来就不要判），或漏掉了本该承接的内容",
];
const CHECKLIST_EN = [
  "consistent with the plan's rules and this acceptance line",
  "hand-off: does the previous part's ending lead into the next part's opening (name any missing transition)",
  "the same thing stays consistent throughout: characters, product and proper names, terminology, numbers and units, direction and orientation",
  "consistent style: for video and images, art style, rendering, color, character design; for text, tone, formatting, numbering",
  "repetition or gaps: whether the next part replays something the previous one already covered (do not flag it when the two pieces of evidence cannot tell), or skips something it should have picked up",
];

function say(locale: Locale): (zh: string, en: string) => string {
  return (zh, en) => (locale === "en" ? en : zh);
}

/** Which prompt/JSON contract a call needs: judging a batch of image seams, text seams, or the one whole-set digest. */
export type SeamJudgeMode = "image" | "text" | "digest";

/** The system prompt sent with every judge call: the acceptance line, the plan's rules, the fixed checklist, and the strict JSON contract. */
export function seamsJudgePrompt(item: string, rules: readonly string[], locale: Locale, mode: SeamJudgeMode): string {
  const zh = locale !== "en";
  const checklist = zh ? CHECKLIST_ZH : CHECKLIST_EN;
  const checklistText = checklist.map((line, i) => `${i + 1}. ${line}`).join("\n");
  const rulesText = zh
    ? rules.length
      ? rules.map((rule) => `- ${rule}`).join("\n")
      : "（这个规划没有定过额外规则）"
    : rules.length
      ? rules.map((rule) => `- ${rule}`).join("\n")
      : "(this plan has no extra rules)";

  if (zh) {
    const intro = `你在核对一份由几部分拼起来的交付物：各部分之间衔接得上、前后一致，为这条验收作证：${item}`;
    const rulesLine = `这个规划定过的规则：\n${rulesText}`;
    if (mode === "digest") {
      return [
        intro,
        rulesLine,
        `下面是这份交付物每一部分的摘要（标题/首段，以及其中出现的数字单位和专有名词），不是逐部分的原文。通篇检查同一件事在各部分里说的名字、编号、数字单位、口径是否前后一致：\n${checklistText}`,
        `只输出 JSON，不要 markdown 围栏，不要前言后语：{"overall":{"ok":true,"issues":[]}}。ok 是整份交付物是否前后一致，issues 是具体问题的一句话列表（一致时给空数组）。`,
      ].join("\n\n");
    }
    const evidenceLine =
      mode === "image"
        ? `每张图是相邻两部分的衔接处对照（左边是前一部分，右边是后一部分；视频截取剪切点前后帧，图片就是两张原图缩放后并排）。逐条对照检查：\n${checklistText}`
        : `每段文字是相邻两部分的衔接处摘录（前一部分结尾 + 后一部分开头）。逐条对照检查：\n${checklistText}`;
    const seamNote =
      mode === "image"
        ? `两侧几乎一样是好事：说明衔接严丝合缝，不是问题，也不算重复内容。只有看得出的不一致才写进 issues。`
        : null;
    return [
      intro,
      rulesLine,
      evidenceLine,
      ...(seamNote ? [seamNote] : []),
      `只输出 JSON，不要 markdown 围栏，不要前言后语：{"pairs":[{"n":1,"ok":true,"issues":[]}]}。n 是证据的序号，ok 是这一处是否衔接一致，issues 是具体问题的一句话列表（一致时给空数组）。`,
    ].join("\n\n");
  }

  const intro = `You are checking a deliverable assembled from several parts: whether the parts fit together and stay consistent, to prove this acceptance line: ${item}`;
  const rulesLine = `Rules this plan has settled on:\n${rulesText}`;
  if (mode === "digest") {
    return [
      intro,
      rulesLine,
      `Below is a digest of every part of this deliverable (its heading/opening, plus any numbers-with-units and proper names found in it) — not each part's full text. Check whether the same thing is named, numbered and described consistently across every part:\n${checklistText}`,
      `Answer with JSON only, no markdown fences, no preamble: {"overall":{"ok":true,"issues":[]}}. ok is whether the whole deliverable holds together, issues is a list of one-line problems (an empty array when it is fine).`,
    ].join("\n\n");
  }
  const evidenceLine =
    mode === "image"
      ? `Each image is a side-by-side pair of two adjacent parts (left is the earlier part, right is the later one; for video these are the frame just before and just after the cut, for images they are the two images themselves). Check each of the following:\n${checklistText}`
      : `Each text block is one seam's excerpt (the end of the earlier part plus the start of the later one). Check each of the following:\n${checklistText}`;
  const seamNote =
    mode === "image"
      ? `Two nearly identical sides are good news: the seam is seamless, not a problem, and not repeated content. Only put visible inconsistencies in issues.`
      : null;
  return [
    intro,
    rulesLine,
    evidenceLine,
    ...(seamNote ? [seamNote] : []),
    `Answer with JSON only, no markdown fences, no preamble: {"pairs":[{"n":1,"ok":true,"issues":[]}]}. n is the evidence's number, ok is whether that seam holds together, issues is a list of one-line problems (an empty array when it is fine).`,
  ].join("\n\n");
}

type JudgePair = { n: number; ok: boolean; issues: string[] };
type JudgeOverall = { ok: boolean; issues: string[] };
type ParsedSeamsAnswer = { pairs: JudgePair[] | null; overall: JudgeOverall | null };

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/** Strict: valid JSON, at least one usable `pairs` entry or a well-formed `overall`. Anything else is "could not parse". */
export function parseSeamsJudgeAnswer(raw: string): ParsedSeamsAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  let pairs: JudgePair[] | null = null;
  if (Array.isArray(obj.pairs)) {
    const out: JudgePair[] = [];
    for (const entry of obj.pairs) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.n !== "number" || typeof row.ok !== "boolean") continue;
      const issues = Array.isArray(row.issues) ? row.issues.filter((issue): issue is string => typeof issue === "string") : [];
      out.push({ n: row.n, ok: row.ok, issues });
    }
    pairs = out.length > 0 ? out : null;
  }

  let overall: JudgeOverall | null = null;
  if (obj.overall && typeof obj.overall === "object" && !Array.isArray(obj.overall)) {
    const row = obj.overall as Record<string, unknown>;
    if (typeof row.ok === "boolean") {
      const issues = Array.isArray(row.issues) ? row.issues.filter((issue): issue is string => typeof issue === "string") : [];
      overall = { ok: row.ok, issues };
    }
  }

  return pairs || overall ? { pairs, overall } : null;
}

/** The file a workspace-relative glob or literal path resolves to: the newest match, jail-checked. Null when nothing matches. */
export function resolveNewestMatch(root: string, pattern: string): { abs: string; rel: string } | null {
  if (!isGlobPattern(pattern)) {
    let classified;
    try {
      classified = classifyPath(root, pattern);
    } catch {
      return null;
    }
    if (classified.zone !== "inside") return null;
    try {
      if (!statSync(classified.abs).isFile()) return null;
    } catch {
      return null;
    }
    return { abs: classified.abs, rel: classified.rel };
  }
  const matches = collectGlobMatches(root, pattern);
  if (matches.length === 0) return null;
  const best = matches.reduce((a, b) => (b.mtimeMs > a.mtimeMs || (b.mtimeMs === a.mtimeMs && b.name > a.name) ? b : a));
  return { abs: best.abs, rel: best.rel };
}

type GlobMatch = { abs: string; rel: string; name: string; mtimeMs: number };

/** Every file a workspace-relative glob matches, jail-checked, in no particular order. */
function collectGlobMatches(root: string, pattern: string): GlobMatch[] {
  const { dir, filePattern } = splitGlobDir(pattern);
  let dirClassified;
  try {
    dirClassified = classifyPath(root, dir);
  } catch {
    return [];
  }
  if (dirClassified.zone !== "inside") return [];
  let entries: string[];
  try {
    entries = readdirSync(dirClassified.abs);
  } catch {
    return [];
  }
  const regex = globToRegExp(filePattern);
  const matches: GlobMatch[] = [];
  for (const name of entries) {
    if (!regex.test(name)) continue;
    const candidateRel = dirClassified.rel === "." ? name : `${dirClassified.rel}/${name}`;
    let classified;
    try {
      classified = classifyPath(root, candidateRel);
    } catch {
      continue;
    }
    if (classified.zone !== "inside") continue;
    let stat;
    try {
      stat = statSync(classified.abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    matches.push({ abs: classified.abs, rel: classified.rel, name, mtimeMs: stat.mtimeMs });
  }
  return matches;
}

/**
 * Natural sort: runs of digits compare numerically, so `c2` sorts before `c10`. Everything else
 * compares as plain text. Used for a glob's matches when they are the ordered part list (as
 * opposed to picking only the newest one).
 */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const as = a.match(re) ?? [a];
  const bs = b.match(re) ?? [b];
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const av = as[i] ?? "";
    const bv = bs[i] ?? "";
    const isNum = /^\d+$/;
    if (isNum.test(av) && isNum.test(bv)) {
      const diff = Number(av) - Number(bv);
      if (diff !== 0) return diff;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

type ProcessResult = { code: number | null; stdout: string; stderr: string };

function runProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: null, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, opts.timeoutMs);
    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish({ code: null, stdout, stderr }));
    child.on("exit", (code) => finish({ code, stdout, stderr }));
  });
}

async function extractFrame(args: readonly string[], cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<boolean> {
  const [bin, ...rest] = args;
  const result = await runProcess(bin!, rest, { cwd, env, timeoutMs: FFMPEG_STEP_TIMEOUT_MS, signal });
  return result.code === 0;
}

/**
 * ffmpeg/ffprobe, resolved from `env.PATH` or, failing that, `fallbackDirs` (`/opt/homebrew/bin`
 * by default) — never anywhere else. `fallbackDirs` is only ever overridden by a test that needs
 * to prove the "nowhere" case on a machine where that default fallback happens to be real.
 */
export function resolveFfmpegBins(
  env: Record<string, string>,
  fallbackDirs: readonly string[] = ["/opt/homebrew/bin"],
): { ffmpeg: string; ffprobe: string } | null {
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  for (const fallback of fallbackDirs) if (!dirs.includes(fallback)) dirs.push(fallback);
  const which = (bin: string): string | null => {
    for (const dir of dirs) {
      const candidate = join(dir, bin);
      try {
        const stat = statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // not here
      }
    }
    return null;
  };
  const ffmpeg = which("ffmpeg");
  const ffprobe = which("ffprobe");
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null;
}

function posixJoin(base: string, rel: string): string {
  return base === "." || base === "" ? rel : `${base}/${rel}`;
}

function posixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/** Basename without its extension — the label a file-backed part reads by absent a heading of its own. */
function partLabel(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

type Modality = "video" | "image" | "text";

const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "webm", "m4v"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const TEXT_EXTS = new Set(["md", "txt", "html", "htm"]);

function modalityOfExt(ext: string): Modality | null {
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TEXT_EXTS.has(ext)) return "text";
  return null;
}

/**
 * The ordered part files a check's `command` names, one per line of its stdout, each resolved
 * against `cwd` and jail-checked. Null when there is no command, it is not jailed, it exits
 * non-zero, or fewer than two files survive — any of which falls the caller back to `path`.
 */
async function partsListFromCommand(
  root: string,
  check: Pick<AcceptanceCheck, "command" | "cwd">,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const command = (check.command ?? "").trim();
  if (!command) return null;
  const cwd = check.cwd ?? ".";
  let classified;
  try {
    classified = classifyShell(root, command, cwd);
  } catch {
    return null;
  }
  if (classified.kind !== "jailed") return null;
  const result = await runProcess("/bin/sh", ["-c", command], { cwd: classified.cwdAbs, env, timeoutMs: PARTS_LIST_TIMEOUT_MS, signal });
  if (result.code !== 0) return null;
  const parts: string[] = [];
  for (const line of result.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const candidateRel = line.startsWith("/") ? line : posixJoin(classified.cwdRel, line);
    let candClassified;
    try {
      candClassified = classifyPath(root, candidateRel);
    } catch {
      continue;
    }
    if (candClassified.zone !== "inside") continue;
    try {
      if (!statSync(candClassified.abs).isFile()) continue;
    } catch {
      continue;
    }
    parts.push(candClassified.rel);
  }
  return parts.length >= 2 ? parts : null;
}

/** One ordered part of the deliverable: file-backed (video/image, and file-backed text) or inline text (a split document's section). */
type Part = { label: string; abs: string | null; text: string | null };

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** A text-modality part file's content, html converted to plain text; null if unreadable or too large. */
function readPartText(abs: string, ext: string): string | null {
  let raw: string;
  try {
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size > TEXT_READ_MAX) return null;
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  return ext === "html" || ext === "htm" ? stripHtmlTags(raw) : raw;
}

/** A Markdown/plain-text file split at level-1/level-2 headings (`#`/`##`); content before the first heading (if any) is its own part, labelled by the file itself. */
function splitHeadingSections(raw: string, fallbackLabel: string): { heading: string; body: string }[] {
  const lines = raw.split(/\r\n?|\n/);
  const HEADING_RE = /^(#{1,2})\s+(.+?)\s*$/;
  const sections: { heading: string; body: string }[] = [];
  let current: { heading: string; bodyLines: string[] } | null = null;
  const preambleLines: string[] = [];
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      if (current) sections.push({ heading: current.heading, body: current.bodyLines.join("\n").trim() });
      current = { heading: m[2]!.trim(), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.bodyLines.join("\n").trim() });
  const preamble = preambleLines.join("\n").trim();
  if (preamble) sections.unshift({ heading: fallbackLabel, body: preamble });
  return sections;
}

/** An HTML file split at `<h1>`/`<h2>` before tags are stripped; each section's body has its tags stripped afterward. */
function splitHtmlSections(raw: string, fallbackLabel: string): { heading: string; body: string }[] {
  const cleaned = raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const HEADING_RE = /<h([12])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings: { index: number; end: number; heading: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(cleaned))) {
    headings.push({ index: m.index, end: m.index + m[0].length, heading: stripHtmlTags(m[2]!) });
  }
  if (headings.length === 0) {
    const body = stripHtmlTags(cleaned);
    return body ? [{ heading: fallbackLabel, body }] : [];
  }
  const sections: { heading: string; body: string }[] = [];
  const preamble = stripHtmlTags(cleaned.slice(0, headings[0]!.index));
  if (preamble) sections.push({ heading: fallbackLabel, body: preamble });
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i]!.end;
    const end = i + 1 < headings.length ? headings[i + 1]!.index : cleaned.length;
    const body = stripHtmlTags(cleaned.slice(start, end));
    sections.push({ heading: headings[i]!.heading || fallbackLabel, body });
  }
  return sections;
}

/** Cheap regex over a part's text: every number-with-unit, and every quoted or CamelCase/PascalCase name. */
const NUMBER_UNIT_RE =
  /[¥$€£]?\d[\d,]*(?:\.\d+)?\s?(?:%|℃|°[CF]?|kg|mg|g|km|cm|mm|ms|s|sec|min|hrs?|h|GB|MB|KB|TB|Hz|kHz|MHz|GHz|美元|美金|元|万|亿|人|件|个|次|年|月|日|周|页|条|份|种|台|辆)\b/gu;
const NAME_RE = /[“"']([^"'”]{1,30})["'”]|\b[A-Z][A-Za-z0-9]{1,30}\b/g;

function extractSignals(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(NUMBER_UNIT_RE)) found.add(m[0].trim());
  for (const m of text.matchAll(NAME_RE)) found.add((m[1] ?? m[0]).trim());
  return [...found];
}

/** The whole-set digest (text checks only): every part's label, opening, and cheap signals, capped in total. */
function buildWholeSetDigest(parts: readonly Part[], locale: Locale): string {
  const t = say(locale);
  const chunks = parts.map((part) => {
    const body = part.text ?? "";
    const head = takeCodePoints(body, DIGEST_PART_HEAD_MAX).text;
    const signals = extractSignals(body).slice(0, 20);
    const signalsText = signals.length ? t(`［数字/专名：${signals.join("、")}］`, ` [numbers/names: ${signals.join(", ")}]`) : "";
    return `${part.label}：${head}${signalsText}`;
  });
  return takeCodePoints(chunks.join("\n---\n"), DIGEST_TOTAL_MAX).text;
}

function firstCodePoints(text: string, limit: number): string {
  return takeCodePoints(text, limit).text;
}

function lastCodePoints(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : chars.slice(-limit).join("");
}

type ResolveError = { kind: "error"; verdict: CheckVerdict };
type ResolveBoundaries = { kind: "boundaries"; modality: "video"; boundaries: MediaBoundary[]; fallbackNote: string | null };
type ResolveParts = { kind: "parts"; modality: Modality; parts: Part[] };
type ResolveResult = ResolveError | ResolveBoundaries | ResolveParts;

/** One seam's visual evidence: how to build its combined pair image, whatever kind of parts it joins. */
type MediaBoundary = {
  label: string;
  build: (ffmpeg: string, outPath: string, root: string, env: Record<string, string>, signal?: AbortSignal) => Promise<boolean>;
};

function errVerdict(detail: string): ResolveError {
  return { kind: "error", verdict: { outcome: "error", exitCode: null, detail, output: null } };
}

function failVerdict(detail: string): ResolveError {
  return { kind: "error", verdict: { outcome: "fail", exitCode: null, detail, output: null } };
}

/** Scene detection over one video file: the existing fallback, producing labelled timestamp boundaries. */
async function sceneDetectionBoundaries(
  root: string,
  videoAbs: string,
  bins: { ffmpeg: string; ffprobe: string },
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  t: (zh: string, en: string) => string,
): Promise<ResolveBoundaries | ResolveError> {
  const probe = await runProcess(
    bins.ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoAbs],
    { cwd: root, env, timeoutMs: FFMPEG_STEP_TIMEOUT_MS, signal },
  );
  const duration = Number.parseFloat(probe.stdout.trim());
  if (probe.code !== 0 || !Number.isFinite(duration) || duration <= 0) {
    return errVerdict(t("读不出这个视频", "could not read the video"));
  }

  const sceneTimeoutMs = Math.max(FFMPEG_STEP_TIMEOUT_MS, Math.ceil(duration * 1000) + FFMPEG_STEP_TIMEOUT_MS);
  const scene = await runProcess(
    bins.ffmpeg,
    ["-i", videoAbs, "-vf", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, "-f", "null", "-"],
    { cwd: root, env, timeoutMs: sceneTimeoutMs, signal },
  );
  const cuts = [...scene.stderr.matchAll(/pts_time:([\d.]+)/g)]
    .map((match) => Number.parseFloat(match[1]!))
    .filter((cut) => Number.isFinite(cut) && cut > 0 && cut < duration);
  if (cuts.length === 0) {
    return errVerdict(
      t(
        "场景检测没有找到剪切点：要么只有一个镜头，要么镜头之间太相近；给这条检查加一条列出各部分顺序的命令会更准",
        "scene detection found no cuts: either one shot, or shots too alike to tell apart; give this check a command that lists the parts in order",
      ),
    );
  }

  const fallbackNote = t(
    "用的是场景检测，相近的镜头之间可能漏判（实测这部片子 11 个交界只找到 6 个）",
    "used scene detection; a cut between similar-looking shots can be missed (measured 6 of 11 cuts on the real episode)",
  );
  const boundaries: MediaBoundary[] = cuts.map((cut) => {
    const before = Math.max(0, cut - SCENE_HALF_WINDOW_SEC);
    const after = Math.min(duration, cut + SCENE_HALF_WINDOW_SEC);
    return {
      label: `${before.toFixed(2)}s→${after.toFixed(2)}s`,
      build: async (ffmpeg, outPath, cwd, procEnv, sig) => {
        const frameA = outPath.replace(/_pair\.jpg$/, "_a.jpg");
        const frameB = outPath.replace(/_pair\.jpg$/, "_b.jpg");
        const okA = await extractFrame(
          [ffmpeg, "-y", "-loglevel", "error", "-ss", before.toFixed(3), "-i", videoAbs, "-frames:v", "1", "-vf", `scale=${FRAME_SCALE}`, frameA],
          cwd,
          procEnv,
          sig,
        );
        const okB =
          okA &&
          (await extractFrame(
            [ffmpeg, "-y", "-loglevel", "error", "-ss", after.toFixed(3), "-i", videoAbs, "-frames:v", "1", "-vf", `scale=${FRAME_SCALE}`, frameB],
            cwd,
            procEnv,
            sig,
          ));
        return okB && (await extractFrame([ffmpeg, "-y", "-loglevel", "error", "-i", frameA, "-i", frameB, "-filter_complex", "hstack", outPath], cwd, procEnv, sig));
      },
    };
  });
  return { kind: "boundaries", modality: "video", boundaries, fallbackNote };
}

/**
 * Resolves the ordered parts (or, for a single video with no shot list, the scene-detected
 * boundaries) a check names. Every filesystem access is jail-checked; nothing outside `root` is
 * ever read or run.
 */
async function resolveParts(
  root: string,
  check: AcceptanceCheck,
  bins: { ffmpeg: string; ffprobe: string } | null,
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  t: (zh: string, en: string) => string,
): Promise<ResolveResult> {
  const hadCommand = Boolean((check.command ?? "").trim());
  const listed = hadCommand ? await partsListFromCommand(root, check, env, signal) : null;

  if (listed) {
    const exts = listed.map((rel) => extOf(rel.split("/").pop() ?? rel));
    const modalities = new Set(exts.map((ext) => modalityOfExt(ext)));
    if (modalities.size !== 1 || modalities.has(null)) {
      return errVerdict(t("命令列出的各部分类型不一致或不支持", "the command listed parts of mixed or unsupported types"));
    }
    const modality = [...modalities][0]!;
    const parts: Part[] = listed.map((rel) => ({ label: partLabel(rel), abs: join(root, rel), text: null }));
    if (modality === "text") {
      for (let i = 0; i < parts.length; i++) {
        const text = readPartText(parts[i]!.abs!, exts[i]!);
        if (text === null) return errVerdict(t(`读不了这个文件：${listed[i]}`, `could not read: ${listed[i]}`));
        parts[i]!.text = text;
      }
    }
    return { kind: "parts", modality, parts };
  }

  if (!check.path) return errVerdict(t("这条检查没有写路径或命令", "no path or command set on this check"));

  if (isGlobPattern(check.path)) {
    const matches = collectGlobMatches(root, check.path);
    if (matches.length === 0) return failVerdict(t(`没有匹配到文件：${check.path}`, `no file matches: ${check.path}`));
    const modalities = new Set(matches.map((match) => modalityOfExt(extOf(match.name))));
    if (modalities.size !== 1 || modalities.has(null)) {
      return errVerdict(t("匹配到的各部分类型不一致或不支持", "the matched parts are of mixed or unsupported types"));
    }
    const modality = [...modalities][0]!;

    if (modality === "video" && !hadCommand) {
      // Newest-only: a re-cut master that keeps getting replaced under a wildcard name.
      if (!bins) return errVerdict(t("需要 ffmpeg", "ffmpeg is required"));
      const best = matches.reduce((a, b) => (b.mtimeMs > a.mtimeMs || (b.mtimeMs === a.mtimeMs && b.name > a.name) ? b : a));
      return sceneDetectionBoundaries(root, best.abs, bins, env, signal, t);
    }

    const sorted = [...matches].sort((a, b) => naturalCompare(a.name, b.name));
    if (sorted.length < 2) return errVerdict(t("匹配到的部分不到 2 个", "fewer than 2 parts matched"));
    const parts: Part[] = sorted.map((match) => ({ label: partLabel(match.rel), abs: match.abs, text: null }));
    if (modality === "text") {
      for (let i = 0; i < parts.length; i++) {
        const text = readPartText(parts[i]!.abs!, extOf(sorted[i]!.name));
        if (text === null) return errVerdict(t(`读不了这个文件：${sorted[i]!.rel}`, `could not read: ${sorted[i]!.rel}`));
        parts[i]!.text = text;
      }
    }
    return { kind: "parts", modality, parts };
  }

  // A literal path: one file, possibly split into parts of its own.
  const resolved = resolveNewestMatch(root, check.path);
  if (!resolved) return failVerdict(t(`没有这个文件：${check.path}`, `no such file: ${check.path}`));
  const ext = extOf(resolved.rel);
  const modality = modalityOfExt(ext);

  if (modality === "video") {
    if (!bins) return errVerdict(t("需要 ffmpeg", "ffmpeg is required"));
    return sceneDetectionBoundaries(root, resolved.abs, bins, env, signal, t);
  }
  if (modality === "image") {
    return errVerdict(
      t("一张图片切不出多个部分，给一个通配或列出各部分顺序的命令", "a single image is not multiple parts; give a glob or a command that lists the parts in order"),
    );
  }
  if (modality === "text") {
    let raw: string;
    try {
      const stat = statSync(resolved.abs);
      if (stat.size > TEXT_READ_MAX) return errVerdict(t("文件太大", "the file is too large"));
      raw = readFileSync(resolved.abs, "utf8");
    } catch {
      return errVerdict(t("读不了这个文件", "could not read the file"));
    }
    const fallbackLabel = partLabel(resolved.rel);
    const sections = ext === "html" || ext === "htm" ? splitHtmlSections(raw, fallbackLabel) : splitHeadingSections(raw, fallbackLabel);
    if (sections.length < 2) {
      return errVerdict(
        t(
          "这个文件切不出至少 2 个部分：按一级或二级标题（# / ##）分节，或改用能匹配多个文件的通配、或一条列出各部分顺序的命令",
          "could not split this file into at least 2 parts: add level-1 or level-2 headings (# / ##), or use a glob that matches several files, or a command that lists the parts in order",
        ),
      );
    }
    const parts: Part[] = sections.map((section) => ({ label: section.heading, abs: null, text: section.body }));
    return { kind: "parts", modality: "text", parts };
  }
  return errVerdict(t("不支持的文件类型", "unsupported file type"));
}

/**
 * Evaluates one `continuity` (衔接一致 / "Seams") acceptance check for real: resolves its ordered
 * parts (or a single video's scene-detected boundaries), builds each seam's evidence, hands it to
 * the judge in batches, folds a text check's whole-set digest pass in, and combines everything
 * into one verdict. `deps.judge` is the only side effect not performed here — everything else
 * (ffmpeg, ffprobe, the filesystem) runs for real, jailed to `root`.
 */
export async function runSeamsCheck(root: string, check: AcceptanceCheck, deps: SeamsDeps): Promise<CheckVerdict> {
  const locale = deps.locale ?? "zh";
  const t = say(locale);
  const env = deps.env ?? checkEnv(process.env);
  const bins = resolveFfmpegBins(env);

  const resolved = await resolveParts(root, check, bins, env, deps.signal, t);
  if (resolved.kind === "error") return resolved.verdict;

  const checksDir = join(root, deps.planDir, "checks", check.id);

  let mediaBoundaries: MediaBoundary[];
  let fallbackNote: string | null;
  let textParts: Part[] | null = null;

  if (resolved.kind === "boundaries") {
    mediaBoundaries = resolved.boundaries;
    fallbackNote = resolved.fallbackNote;
  } else {
    fallbackNote = null;
    const parts = resolved.parts;
    if (resolved.modality === "text") {
      textParts = parts;
      mediaBoundaries = [];
    } else {
      if (!bins) return { outcome: "error", exitCode: null, detail: t("需要 ffmpeg", "ffmpeg is required"), output: null };
      const isVideo = resolved.modality === "video";
      mediaBoundaries = [];
      for (let i = 0; i < parts.length - 1; i++) {
        const a = parts[i]!;
        const b = parts[i + 1]!;
        mediaBoundaries.push({
          label: `${a.label}→${b.label}`,
          build: async (ffmpeg, outPath, cwd, procEnv, sig) => {
            if (!isVideo) {
              const filter = `[0:v]scale=${IMAGE_PAIR_SCALE}[a];[1:v]scale=${IMAGE_PAIR_SCALE}[b];[a][b]hstack`;
              return extractFrame([ffmpeg, "-y", "-loglevel", "error", "-i", a.abs!, "-i", b.abs!, "-filter_complex", filter, outPath], cwd, procEnv, sig);
            }
            const frameA = outPath.replace(/_pair\.jpg$/, "_a.jpg");
            const frameB = outPath.replace(/_pair\.jpg$/, "_b.jpg");
            const okA = await extractFrame(
              [ffmpeg, "-y", "-loglevel", "error", "-sseof", `-${TAIL_OFFSET_SEC}`, "-i", a.abs!, "-frames:v", "1", "-vf", `scale=${FRAME_SCALE}`, frameA],
              cwd,
              procEnv,
              sig,
            );
            const okB = okA && (await extractFrame([ffmpeg, "-y", "-loglevel", "error", "-i", b.abs!, "-frames:v", "1", "-vf", `scale=${FRAME_SCALE}`, frameB], cwd, procEnv, sig));
            return okB && (await extractFrame([ffmpeg, "-y", "-loglevel", "error", "-i", frameA, "-i", frameB, "-filter_complex", "hstack", outPath], cwd, procEnv, sig));
          },
        });
      }
    }
  }

  if (mediaBoundaries.length === 0 && !textParts) {
    return { outcome: "error", exitCode: null, detail: t("没有找到衔接处", "no seams were found"), output: null };
  }

  const lines: string[] = [];
  const failing: string[] = [];
  let seamCount = 0;

  if (mediaBoundaries.length > 0) {
    try {
      mkdirSync(checksDir, { recursive: true });
    } catch {
      return { outcome: "error", exitCode: null, detail: t("建不出检查目录", "could not create the check's folder"), output: null };
    }

    const images: SeamImageEvidence[] = [];
    const pairPaths: string[] = [];
    for (let i = 0; i < mediaBoundaries.length; i++) {
      const boundary = mediaBoundaries[i]!;
      const n = i + 1;
      const padded = String(n).padStart(2, "0");
      const pairOut = join(checksDir, `${padded}_pair.jpg`);
      const ok = await boundary.build(bins!.ffmpeg, pairOut, root, env, deps.signal);
      if (!ok || !existsSync(pairOut)) {
        return { outcome: "error", exitCode: null, detail: t(`第 ${n} 处衔接抽帧失败`, `could not build evidence for seam ${n}`), output: null };
      }
      images.push({ kind: "image", n, dataUri: `data:image/jpeg;base64,${readFileSync(pairOut).toString("base64")}` });
      pairPaths.push(posixRel(root, pairOut));
    }

    const batched = await judgeSeamBatches(deps, check, locale, t, images, SEAM_MEDIA_BATCH_MAX);
    if ("error" in batched) return batched.error;
    seamCount += mediaBoundaries.length;

    for (let i = 0; i < mediaBoundaries.length; i++) {
      const n = i + 1;
      const boundary = mediaBoundaries[i]!;
      const verdict = batched.verdictByN.get(n);
      const ok = verdict?.ok === true;
      const issues = verdict?.issues ?? [];
      const issueText = issues.map((issue) => issue.replace(/[。．.]+$/u, "")).join(t("；", "; "));
      if (!ok) failing.push(`${boundary.label}${t("：", ": ")}${issueText || t("没说明具体问题", "no specific issue given")}`);
      lines.push(`${boundary.label} ${pairPaths[i]} ${ok ? t("连贯", "ok") : issueText || t("不连贯", "not ok")}`);
    }
    if (fallbackNote) lines.push(fallbackNote);
  }

  let overallFailed = false;
  let overallIssueText = "";
  if (textParts) {
    const parts = textParts;
    const textEvidence: SeamTextEvidence[] = [];
    for (let i = 0; i < parts.length - 1; i++) {
      const n = i + 1;
      const label = `${parts[i]!.label}→${parts[i + 1]!.label}`;
      textEvidence.push({
        kind: "text",
        n,
        label,
        before: lastCodePoints(parts[i]!.text ?? "", TEXT_EXCERPT_MAX),
        after: firstCodePoints(parts[i + 1]!.text ?? "", TEXT_EXCERPT_MAX),
      });
    }

    const batched = await judgeSeamBatches(deps, check, locale, t, textEvidence, SEAM_TEXT_BATCH_MAX);
    if ("error" in batched) return batched.error;
    seamCount += textEvidence.length;

    for (let i = 0; i < textEvidence.length; i++) {
      const n = i + 1;
      const evidence = textEvidence[i]!;
      const verdict = batched.verdictByN.get(n);
      const ok = verdict?.ok === true;
      const issues = verdict?.issues ?? [];
      const issueText = issues.map((issue) => issue.replace(/[。．.]+$/u, "")).join(t("；", "; "));
      if (!ok) failing.push(`${evidence.label}${t("：", ": ")}${issueText || t("没说明具体问题", "no specific issue given")}`);
      lines.push(`${evidence.label} ${ok ? t("连贯", "ok") : issueText || t("不连贯", "not ok")}`);
    }

    const digest = buildWholeSetDigest(parts, locale);
    const overallResult = await judgeOverall(deps, check, locale, t, digest);
    if ("error" in overallResult) return overallResult.error;
    overallFailed = !overallResult.overall.ok;
    overallIssueText = overallResult.overall.issues.map((issue) => issue.replace(/[。．.]+$/u, "")).join(t("；", "; "));
    lines.push(overallResult.overall.ok ? t("整体：一致", "Overall: consistent") : t(`整体：${overallIssueText}`, `Overall: ${overallIssueText}`));
  }

  const output = lines.join("\n");
  const outcome = failing.length > 0 || overallFailed ? "fail" : "pass";
  if (outcome === "pass") {
    return { outcome: "pass", exitCode: null, detail: t(`${seamCount} 处衔接都衔接得上`, `all ${seamCount} seams hold together`), output };
  }
  const segments: string[] = [];
  if (failing.length > 0) {
    segments.push(
      t(
        `${seamCount} 处衔接里 ${failing.length} 处有问题：${failing.slice(0, 3).join("；")}`,
        `${failing.length} of ${seamCount} seams have a problem: ${failing.slice(0, 3).join("; ")}`,
      ),
    );
  }
  if (overallFailed) segments.push(t(`整体不一致：${overallIssueText}`, `overall inconsistency: ${overallIssueText}`));
  return { outcome: "fail", exitCode: null, detail: segments.join(t("；", "; ")), output };
}

type BatchResult = { verdictByN: Map<number, JudgePair> } | { error: CheckVerdict };

async function judgeSeamBatches(
  deps: SeamsDeps,
  check: AcceptanceCheck,
  locale: Locale,
  t: (zh: string, en: string) => string,
  evidence: readonly (SeamImageEvidence | SeamTextEvidence)[],
  batchMax: number,
): Promise<BatchResult> {
  const verdictByN = new Map<number, JudgePair>();
  for (let start = 0; start < evidence.length; start += batchMax) {
    const batch = evidence.slice(start, start + batchMax);
    let parsed: ParsedSeamsAnswer | null = null;
    for (let attempt = 0; attempt < 2 && !parsed?.pairs; attempt++) {
      let raw: string;
      try {
        raw = await deps.judge(batch, deps.rules, check.item, locale, deps.sessionId);
      } catch (error) {
        return { error: { outcome: "error", exitCode: null, detail: error instanceof Error ? error.message : t("模型调用失败", "the model call failed"), output: null } };
      }
      parsed = parseSeamsJudgeAnswer(raw);
    }
    if (!parsed?.pairs) {
      return { error: { outcome: "error", exitCode: null, detail: t("模型的回答解析不出来", "could not parse the model's answer"), output: null } };
    }
    for (const pair of parsed.pairs) verdictByN.set(pair.n, pair);
  }
  return { verdictByN };
}

type OverallResult = { overall: JudgeOverall } | { error: CheckVerdict };

async function judgeOverall(
  deps: SeamsDeps,
  check: AcceptanceCheck,
  locale: Locale,
  t: (zh: string, en: string) => string,
  digest: string,
): Promise<OverallResult> {
  let parsed: ParsedSeamsAnswer | null = null;
  for (let attempt = 0; attempt < 2 && !parsed?.overall; attempt++) {
    let raw: string;
    try {
      raw = await deps.judge([{ kind: "digest", text: digest }], deps.rules, check.item, locale, deps.sessionId);
    } catch (error) {
      return { error: { outcome: "error", exitCode: null, detail: error instanceof Error ? error.message : t("模型调用失败", "the model call failed"), output: null } };
    }
    parsed = parseSeamsJudgeAnswer(raw);
  }
  if (!parsed?.overall) {
    return { error: { outcome: "error", exitCode: null, detail: t("模型的回答解析不出来（整体核对）", "could not parse the model's answer (whole-set check)"), output: null } };
  }
  return { overall: parsed.overall };
}
