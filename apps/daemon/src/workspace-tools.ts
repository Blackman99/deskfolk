import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ToolResult } from "./collab-tools";
import { atomicWrite, withFileLock } from "./file-integrity";
import { HttpError } from "./errors";
import { isReservedTaskPath, type Store } from "./store";
import { skipName } from "./workspace-browse";
import { classifyPath, classifyShell } from "./workspace-paths";
import { COMMAND_STREAM_BYTES } from "./streams";

const READ_BYTES_MAX = 1_000_000;

/**
 * What a `shell` produced. `write_file` announces its own path; a command does not, so the files
 * downloads, renders and conversions leave behind used to be invisible to the message that should
 * have cited them. The work dir makes looking affordable: one bounded walk of one folder, rather
 * than of the whole workspace.
 */
const WORK_SCAN_DEPTH = 2;
/** Past this the walk is not worth reporting: `npm install` is not a list of artifacts. */
const WORK_SCAN_MAX = 200;

export const WORKSPACE_TOOL_NAMES = [
  "read_file",
  "write_file",
  "delete_file",
  "list_dir",
  "shell",
] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export function isWorkspaceTool(name: string): name is WorkspaceToolName {
  return (WORKSPACE_TOOL_NAMES as readonly string[]).includes(name);
}

export type WorkspaceToolCtx = {
  store: Store;
  signal: AbortSignal;
  /**
   * This turn's work dir, workspace-relative. It is where a `shell` with no `cwd` runs, which is
   * what keeps downloads, renders and script output out of the workspace root without the model
   * having to cooperate. File tool paths are unaffected: they stay relative to the workspace root,
   * so `read_file("x")` and `write_file("x")` never point at two different places.
   */
  workDir?: string | null;
  /** Overrides {@link SHELL_TIMEOUT_MS}; tests use a short one. */
  shellTimeoutMs?: number;
  /**
   * Where a running command's output goes while it runs. Visibility only: it does not change what
   * a `shell` is. stdin stays closed, the timeout still kills, and the path check still happens
   * once per spawn. Absent in tests that do not care.
   */
  stream?: ShellStream;
  /** This call's stream id, `<turn_id>:<tool_call_id>`. Without it nothing is streamed. */
  streamId?: string;
};

/** The slice of the daemon's stream hub a command needs. */
export type ShellStream = {
  open: (id: string, limit?: number) => void;
  push: (id: string, bytes: Uint8Array) => void;
  close: (id: string) => void;
};

/**
 * A shell that never returns used to wedge the whole turn: `proc.exited` and the output pipes are
 * awaited, and a backgrounded grandchild keeps those pipes open even after the shell itself exits.
 * Long enough for a render, short enough that the turn comes back.
 */
export const SHELL_TIMEOUT_MS = 10 * 60_000;

export async function runWorkspaceTool(
  ctx: WorkspaceToolCtx,
  name: string,
  args: Record<string, unknown>,
  opts: { approved?: boolean } = {},
): Promise<ToolResult> {
  try {
    const root = ctx.store.workspacePath();
    if (!root) return fail("failed", "workspace is not set");
    switch (name) {
      case "read_file":
        return readFile(root, args, opts, ctx);
      case "write_file":
        return writeFile(root, args, opts, ctx);
      case "delete_file":
        return deleteFile(root, args, opts, ctx);
      case "list_dir":
        return listDir(root, args, opts, ctx);
      case "shell":
        return runShell(root, args, opts, ctx);
      default:
        return fail("failed", `unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof HttpError) return fail(error.code, error.message);
    return fail("failed", "tool failed");
  }
}

function readFile(
  root: string,
  args: Record<string, unknown>,
  opts: { approved?: boolean },
  ctx: WorkspaceToolCtx,
): ToolResult {
  const input = requireString(args.path, "path");
  const classified = classifyPath(root, input);
  if (classified.zone === "outside") {
    const pending = needsApproval(opts, "outside-read", classified.abs, `outside-read ${classified.abs}`, ctx, "read_file", args);
    if (pending) return pending;
  }
  if (ctx.signal.aborted) return fail("failed", "interrupted");
  try {
    const st = statSync(classified.abs);
    if (st.isDirectory()) return fail("failed", "path is a directory");
    if (st.size > READ_BYTES_MAX) return fail("too_large", "file is too large");
    const buf = readFileSync(classified.abs);
    if (buf.byteLength > READ_BYTES_MAX) return fail("too_large", "file is too large");
    let content: string;
    try {
      content = new TextDecoder("utf8", { fatal: true }).decode(buf);
    } catch {
      return fail("not_text", "file is not UTF-8 text");
    }
    return ok({ path: replyPath(classified), content });
  } catch (error) {
    if (isNotFound(error)) return fail("not_found", "file not found");
    return fail("failed", "read failed");
  }
}

function writeFile(
  root: string,
  args: Record<string, unknown>,
  opts: { approved?: boolean },
  ctx: WorkspaceToolCtx,
): ToolResult {
  const input = requireString(args.path, "path");
  const content = requireString(args.content, "content");
  const classified = classifyPath(root, input);
  if (classified.zone === "outside") {
    const pending = needsApproval(
      opts,
      "outside-write",
      classified.abs,
      `outside-write ${classified.abs}`,
      ctx,
      "write_file",
      args,
    );
    if (pending) return pending;
  }
  if (ctx.signal.aborted) return fail("failed", "interrupted");
  const abs = classified.abs;
  try {
    if (existsAsDir(abs)) return fail("failed", "path is a directory");
    mkdirSync(dirname(abs), { recursive: true });
    atomicWrite(abs, content);
    return ok({ path: replyPath(classified) });
  } catch {
    return fail("failed", "write failed");
  }
}

function deleteFile(
  root: string,
  args: Record<string, unknown>,
  opts: { approved?: boolean },
  ctx: WorkspaceToolCtx,
): ToolResult {
  const input = requireString(args.path, "path");
  const recursive = args.recursive === true;
  const classified = classifyPath(root, input);
  if (classified.zone === "outside") {
    const pending = needsApproval(
      opts,
      "outside-write",
      classified.abs,
      `outside-write ${classified.abs}`,
      ctx,
      "delete_file",
      args,
    );
    if (pending) return pending;
  }
  if (ctx.signal.aborted) return fail("failed", "interrupted");
  try {
    return withFileLock(classified.abs, () => {
      const st = lstatSync(classified.abs);
      if (st.isDirectory()) {
        const empty = readdirSync(classified.abs).length === 0;
        if (!empty && !recursive) return fail("failed", "directory is not empty");
        rmSync(classified.abs, { recursive: true });
      } else {
        unlinkSync(classified.abs);
      }
      return ok({ path: replyPath(classified) });
    });
  } catch (error) {
    if (isNotFound(error)) return fail("not_found", "path not found");
    return fail("failed", "delete failed");
  }
}

function listDir(
  root: string,
  args: Record<string, unknown>,
  opts: { approved?: boolean },
  ctx: WorkspaceToolCtx,
): ToolResult {
  const input = optionalString(args.path) ?? ".";
  const recursive = args.recursive === true;
  const classified = classifyPath(root, input);
  if (classified.zone === "outside") {
    const pending = needsApproval(opts, "outside-read", classified.abs, `outside-read ${classified.abs}`, ctx, "list_dir", args);
    if (pending) return pending;
  }
  if (ctx.signal.aborted) return fail("failed", "interrupted");
  try {
    const st = statSync(classified.abs);
    if (!st.isDirectory()) return fail("failed", "path is not a directory");
    const entries = collectEntries(
      root,
      classified.abs,
      classified.zone === "inside" ? classified.rel : classified.abs,
      recursive,
      classified.zone,
    );
    return ok({ path: replyPath(classified), entries });
  } catch (error) {
    if (isNotFound(error)) return fail("not_found", "path not found");
    return fail("failed", "list failed");
  }
}

async function runShell(
  root: string,
  args: Record<string, unknown>,
  opts: { approved?: boolean },
  ctx: WorkspaceToolCtx,
): Promise<ToolResult> {
  const command = requireString(args.command, "command");
  const explicitCwd = optionalString(args.cwd);
  const cwd = explicitCwd ?? ctx.workDir ?? ".";
  const classified = classifyShell(root, command, cwd);
  // The work dir is created here rather than up front: a turn that only talks should not leave an
  // empty folder behind, but a cwd that does not exist fails the spawn.
  if (!explicitCwd && ctx.workDir && classified.kind === "jailed") {
    try {
      mkdirSync(classified.cwdAbs, { recursive: true });
    } catch {
      return fail("failed", "could not create the work dir");
    }
  }
  if (classified.kind === "unconstrained") {
    const pending = needsApproval(
      opts,
      "unconstrained-shell",
      classified.cwdAbs,
      `unconstrained-shell ${command}`,
      ctx,
      "shell",
      args,
    );
    if (pending) return pending;
  }
  if (ctx.signal.aborted) return fail("failed", "interrupted");
  const before = snapshotWorkDir(root, ctx.workDir);
  const streaming = Boolean(ctx.stream && ctx.streamId);
  if (streaming) ctx.stream!.open(ctx.streamId!, COMMAND_STREAM_BYTES);
  try {
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: classified.cwdAbs,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const abort = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already exited
      }
    };
    if (ctx.signal.aborted) {
      abort();
      return fail("failed", "interrupted");
    }
    ctx.signal.addEventListener("abort", abort, { once: true });
    const timeoutMs = ctx.shellTimeoutMs ?? SHELL_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Raced rather than awaited after the kill: a grandchild that inherited stdout keeps the pipes
    // open for as long as it lives, so reading them to the end is not something to wait on.
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already exited
        }
        resolve("timeout");
      }, timeoutMs);
    });
    // Read both pipes as they fill rather than after the fact: the whole point is that a ten
    // minute build is visible while it runs. Still raced rather than awaited — see above.
    const drain = async (pipe: ReadableStream<Uint8Array>): Promise<string> => {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of pipe) {
        text += decoder.decode(chunk, { stream: true });
        if (streaming) ctx.stream?.push(ctx.streamId!, chunk);
      }
      return text + decoder.decode();
    };
    const settled = await Promise.race([
      Promise.all([drain(proc.stdout), drain(proc.stderr), proc.exited]),
      expired,
    ]);
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", abort);
    if (ctx.signal.aborted) return fail("failed", "interrupted");
    if (settled === "timeout") {
      return fail("failed", `command timed out after ${Math.round(timeoutMs / 1000)}s and was killed`);
    }
    const [stdout, stderr, exit] = settled;
    const produced = producedPaths(root, ctx.workDir, before);
    return ok({ exit_code: exit, stdout, stderr, ...produced });
  } catch {
    return fail("failed", "shell failed");
  } finally {
    if (streaming) ctx.stream!.close(ctx.streamId!);
  }
}

/**
 * Every file in the work dir, two levels deep, with what its mtime was. Reserved subdirs and the
 * usual noise are skipped, and a folder with more than {@link WORK_SCAN_MAX} entries reports
 * nothing at all rather than a list nobody wants.
 */
function snapshotWorkDir(root: string, workDir: string | null | undefined): Map<string, number> | null {
  if (!workDir) return null;
  const base = classifyPath(root, workDir);
  if (base.zone !== "inside") return null;
  const seen = new Map<string, number>();
  const walk = (absDir: string, rel: string, depth: number): boolean => {
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch {
      return true;
    }
    for (const name of names) {
      if (skipName(name)) continue;
      const childRel = `${rel}/${name}`;
      if (isReservedTaskPath(workDir, `${childRel}/`)) continue;
      let stat;
      try {
        stat = statSync(join(absDir, name));
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth >= WORK_SCAN_DEPTH) continue;
        if (!walk(join(absDir, name), childRel, depth + 1)) return false;
        continue;
      }
      if (seen.size >= WORK_SCAN_MAX) return false;
      seen.set(childRel, stat.mtimeMs);
    }
    return true;
  };
  return walk(base.abs, workDir, 1) ? seen : null;
}

/** New or rewritten since the snapshot. A null snapshot means the walk was not worth reporting. */
function producedPaths(
  root: string,
  workDir: string | null | undefined,
  before: Map<string, number> | null,
): { paths?: string[]; paths_truncated?: true } {
  if (!workDir) return {};
  const after = snapshotWorkDir(root, workDir);
  if (!after || !before) return { paths_truncated: true };
  const paths: string[] = [];
  for (const [path, mtime] of after) {
    if (before.get(path) === mtime) continue;
    paths.push(path);
  }
  return paths.length > 0 ? { paths: paths.sort() } : {};
}

function collectEntries(
  root: string,
  absDir: string,
  listedPath: string,
  recursive: boolean,
  zone: "inside" | "outside",
): Array<{ name: string; kind: "file" | "dir"; path: string }> {
  const names = readdirSync(absDir);
  names.sort();
  const out: Array<{ name: string; kind: "file" | "dir"; path: string }> = [];
  for (const name of names) {
    const childAbs = join(absDir, name);
    const childPath =
      zone === "inside"
        ? listedPath === "."
          ? name
          : `${listedPath}/${name}`
        : `${listedPath.replace(/\/$/, "")}/${name}`;
    let kind: "file" | "dir" = "file";
    try {
      if (statSync(childAbs).isDirectory()) kind = "dir";
    } catch {
      kind = "file";
    }
    out.push({ name, kind, path: childPath });
    if (!recursive || kind !== "dir") continue;
    const childZone = classifyPath(root, childAbs).zone;
    if (zone === "inside" && childZone === "outside") continue;
    out.push(...collectEntries(root, childAbs, childPath, true, zone));
  }
  return out;
}

function needsApproval(
  opts: { approved?: boolean },
  kind_key: string,
  target: string,
  summary: string,
  ctx: WorkspaceToolCtx,
  name: string,
  args: Record<string, unknown>,
): ToolResult | null {
  if (opts.approved) return null;
  if (ctx.store.matchesAllowRule(kind_key, target)) return null;
  return {
    ok: false,
    waitApproval: {
      kind_key,
      target,
      summary,
      run: () => runWorkspaceTool(ctx, name, args, { approved: true }),
    },
    emitted: [],
  };
}

function replyPath(classified: { zone: "inside"; rel: string } | { zone: "outside"; abs: string }): string {
  return classified.zone === "inside" ? classified.rel : classified.abs;
}

function existsAsDir(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(422, "invalid_args", `${field} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "expected a string");
  return value;
}

function ok(data: Record<string, unknown>): ToolResult {
  return { ok: true, data, emitted: [] };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message }, emitted: [] };
}
