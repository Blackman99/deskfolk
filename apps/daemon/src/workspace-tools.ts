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
import { type Store } from "./store";
import { classifyPath, classifyShell } from "./workspace-paths";

const READ_BYTES_MAX = 1_000_000;

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
};

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
  const cwd = optionalString(args.cwd) ?? ".";
  const classified = classifyShell(root, command, cwd);
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
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    ctx.signal.removeEventListener("abort", abort);
    if (ctx.signal.aborted) return fail("failed", "interrupted");
    return ok({ exit_code: exit, stdout, stderr });
  } catch {
    return fail("failed", "shell failed");
  }
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
