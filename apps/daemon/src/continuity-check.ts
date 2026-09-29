/**
 * The `continuity` acceptance check: the app's own proof that a multi-shot video holds together
 * across every cut, not just inside each shot. Written after a maintainer's own AI video job kept
 * shipping 11-shot episodes where a reviewer Bot passed every shot alone while the style jumped
 * from realistic 3D to 2D, a face changed race, a mechanical arm swapped sides, a door's side
 * flipped against the corridor, a crawl direction reversed against a door, a transition went
 * missing, or content repeated — every one of those is a *between-shots* problem no single-shot
 * review ever catches.
 *
 * Boundaries come from an ordered shot list when the check names a `command` that produces one (a
 * precise cut between each adjacent pair of real shot files), or from ffmpeg's own scene detection
 * over a single video when it does not — which can miss a cut between two similar-looking shots.
 * Each boundary's frame-before/frame-after pair is combined into one image under
 * `<plan dir>/checks/<check id>/`, and handed to a vision model (in batches) alongside the plan's
 * own rules and a fixed checklist. `judge` is injected so tests can fake the model; everything
 * else here — glob resolution, scene detection, frame extraction, batching, strict JSON parsing
 * with one retry — is real and runs against real ffmpeg.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AcceptanceCheck, Locale } from "@real-bot/protocol";
import type { CheckVerdict } from "./acceptance-eval";
import { checkEnv } from "./acceptance-eval";
import { globToRegExp, isGlobPattern, splitGlobDir } from "./glob";
import { classifyPath, classifyShell } from "./workspace-paths";

/** One boundary's combined pair image, ready to send: its 1-based position and a data URI. */
export type ContinuityImage = { n: number; dataUri: string };

/**
 * One batch's raw call to the vision model — at most {@link CONTINUITY_BATCH_MAX} pair images,
 * the plan's own rules, the acceptance line this check proves, and the plan's session (for spend
 * attribution; null when the session is gone). Returns the model's raw answer text; parsing (and
 * the one retry on an unparsable answer) happens in this file, not inside the judge, so a test
 * fake only ever has to hand back canned text.
 */
export type JudgeContinuity = (
  images: readonly ContinuityImage[],
  rules: readonly string[],
  item: string,
  locale: Locale,
  sessionId: string | null,
) => Promise<string>;

export type ContinuityDeps = {
  judge: JudgeContinuity;
  rules: readonly string[];
  /** The plan dir, workspace-relative (`work/foo-1a2b`) — pair images land under its `checks/` subdir. */
  planDir: string;
  /** The plan's session, for the judge call's spend attribution. */
  sessionId: string | null;
  locale?: Locale;
  signal?: AbortSignal;
  env?: Record<string, string>;
};

/** Pairs per call to the judge; more than this splits into several calls. */
export const CONTINUITY_BATCH_MAX = 6;
/** The judge's own per-call timeout — a caller wiring the real model in reads this. */
export const CONTINUITY_JUDGE_TIMEOUT_MS = 120_000;

const FRAME_SCALE = "640:-1";
const SCENE_THRESHOLD = "0.20";
const SCENE_HALF_WINDOW_SEC = 0.08;
const TAIL_OFFSET_SEC = 0.1;
const FFMPEG_STEP_TIMEOUT_MS = 30_000;
const SHOT_LIST_TIMEOUT_MS = 60_000;

const CHECKLIST_ZH = [
  "画风与渲染",
  "人物面孔（人种、发型、服装）、义肢左右",
  "空间方位（例如门在通道正面还是侧面）与背景光源",
  "运动与视线方向",
  "动作衔接（缺的过渡动作要点名）",
  "内容重复",
];
const CHECKLIST_EN = [
  "art style and rendering",
  "character faces (ethnicity, hair, clothing), and left/right of any prosthetic limb",
  "spatial layout (e.g. whether a door faces the corridor or sits to its side) and background lighting",
  "motion and gaze direction",
  "missing action beats between shots (name what transition is missing)",
  "repeated content",
];

function say(locale: Locale): (zh: string, en: string) => string {
  return (zh, en) => (locale === "en" ? en : zh);
}

/** The system prompt sent with every judge call: the acceptance line, the plan's rules, the fixed checklist, and the strict JSON contract. */
export function continuityJudgePrompt(item: string, rules: readonly string[], locale: Locale): string {
  const zh = locale !== "en";
  const checklist = zh ? CHECKLIST_ZH : CHECKLIST_EN;
  const checklistText = checklist.map((line, i) => `${i + 1}. ${line}`).join("\n");
  if (zh) {
    const rulesText = rules.length ? rules.map((rule) => `- ${rule}`).join("\n") : "（这个规划没有定过额外规则）";
    return [
      `你在核对一部多镜头视频每个剪切点前后的连贯性，为这条验收作证：${item}`,
      `这个规划定过的规则：\n${rulesText}`,
      `每张图是一个剪切点前后两帧拼接而成（左边是剪切前，右边是剪切后）。逐条对照检查：\n${checklistText}`,
      `只输出 JSON，不要 markdown 围栏，不要前言后语：{"pairs":[{"n":1,"ok":true,"issues":[]}]}。n 是图的序号，ok 是这一处是否连贯，issues 是具体问题的一句话列表（连贯时给空数组）。`,
    ].join("\n\n");
  }
  const rulesText = rules.length ? rules.map((rule) => `- ${rule}`).join("\n") : "(this plan has no extra rules)";
  return [
    `You are checking shot-to-shot continuity across every cut of a multi-shot video, to prove this acceptance line: ${item}`,
    `Rules this plan has settled on:\n${rulesText}`,
    `Each image is the frame just before and just after one cut, side by side (left is before, right is after). Check each of the following:\n${checklistText}`,
    `Answer with JSON only, no markdown fences, no preamble: {"pairs":[{"n":1,"ok":true,"issues":[]}]}. n is the image's number, ok is whether that cut holds together, issues is a list of one-line problems (an empty array when it is fine).`,
  ].join("\n\n");
}

type JudgePair = { n: number; ok: boolean; issues: string[] };

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/** Strict: valid JSON, a `pairs` array, at least one usable entry. Anything else is "could not parse". */
export function parseContinuityJudgeAnswer(raw: string): JudgePair[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const pairsRaw = (parsed as Record<string, unknown>).pairs;
  if (!Array.isArray(pairsRaw)) return null;
  const pairs: JudgePair[] = [];
  for (const entry of pairsRaw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.n !== "number" || typeof row.ok !== "boolean") continue;
    const issues = Array.isArray(row.issues) ? row.issues.filter((issue): issue is string => typeof issue === "string") : [];
    pairs.push({ n: row.n, ok: row.ok, issues });
  }
  return pairs.length > 0 ? pairs : null;
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
  const { dir, filePattern } = splitGlobDir(pattern);
  let dirClassified;
  try {
    dirClassified = classifyPath(root, dir);
  } catch {
    return null;
  }
  if (dirClassified.zone !== "inside") return null;
  let entries: string[];
  try {
    entries = readdirSync(dirClassified.abs);
  } catch {
    return null;
  }
  const regex = globToRegExp(filePattern);
  let best: { abs: string; rel: string; name: string; mtimeMs: number } | null = null;
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
    if (!best || stat.mtimeMs > best.mtimeMs || (stat.mtimeMs === best.mtimeMs && name > best.name)) {
      best = { abs: classified.abs, rel: classified.rel, name, mtimeMs: stat.mtimeMs };
    }
  }
  return best ? { abs: best.abs, rel: best.rel } : null;
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

/** Basename without its extension — the label an adjacent-pair boundary reads by when a shot list is known. */
function shotLabel(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The ordered shot files a check's `command` names, one per line of its stdout, each resolved
 * against `cwd` and jail-checked. Null when there is no command, it is not jailed, it exits
 * non-zero, or fewer than two files survive — any of which falls the caller back to scene
 * detection on `path`.
 */
async function shotListFromCommand(
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
  const result = await runProcess("/bin/sh", ["-c", command], { cwd: classified.cwdAbs, env, timeoutMs: SHOT_LIST_TIMEOUT_MS, signal });
  if (result.code !== 0) return null;
  const shots: string[] = [];
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
    shots.push(candClassified.rel);
  }
  return shots.length >= 2 ? shots : null;
}

type Boundary = {
  label: string;
  frameAArgs: (ffmpeg: string, out: string) => string[];
  frameBArgs: (ffmpeg: string, out: string) => string[];
};

/**
 * Evaluates one `continuity` check for real: resolves its shot list or its single video, extracts
 * every boundary's frame pair, hands them to the vision model in batches, and folds the answers
 * into one verdict. `deps.judge` is the only side effect not performed here — everything else
 * (ffmpeg, ffprobe, the filesystem) runs for real, jailed to `root`.
 */
export async function runContinuityCheck(
  root: string,
  check: AcceptanceCheck,
  deps: ContinuityDeps,
): Promise<CheckVerdict> {
  const locale = deps.locale ?? "zh";
  const t = say(locale);
  const env = deps.env ?? checkEnv(process.env);

  const bins = resolveFfmpegBins(env);
  if (!bins) return { outcome: "error", exitCode: null, detail: t("需要 ffmpeg", "ffmpeg is required"), output: null };

  const checksDir = join(root, deps.planDir, "checks", check.id);
  try {
    mkdirSync(checksDir, { recursive: true });
  } catch {
    return { outcome: "error", exitCode: null, detail: t("建不出检查目录", "could not create the check's folder"), output: null };
  }

  const shots = check.command ? await shotListFromCommand(root, check, env, deps.signal) : null;
  const boundaries: Boundary[] = [];
  let fallbackNote: string | null = null;

  if (shots) {
    for (let i = 0; i < shots.length - 1; i++) {
      const a = shots[i]!;
      const b = shots[i + 1]!;
      const aAbs = join(root, a);
      const bAbs = join(root, b);
      boundaries.push({
        label: `${shotLabel(a)}→${shotLabel(b)}`,
        frameAArgs: (ffmpeg, out) => [ffmpeg, "-y", "-loglevel", "error", "-sseof", `-${TAIL_OFFSET_SEC}`, "-i", aAbs, "-frames:v", "1", "-vf", `scale=${FRAME_SCALE}`, out],
        frameBArgs: (ffmpeg, out) => [ffmpeg, "-y", "-loglevel", "error", "-i", bAbs, "-frames:v", "1", "-vf", `scale=${FRAME_SCALE}`, out],
      });
    }
  } else {
    if (!check.path) return { outcome: "error", exitCode: null, detail: t("这条检查没有写视频路径", "no video path set on this check"), output: null };
    const resolved = resolveNewestMatch(root, check.path);
    if (!resolved) return { outcome: "fail", exitCode: null, detail: t(`没有匹配到文件：${check.path}`, `no file matches: ${check.path}`), output: null };

    const probe = await runProcess(
      bins.ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", resolved.abs],
      { cwd: root, env, timeoutMs: FFMPEG_STEP_TIMEOUT_MS, signal: deps.signal },
    );
    const duration = Number.parseFloat(probe.stdout.trim());
    if (probe.code !== 0 || !Number.isFinite(duration) || duration <= 0) {
      return { outcome: "error", exitCode: null, detail: t("读不出这个视频", "could not read the video"), output: null };
    }

    const sceneTimeoutMs = Math.max(FFMPEG_STEP_TIMEOUT_MS, Math.ceil(duration * 1000) + FFMPEG_STEP_TIMEOUT_MS);
    const scene = await runProcess(
      bins.ffmpeg,
      ["-i", resolved.abs, "-vf", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, "-f", "null", "-"],
      { cwd: root, env, timeoutMs: sceneTimeoutMs, signal: deps.signal },
    );
    const cuts = [...scene.stderr.matchAll(/pts_time:([\d.]+)/g)]
      .map((match) => Number.parseFloat(match[1]!))
      .filter((cut) => Number.isFinite(cut) && cut > 0 && cut < duration);
    if (cuts.length === 0) return { outcome: "error", exitCode: null, detail: t("场景检测没有找到剪切点：要么只有一个镜头，要么镜头之间太相近；给这条检查加一条列出镜头顺序的命令会更准", "scene detection found no cuts: either one shot, or shots too alike to tell apart; give this check a command that lists the shots in order"), output: null };

    fallbackNote = t(
      "用的是场景检测，相近的镜头之间可能漏判（实测这部片子 11 个交界只找到 6 个）",
      "used scene detection; a cut between similar-looking shots can be missed (measured 6 of 11 cuts on the real episode)",
    );
    for (const cut of cuts) {
      const before = Math.max(0, cut - SCENE_HALF_WINDOW_SEC);
      const after = Math.min(duration, cut + SCENE_HALF_WINDOW_SEC);
      boundaries.push({
        label: `${before.toFixed(2)}s→${after.toFixed(2)}s`,
        frameAArgs: (ffmpeg, out) => [ffmpeg, "-y", "-loglevel", "error", "-ss", before.toFixed(3), "-i", resolved.abs, "-frames:v", "1", "-vf", `scale=${FRAME_SCALE}`, out],
        frameBArgs: (ffmpeg, out) => [ffmpeg, "-y", "-loglevel", "error", "-ss", after.toFixed(3), "-i", resolved.abs, "-frames:v", "1", "-vf", `scale=${FRAME_SCALE}`, out],
      });
    }
  }

  if (boundaries.length === 0) return { outcome: "error", exitCode: null, detail: t("没有找到剪切点", "no cuts were found"), output: null };

  const images: ContinuityImage[] = [];
  const pairPaths: string[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i]!;
    const n = i + 1;
    const padded = String(n).padStart(2, "0");
    const frameA = join(checksDir, `${padded}_a.jpg`);
    const frameB = join(checksDir, `${padded}_b.jpg`);
    const pairOut = join(checksDir, `${padded}_pair.jpg`);
    const okA = await extractFrame(boundary.frameAArgs(bins.ffmpeg, frameA), root, env, deps.signal);
    const okB = okA && (await extractFrame(boundary.frameBArgs(bins.ffmpeg, frameB), root, env, deps.signal));
    const okPair =
      okB && (await extractFrame([bins.ffmpeg, "-y", "-loglevel", "error", "-i", frameA, "-i", frameB, "-filter_complex", "hstack", pairOut], root, env, deps.signal));
    if (!okPair || !existsSync(pairOut)) {
      return { outcome: "error", exitCode: null, detail: t(`第 ${n} 处剪切点抽帧失败`, `could not extract frames for cut ${n}`), output: null };
    }
    images.push({ n, dataUri: `data:image/jpeg;base64,${readFileSync(pairOut).toString("base64")}` });
    pairPaths.push(posixRel(root, pairOut));
  }

  const verdictByN = new Map<number, JudgePair>();
  for (let start = 0; start < images.length; start += CONTINUITY_BATCH_MAX) {
    const batch = images.slice(start, start + CONTINUITY_BATCH_MAX);
    let parsed: JudgePair[] | null = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      let raw: string;
      try {
        raw = await deps.judge(batch, deps.rules, check.item, locale, deps.sessionId);
      } catch (error) {
        return { outcome: "error", exitCode: null, detail: error instanceof Error ? error.message : t("模型调用失败", "the model call failed"), output: null };
      }
      parsed = parseContinuityJudgeAnswer(raw);
    }
    if (!parsed) return { outcome: "error", exitCode: null, detail: t("模型的回答解析不出来", "could not parse the model's answer"), output: null };
    for (const pair of parsed) verdictByN.set(pair.n, pair);
  }

  const lines: string[] = [];
  const failing: string[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const n = i + 1;
    const boundary = boundaries[i]!;
    const verdict = verdictByN.get(n);
    const ok = verdict?.ok === true;
    const issues = verdict?.issues ?? [];
    const issueText = issues.join(t("、", ", "));
    if (!ok) failing.push(`${boundary.label} ${issueText || t("没说明具体问题", "no specific issue given")}`);
    lines.push(`${boundary.label} ${pairPaths[i]} ${ok ? t("连贯", "ok") : issueText || t("不连贯", "not ok")}`);
  }
  if (fallbackNote) lines.push(fallbackNote);
  const output = lines.join("\n");

  if (failing.length === 0) {
    return { outcome: "pass", exitCode: null, detail: t(`${boundaries.length} 个交界都连贯`, `all ${boundaries.length} cuts hold together`), output };
  }
  const detail = t(
    `${boundaries.length} 个交界里 ${failing.length} 个有问题：${failing.slice(0, 3).join("；")}`,
    `${failing.length} of ${boundaries.length} cuts have a problem: ${failing.slice(0, 3).join("; ")}`,
  );
  return { outcome: "fail", exitCode: null, detail, output };
}
