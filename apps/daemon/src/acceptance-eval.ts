/**
 * Running one acceptance check for real: a file on disk, or a command the app spawns itself. A
 * product port of `scripts/golden-path/checks.ts` — that file is the eval harness's own ground
 * truth and must never depend on what ships, so neither file imports the other; the two are kept
 * in step by hand.
 *
 * Nothing outside the workspace runs, and nothing here trusts what the check said about itself
 * when it was defined: `classifyPath`/`classifyShell` re-check at run time, since the workspace can
 * move between a check's definition and the moment it runs. A command runs detached, in its own
 * process group, so a timeout or an abort can kill everything it spawned — not just its own pid.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceCheck, AcceptanceCheckOutcome, Locale } from "@real-bot/protocol";
import { runSeamsCheck, type JudgeSeams } from "./seams-check";
import { ENV_WHITELIST } from "./terminal-env";
import { classifyPath, classifyShell } from "./workspace-paths";
import type { WakeWatch } from "./wake";

export type CheckVerdict = {
  outcome: AcceptanceCheckOutcome;
  exitCode: number | null;
  detail: string;
  /** Tail of what the check produced; the store trims it further before it is kept. */
  output: string | null;
};

/** Code points of captured output kept; matches the store's `CHECK_OUTPUT_MAX`. */
const OUTPUT_TAIL_MAX = 2000;

/** The last `limit` code points, marked when something was cut — the end is what a failure needs. */
function tail(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `…${chars.slice(-(limit - 1)).join("")}` : text;
}

/** Line endings and trailing blanks do not count; everything else in a comparison does. */
export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * The env a check's command gets: the same login-shell whitelist a terminal session gets
 * ({@link ENV_WHITELIST}), minus `SSH_AUTH_SOCK` — a check runs unsupervised — plus `CI`, `NO_COLOR`
 * and a `TERM` no program mistakes for an interactive one. Never anything of the daemon's own
 * (`REAL_BOT_*`, provider keys): those simply are not on the whitelist to begin with.
 */
export function checkEnv(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { CI: "1", NO_COLOR: "1", TERM: "dumb" };
  for (const key of ENV_WHITELIST) {
    if (key === "SSH_AUTH_SOCK") continue;
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  if (out.PATH === undefined) out.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  return out;
}

const BUN_SUBCOMMANDS = new Set(["test", "run", "x", "install", "add", "remove", "build", "init", "create", "upgrade", "pm", "link", "unlink", "repl", "exec"]);
const SCRIPT_RUNNERS = new Set(["bun", "node", "python3"]);

/** A minimal quote-aware split, just enough to pull the first two words off a check's command. */
function firstTokens(command: string, count: number): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
    if (tokens.length >= count && !cur) break;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens.slice(0, count);
}

/**
 * The file a `bun|node|python3 <file>` command would run, so a missing script can be reported
 * plainly instead of by whatever the shell's own "no such file" happens to look like. Null for
 * `bun test` and the other subcommands, or any other program.
 */
export function scriptOf(command: string): string | null {
  const [head, first] = firstTokens(command, 2);
  if (!head || !SCRIPT_RUNNERS.has(head) || !first || first.startsWith("-")) return null;
  if (head === "bun" && BUN_SUBCOMMANDS.has(first)) return null;
  return first;
}

/** Reads run into this Worker rather than the daemon's own thread, so a pathological one only ever hangs itself. */
const MATCH_TIMEOUT_MS = 2_000;

function matchInWorker(pattern: string, body: string): Promise<"match" | "no-match" | "bad-regex" | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./acceptance-match-worker.ts", import.meta.url).href);
    } catch {
      resolve("bad-regex");
      return;
    }
    const finish = (result: "match" | "no-match" | "bad-regex" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        worker.terminate();
      } catch {
        // already gone
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish("timeout"), MATCH_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<{ ok: boolean; matched?: boolean }>) => {
      finish(event.data.ok ? (event.data.matched ? "match" : "no-match") : "bad-regex");
    };
    worker.onerror = () => finish("bad-regex");
    worker.postMessage({ pattern, body });
  });
}

/** A regular file over this reads as `error`, not `fail`: too large to check, not a failed check. */
const FILE_READ_MAX = 1_000_000;

/** `exists` / `contains` / `matches`: read from disk, never spawn anything. */
/**
 * A run's one-line `detail` is shown on the flow board and quoted to the organizer and in call-back
 * notes, so it is written in the app's locale, like every other line the app says.
 */
function sayer(locale: Locale): (zh: string, en: string) => string {
  return (zh, en) => (locale === "en" ? en : zh);
}

export async function evaluateFileCheck(root: string, check: AcceptanceCheck, locale: Locale = "zh"): Promise<CheckVerdict> {
  const say = sayer(locale);
  const path = check.path ?? "";
  if (!path) return { outcome: "error", exitCode: null, detail: say("这条检查没有写路径", "no path set on this check"), output: null };
  let classified;
  try {
    classified = classifyPath(root, path);
  } catch {
    return { outcome: "blocked", exitCode: null, detail: say("在工作区外", "outside the workspace"), output: null };
  }
  if (classified.zone !== "inside") return { outcome: "blocked", exitCode: null, detail: say("在工作区外", "outside the workspace"), output: null };
  let stat;
  try {
    stat = statSync(classified.abs);
  } catch {
    return { outcome: "fail", exitCode: null, detail: say("文件不在", "missing file"), output: null };
  }
  if (!stat.isFile()) return { outcome: "fail", exitCode: null, detail: say("文件不在", "missing file"), output: null };

  if (check.kind === "exists") {
    if (stat.size === 0) return { outcome: "fail", exitCode: null, detail: say("文件是空的", "empty"), output: null };
    return { outcome: "pass", exitCode: null, detail: say(`${stat.size} 字节`, `${stat.size} bytes`), output: null };
  }

  if (stat.size > FILE_READ_MAX) return { outcome: "error", exitCode: null, detail: say("文件超过 1 MB", "file is larger than 1 MB"), output: null };
  let body: string;
  try {
    body = readFileSync(classified.abs, "utf8");
  } catch {
    return { outcome: "error", exitCode: null, detail: say("读不了这个文件", "could not read the file"), output: null };
  }
  const pattern = check.pattern ?? "";

  if (check.kind === "contains") {
    const found = body.includes(pattern);
    const ok = check.negate ? !found : found;
    const quoted = JSON.stringify(pattern);
    const detail = ok
      ? say("对上了", "ok")
      : check.negate
        ? say(`还包含 ${quoted}`, `still contains ${quoted}`)
        : say(`没有 ${quoted}`, `missing ${quoted}`);
    return { outcome: ok ? "pass" : "fail", exitCode: null, detail, output: null };
  }

  // matches
  const matched = await matchInWorker(pattern, body);
  if (matched === "bad-regex") return { outcome: "error", exitCode: null, detail: say("正则写得不对", "pattern does not compile"), output: null };
  if (matched === "timeout") return { outcome: "error", exitCode: null, detail: say("正则跑得太久", "pattern took too long to run"), output: null };
  const found = matched === "match";
  const ok = check.negate ? !found : found;
  const detail = ok
    ? say("对上了", "ok")
    : check.negate
      ? say(`还匹配 /${pattern}/`, `still matches /${pattern}/`)
      : say(`匹配不到 /${pattern}/`, `no match for /${pattern}/`);
  return { outcome: ok ? "pass" : "fail", exitCode: null, detail, output: null };
}

type SpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError: boolean;
};

/** Bytes read from one stream before a check simply stops looking; the run itself is not cut short by it. */
const STREAM_READ_MAX = 1_000_000;

/**
 * `/bin/sh -c command`, detached into its own process group so a timeout or an abort can take the
 * whole tree with it (`process.kill(-pid, …)`), not just the shell itself.
 */
function spawnCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
  wake?: WakeWatch,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let settled = false;
    let cancelTimeout = () => {};
    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish({ exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: false, spawnError: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const killGroup = (signalName: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch {
        try {
          child.kill(signalName);
        } catch {
          // already gone
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= STREAM_READ_MAX) return;
      stdout += chunk.toString("utf8");
      stdoutBytes += chunk.byteLength;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STREAM_READ_MAX) return;
      stderr += chunk.toString("utf8");
      stderrBytes += chunk.byteLength;
    });
    const onTimeout = () => {
      killGroup("SIGKILL");
      finish({ exitCode: null, stdout, stderr, timedOut: true, aborted: false, spawnError: false });
    };
    if (wake) cancelTimeout = wake.awakeTimeout(timeoutMs, onTimeout);
    else {
      const timer = setTimeout(onTimeout, timeoutMs);
      cancelTimeout = () => clearTimeout(timer);
    }
    const onAbort = () => {
      killGroup("SIGKILL");
      finish({ exitCode: null, stdout, stderr, timedOut: false, aborted: true, spawnError: false });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => finish({ exitCode: null, stdout, stderr, timedOut: false, aborted: false, spawnError: true }));
    child.on("exit", (exitCode) => {
      // Anything the command left running in its group dies with it; nothing outlives a check.
      killGroup("SIGKILL");
      finish({ exitCode, stdout, stderr, timedOut: false, aborted: false, spawnError: false });
    });
  });
}

/** `command`: run in `check.cwd`, already resolved by the caller (the runner defaults it; this does not). */
export async function runCommandCheck(
  root: string,
  check: AcceptanceCheck,
  opts: { signal?: AbortSignal; wake?: WakeWatch; env?: Record<string, string>; locale?: Locale },
): Promise<CheckVerdict> {
  const say = sayer(opts.locale ?? "zh");
  const command = check.command ?? "";
  if (!command.trim()) return { outcome: "error", exitCode: null, detail: say("这条检查没有写命令", "no command set on this check"), output: null };
  const cwd = check.cwd ?? ".";
  let classified;
  try {
    classified = classifyShell(root, command, cwd);
  } catch {
    return { outcome: "blocked", exitCode: null, detail: say("在工作区外", "outside the workspace"), output: null };
  }
  if (classified.kind === "unconstrained") return { outcome: "blocked", exitCode: null, detail: say("在工作区外", "outside the workspace"), output: null };
  if (!existsSync(classified.cwdAbs) || !statSync(classified.cwdAbs).isDirectory()) {
    return { outcome: "fail", exitCode: null, detail: say("运行目录不在", "missing cwd"), output: null };
  }
  const script = scriptOf(command);
  if (script && !existsSync(join(classified.cwdAbs, script))) {
    return { outcome: "fail", exitCode: null, detail: say(`${script} 不在`, `${script} is missing`), output: null };
  }

  const timeoutSec = check.timeout_sec ?? 120;
  const env = opts.env ?? checkEnv(process.env);
  const result = await spawnCommand(command, classified.cwdAbs, env, timeoutSec * 1000, opts.signal, opts.wake);
  const combined = normalizeOutput(`${result.stdout}${result.stderr ? (result.stdout ? "\n" : "") + result.stderr : ""}`);
  const output = combined ? tail(combined, OUTPUT_TAIL_MAX) : null;

  if (result.spawnError) return { outcome: "error", exitCode: null, detail: say("命令没能跑起来", "could not run the command"), output };
  if (result.aborted) return { outcome: "error", exitCode: null, detail: say("跑到一半被打断", "interrupted"), output };
  if (result.timedOut) return { outcome: "fail", exitCode: null, detail: say(`${timeoutSec} 秒还没跑完`, `timed out after ${timeoutSec}s`), output };

  const expectExit = check.expect_exit ?? 0;
  const problems: string[] = [];
  if (result.exitCode !== expectExit) problems.push(say(`退出码 ${result.exitCode ?? "无"}，应为 ${expectExit}`, `exit ${result.exitCode ?? "none"}, expected ${expectExit}`));
  if (check.expect_stdout !== null && check.expect_stdout !== undefined) {
    if (normalizeOutput(result.stdout) !== normalizeOutput(check.expect_stdout)) problems.push(say("输出和期望的不一样", "stdout differs from what was expected"));
  }
  const outcome: AcceptanceCheckOutcome = problems.length === 0 ? "pass" : "fail";
  const detail = problems.length > 0 ? problems.join(say("；", "; ")) : say(`退出码 ${result.exitCode}`, `exit ${result.exitCode}`);
  return { outcome, exitCode: result.exitCode, detail, output };
}

/** What a `continuity` (衔接一致 / "Seams") check needs beyond the check row itself: only the engine (which holds the store) has these. */
export type SeamsEvalDeps = {
  /** The plan dir, workspace-relative — where image evidence lands, under its `checks/` subdir. */
  planDir: string;
  /** The plan's own rules (`spec.rules`), sent to the judge alongside the fixed checklist. */
  rules: readonly string[];
  /** The plan's session, for the judge call's spend attribution. */
  sessionId: string | null;
  /** Injectable: the real implementation calls the default endpoint's default model; tests fake it. */
  judge: JudgeSeams;
};

/** Dispatches on `check.kind`. `root` is the workspace's absolute path; null means no workspace is open. */
export async function evaluateCheck(
  root: string | null,
  check: AcceptanceCheck,
  opts: { signal?: AbortSignal; wake?: WakeWatch; env?: Record<string, string>; locale?: Locale; continuity?: SeamsEvalDeps } = {},
): Promise<CheckVerdict> {
  if (!root) return { outcome: "blocked", exitCode: null, detail: sayer(opts.locale ?? "zh")("没有打开工作区", "no workspace is open"), output: null };
  if (check.kind === "command") return runCommandCheck(root, check, opts);
  if (check.kind === "continuity") {
    if (!opts.continuity) {
      return { outcome: "error", exitCode: null, detail: sayer(opts.locale ?? "zh")("衔接检查没有接上判定模型", "seams checks are not wired up here"), output: null };
    }
    return runSeamsCheck(root, check, {
      judge: opts.continuity.judge,
      rules: opts.continuity.rules,
      planDir: opts.continuity.planDir,
      sessionId: opts.continuity.sessionId,
      locale: opts.locale,
      signal: opts.signal,
      env: opts.env,
    });
  }
  return evaluateFileCheck(root, check, opts.locale);
}

/** One line describing what a check verifies, for the plan's mirror files. */
export function describeCheck(
  check: Pick<AcceptanceCheck, "kind" | "path" | "pattern" | "negate" | "command" | "cwd">,
  locale: Locale,
): string {
  const zh = locale === "zh";
  if (check.kind === "exists") return zh ? `文件存在：${check.path ?? ""}` : `File exists: ${check.path ?? ""}`;
  if (check.kind === "contains") {
    return zh
      ? `${check.path ?? ""} ${check.negate ? "不" : ""}包含 "${check.pattern ?? ""}"`
      : `${check.path ?? ""} ${check.negate ? "does not contain" : "contains"} "${check.pattern ?? ""}"`;
  }
  if (check.kind === "matches") {
    return zh
      ? `${check.path ?? ""} ${check.negate ? "不" : ""}匹配 /${check.pattern ?? ""}/`
      : `${check.path ?? ""} ${check.negate ? "does not match" : "matches"} /${check.pattern ?? ""}/`;
  }
  if (check.kind === "continuity") {
    if (check.command) {
      const where = check.cwd ? (zh ? `（在 ${check.cwd}）` : ` (in ${check.cwd})`) : "";
      return zh
        ? `检查 \`${check.command}\`${where} 列出的各部分之间是否衔接一致`
        : `Checks the parts listed by \`${check.command}\`${where} fit together`;
    }
    return zh ? `检查 ${check.path ?? ""} 各部分之间是否衔接一致` : `Checks the parts of ${check.path ?? ""} fit together`;
  }
  const where = check.cwd ? (zh ? `（在 ${check.cwd}）` : ` (in ${check.cwd})`) : "";
  return zh ? `命令：${check.command ?? ""}${where}` : `Command: ${check.command ?? ""}${where}`;
}
