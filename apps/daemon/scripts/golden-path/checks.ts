/**
 * The deterministic half of judging a job: the files it had to hand over are there, say what they
 * must, and the commands the brief promised work when the runner runs them itself. The model judge
 * reads excerpts; these read the whole file and run the code, so "tests pass" means they ran here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileCheck, GoldenTask, VerifyStep } from "./tasks";

export type CheckResult = { name: string; ok: boolean; detail: string; kind: "deliverable" | "content" | "verify" };

/** Line endings and trailing blanks do not count; everything else in the output does. */
export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** Every `contains` substring present, every `matches` found, no `not_matches` found. */
export function checkFileText(body: string, check: FileCheck): CheckResult {
  const problems: string[] = [];
  for (const needle of check.contains) if (!body.includes(needle)) problems.push(`missing ${JSON.stringify(needle)}`);
  for (const source of check.matches) if (!new RegExp(source, "mi").test(body)) problems.push(`no match for /${source}/`);
  for (const source of check.not_matches) if (new RegExp(source, "mi").test(body)) problems.push(`must not match /${source}/`);
  return { name: `${check.path} content`, ok: problems.length === 0, detail: problems.length ? problems.join("; ") : "ok", kind: "content" };
}

export function deliverableResult(path: string, bytes: number | null): CheckResult {
  if (bytes === null) return { name: `${path} delivered`, ok: false, detail: "missing", kind: "deliverable" };
  if (bytes === 0) return { name: `${path} delivered`, ok: false, detail: "empty", kind: "deliverable" };
  return { name: `${path} delivered`, ok: true, detail: `${bytes} bytes`, kind: "deliverable" };
}

const BUN_SUBCOMMANDS = new Set(["test", "run", "x", "install", "add", "remove", "build", "init", "create", "upgrade", "pm", "link", "unlink", "repl", "exec"]);

/** The file a `bun <file> …` step runs; null for `bun test` and other subcommands, or another program. */
export function scriptOf(command: readonly string[]): string | null {
  const [head, first] = command;
  if (head !== "bun" || !first || first.startsWith("-") || BUN_SUBCOMMANDS.has(first)) return null;
  return first;
}

function verifyName(step: VerifyStep): string {
  return `${step.cwd === "." ? "" : `(cd ${step.cwd}) `}${step.command.join(" ")}`;
}

export function verifyResult(step: VerifyStep, run: { exit: number | null; stdout: string; stderr: string; timedOut: boolean }): CheckResult {
  const name = verifyName(step);
  if (run.timedOut) return { name, ok: false, detail: `timed out after ${step.timeout_sec}s` };
  const problems: string[] = [];
  if (run.exit !== step.expect_exit) problems.push(`exit ${run.exit ?? "none"}, expected ${step.expect_exit}`);
  if (step.expect_stdout !== null && normalizeOutput(run.stdout) !== normalizeOutput(step.expect_stdout)) {
    problems.push(`stdout differs: ${JSON.stringify(tail(normalizeOutput(run.stdout), 300))}`);
  }
  if (problems.length > 0 && run.stderr.trim()) problems.push(`stderr: ${JSON.stringify(tail(run.stderr.trim(), 300))}`);
  return { name, ok: problems.length === 0, detail: problems.length ? problems.join("; ") : `exit ${run.exit}`, kind: "verify" };
}

function tail(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `…${chars.slice(-limit).join("")}` : text;
}

/**
 * The environment a verify command gets: enough to find Bun and a locale, nothing of this
 * process's own (keys, `REAL_BOT_*`). Bot-written code runs here, so it gets as little as works.
 */
export function verifyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { NO_COLOR: "1", CI: "1" };
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Runs the task's checks against a workspace the team no longer writes to. */
export function runChecks(task: GoldenTask, workspace: string, bun: string = process.execPath): CheckResult[] {
  const results: CheckResult[] = [];
  for (const path of task.deliverables) {
    const abs = join(workspace, path);
    results.push(deliverableResult(path, existsSync(abs) && statSync(abs).isFile() ? statSync(abs).size : null));
  }
  for (const check of task.checks) {
    const abs = join(workspace, check.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      results.push({ name: `${check.path} content`, ok: false, detail: "missing", kind: "content" });
      continue;
    }
    results.push(checkFileText(readFileSync(abs, "utf8"), check));
  }
  for (const step of task.verify) {
    const cwd = join(workspace, step.cwd);
    if (!existsSync(cwd)) {
      results.push({ name: verifyName(step), ok: false, detail: `no ${step.cwd}/ to run in`, kind: "verify" });
      continue;
    }
    const [head, ...rest] = step.command;
    // `bun <file>` exits 1 when the file is missing too, which would pass a step expecting exit 1.
    const script = scriptOf(step.command);
    if (script && !existsSync(join(cwd, script))) {
      results.push({ name: verifyName(step), ok: false, detail: `${script} is missing`, kind: "verify" });
      continue;
    }
    const run = spawnSync(head === "bun" ? bun : head!, rest, {
      cwd,
      env: verifyEnv(process.env),
      encoding: "utf8",
      timeout: step.timeout_sec * 1000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timedOut = Boolean(run.error && (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT");
    results.push(verifyResult(step, { exit: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "", timedOut }));
  }
  return results;
}
