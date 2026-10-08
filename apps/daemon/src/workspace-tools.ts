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
import { toolFail as fail } from "./tool-result";
import { atomicWrite, withFileLock } from "./file-integrity";
import { HttpError } from "./errors";
import { killProcessTree, toolShell } from "./platform";
import { recordLiveProc, signalGroup, stopGroup } from "./live-procs";
import { commandSignature, recursiveSearchGuard, searchGuardMessage } from "./search-guard";
import { isReservedTaskPath, type Store } from "./store";
import { skipName } from "./workspace-browse";
import { classifyPath, classifyShell } from "./workspace-paths";
import { COMMAND_STREAM_BYTES } from "./streams";
import { LOOP_PICTURE_BYTES_MAX, pictureMime } from "./loop-pictures";
import { visionImage } from "./vision-image";
import type { WakeWatch } from "./wake";

const READ_BYTES_MAX = 1_000_000;
/** A picture is shrunk before it is shown, so a 4K PNG frame is still worth reading. */
const PICTURE_READ_BYTES_MAX = 50_000_000;

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
  /** Whose command a `shell` spawn is, for its `live_procs` row. */
  turnId?: string;
  toolCallId?: string;
  /** Durable host evidence immediately before a write/delete/spawn, including approved callbacks. */
  onEffectStart?: (tool: "write_file" | "delete_file" | "shell") => void;
  /** Overrides the 3 s a stop leaves between SIGTERM and SIGKILL (`GROUP_STOP_GRACE_MS`); tests use a short one. */
  stopGraceMs?: number;
  /** With it the shell timeout counts only time the Mac was awake; a shut lid froze the command too. */
  wake?: WakeWatch;
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
        // Awaited here, so a refusal it throws before it spawns (its effect evidence, say) is a tool error.
        return await runShell(root, args, opts, ctx);
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
    const reply = replyPath(classified);
    const pending = classified.zone === "inside" ? ctx.store.openAnnotationCount(classified.rel) : 0;
    const mime = pictureMime(classified.abs);
    if (mime) {
      // The pixels go to the model after the hop's tool results; the result itself only names them.
      if (st.size > PICTURE_READ_BYTES_MAX) return fail("too_large", "image is too large");
      const shown = visionImage(classified.abs, mime, st);
      if (shown.bytes.byteLength > LOOP_PICTURE_BYTES_MAX) return fail("too_large", "image is too large to show");
      return {
        ...ok({ path: reply, mime: shown.mime, ...annotationHint(pending) }),
        picture: { path: reply, mime: shown.mime, bytes: shown.bytes },
      };
    }
    if (st.size > READ_BYTES_MAX) return fail("too_large", "file is too large");
    const buf = readFileSync(classified.abs);
    if (buf.byteLength > READ_BYTES_MAX) return fail("too_large", "file is too large");
    let content: string;
    try {
      content = new TextDecoder("utf8", { fatal: true }).decode(buf);
    } catch {
      return fail("not_text", "file is not UTF-8 text");
    }
    return ok({ path: reply, content, ...annotationHint(pending) });
  } catch (error) {
    if (isNotFound(error)) return fail("not_found", "file not found");
    return fail("failed", "read failed");
  }
}

function annotationHint(pending: number): Record<string, unknown> {
  if (pending === 0) return {};
  return {
    pending_annotations: pending,
    hint: `这个文件有 ${pending} 条待处理批注，用 list_annotations 查看。 / This file has ${pending} pending annotation(s); list_annotations shows them.`,
  };
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
  if (existsAsDir(abs)) return fail("failed", "path is a directory");
  const stray = classified.zone === "inside" ? strayTicketFolder(root, classified.rel, ctx) : null;
  if (stray) return fail("invalid_args", stray);
  ctx.onEffectStart?.("write_file");
  try {
    mkdirSync(dirname(abs), { recursive: true });
    atomicWrite(abs, content);
    return ok({ path: replyPath(classified) });
  } catch {
    return fail("failed", "write failed");
  }
}

/**
 * A job's ticket folders are `work/<job>/NN-<title, cut short>`. A folder of that shape in a job
 * that no ticket has, and that is not there yet, is one built from a title instead of read from the
 * situation: on 2026-10-04's real-model run a Bot rewrote plan.md into `01-…每天一个主题/` — its
 * ticket's folder is `01-…每天一个/` — then handed in the untouched one, and the card asked you to
 * approve a change that was not in it. Said, with the job's real folders, before anything is written.
 */
function strayTicketFolder(root: string, rel: string, ctx: WorkspaceToolCtx): string | null {
  const parts = rel.split("/");
  if (parts.length < 4 || parts[0] !== "work" || !/^\d{2}-/.test(parts[2]!)) return null;
  const planDir = parts.slice(0, 2).join("/");
  const folder = `${planDir}/${parts[2]}`;
  if (existsAsDir(join(root, folder))) return null;
  const tickets = ctx.store.db.query<{ dir: string }, [string]>(
    "SELECT t.dir FROM tickets t JOIN tasks k ON k.id = t.task_id WHERE k.dir = ? ORDER BY t.seq").all(planDir);
  if (tickets.length === 0 || tickets.some((ticket) => ticket.dir === folder)) return null;
  const yours = ctx.workDir && ctx.workDir !== planDir ? ` This turn's ticket folder is ${ctx.workDir}/.` : "";
  return `${folder}/ is no ticket's folder in this job; its ticket folders are ${tickets.map((ticket) => `${ticket.dir}/`).join(", ")}.${yours} Use the folder the situation names, not one built from a ticket's title.`;
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
      if (st.isDirectory() && readdirSync(classified.abs).length > 0 && !recursive) return fail("failed", "directory is not empty");
      ctx.onEffectStart?.("delete_file");
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
    // Its effect evidence refused it (held, already started): said as that, nothing was deleted.
    if (error instanceof HttpError) return fail(error.code, error.message);
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
  // The approval gate reads paths the way the shell that runs them will: Git Bash's `/c/x` is
  // `C:\x`, PowerShell's is `C:\c\x`.
  const shell = toolShell();
  const classified = classifyShell(root, command, cwd, undefined, shell.kind);
  // Ahead of approval and of any always-allow rule (ADR 0040 P1, fixture F-g): a recursive search
  // rooted at the whole home folder or at `/` is refused before it runs, not after it is granted.
  if (shell.kind === "sh") {
    const hit = recursiveSearchGuard(root, command, classified.cwdAbs);
    if (hit) return fail("refused", searchGuardMessage(hit));
  }
  // What the app learned from a timeout of this kind of command (ADR 0050, level 8): a warning
  // holds it back once per turn, a block always.
  let lesson: { signature: string; head: string; place: string; botId: string | null; overriding: string | null } | null = null;
  if (shell.kind === "sh" && ctx.turnId && ctx.store.learningOn()) {
    const kind = commandSignature(root, command, classified.cwdAbs, ctx.workDir ?? null);
    // Only a search that walks a tree is learned from: a render or a build running long is not a mistake.
    if (kind?.walks) {
      let botId: string | null = null;
      try {
        botId = ctx.store.getTurn(ctx.turnId).bot_id;
      } catch {
        botId = null;
      }
      const check = ctx.store.checkShellLesson({ workspace: root, turnId: ctx.turnId, botId, signature: kind.signature });
      if (check.refuse !== null) return fail("refused", check.refuse);
      lesson = { signature: kind.signature, head: kind.head, place: kind.place, botId, overriding: check.overriding };
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
  // The work dir is created here rather than up front: a turn that only talks should not leave an
  // empty folder behind, but a cwd that does not exist fails the spawn. A command run in it gets it,
  // whether it names it as its cwd or not, and one that reaches outside gets it once you let it
  // through: a new job's first command is often the copy of a file from elsewhere, and it used to
  // fail to start after your OK.
  if (ctx.workDir && (!explicitCwd || classified.cwdAbs === classifyPath(root, ctx.workDir).abs)) {
    try {
      mkdirSync(classified.cwdAbs, { recursive: true });
    } catch {
      return fail("failed", "could not create the work dir");
    }
  }
  if (ctx.signal.aborted) return fail("failed", "interrupted");
  const before = snapshotWorkDir(root, ctx.workDir);
  const streaming = Boolean(ctx.stream && ctx.streamId);
  ctx.onEffectStart?.("shell");
  if (streaming) ctx.stream!.open(ctx.streamId!, COMMAND_STREAM_BYTES);
  try {
    const posix = process.platform !== "win32";
    const proc = Bun.spawn(shell.argv(command), {
      cwd: classified.cwdAbs,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // A process group of its own, so a stop or the timeout reaches everything the command
      // started, not just the shell (ADR 0040 I10): `sh -c "… ffmpeg …"` used to stop only the sh
      // and leave the ffmpeg under it writing. win32 has no groups; killProcessTree walks the tree.
      detached: posix,
    });
    const pgid = posix ? proc.pid : null;
    const killNow = () => {
      if (pgid === null) killProcessTree(proc.pid);
      else signalGroup(pgid, "SIGKILL");
    };
    try {
      recordLiveProc(ctx.store, proc, { pgid, turnId: ctx.turnId, toolCallId: ctx.toolCallId, command });
    } catch {
      // Off the record, nothing could stop it after a crash; it does not get to run.
      killNow();
      return fail("failed", "shell failed");
    }
    // A stop returns at once rather than when the pipes drain: whatever is still in the group has
    // its SIGKILL coming, and the turn being stopped should not wait on it.
    let interrupted = () => {};
    const stopped = new Promise<"interrupted">((resolve) => {
      interrupted = () => resolve("interrupted");
    });
    const abort = () => {
      if (pgid === null) killProcessTree(proc.pid);
      else void stopGroup(pgid, ctx.stopGraceMs);
      interrupted();
    };
    if (ctx.signal.aborted) {
      abort();
      return fail("failed", "interrupted");
    }
    ctx.signal.addEventListener("abort", abort, { once: true });
    const timeoutMs = ctx.shellTimeoutMs ?? SHELL_TIMEOUT_MS;
    let cancelTimeout = () => {};
    // Raced rather than awaited after the kill: a grandchild that inherited stdout keeps the pipes
    // open for as long as it lives, so reading them to the end is not something to wait on.
    const expired = new Promise<"timeout">((resolve) => {
      const kill = () => {
        killNow();
        resolve("timeout");
      };
      if (ctx.wake) {
        cancelTimeout = ctx.wake.awakeTimeout(timeoutMs, kill);
      } else {
        const timer = setTimeout(kill, timeoutMs);
        cancelTimeout = () => clearTimeout(timer);
      }
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
      stopped,
    ]);
    cancelTimeout();
    ctx.signal.removeEventListener("abort", abort);
    if (settled === "interrupted" || ctx.signal.aborted) return fail("failed", "interrupted");
    if (settled === "timeout") {
      if (lesson) {
        try {
          ctx.store.noteShellTimeout({ workspace: root, turnId: ctx.turnId ?? null, botId: lesson.botId, signature: lesson.signature, head: lesson.head,
            place: lesson.place, seconds: Math.round(timeoutMs / 1000), overriding: lesson.overriding });
        } catch {
          // the lesson is best effort; the timeout is reported either way
        }
      }
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
export function snapshotWorkDir(root: string, workDir: string | null | undefined): Map<string, number> | null {
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
export function producedPaths(
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
    // Inside the workspace this is the wire format (always `/`, never the host separator).
    // Outside it, `listedPath` is a host absolute path, so it joins with the host's own separator
    // (`\` on Windows) instead of an assumed `/`.
    const childPath =
      zone === "inside"
        ? listedPath === "."
          ? name
          : `${listedPath}/${name}`
        : join(listedPath, name);
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

