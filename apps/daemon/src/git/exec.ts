/**
 * Hardened argv-only git process runner for project session Git views (ADR 0118).
 * Never invokes a shell, disables optional locks and repo-controlled hooks/external diff drivers,
 * coalesces identical in-flight queries, and bounds concurrency, runtime, and output bytes.
 */
import { existsSync } from "node:fs";
import { locateAgent } from "../agents/locate";

export type GitExecOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  coalesceKey?: string;
  env?: Record<string, string | undefined>;
};

export type GitExecResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  unavailable?: boolean;
};

export type GitExecutor = (cwd: string, args: readonly string[], opts?: GitExecOptions) => Promise<GitExecResult>;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT = 4;

/** Config flags prepended to every git invocation to prevent repo-controlled code execution. */
export const SAFE_GIT_FLAGS: readonly string[] = [
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "-c", "core.pager=cat",
  "-c", "credential.helper=",
  "-c", "protocol.ext.allow=never",
  "-c", "core.quotepath=false",
];

let cachedGitPath: { path: string | null; error: string | null; checkedAt: number } | null = null;
const GIT_LOCATE_TTL_MS = 60_000;

/**
 * On macOS, `/usr/bin/git` is a stub that pops up an Apple GUI prompt when Command Line Tools are
 * not installed. Check the CLT directories before accepting `/usr/bin/git`.
 */
function macCltAvailable(): boolean {
  if (process.platform !== "darwin") return true;
  if (existsSync("/Library/Developer/CommandLineTools/usr/bin/git")) return true;
  if (existsSync("/Applications/Xcode.app/Contents/Developer/usr/bin/git")) return true;
  const devDir = process.env.DEVELOPER_DIR;
  if (devDir && existsSync(`${devDir}/usr/bin/git`)) return true;
  return false;
}

export async function locateGit(env: Record<string, string | undefined> = process.env): Promise<{ path: string | null; error: string | null }> {
  const now = Date.now();
  if (cachedGitPath && now - cachedGitPath.checkedAt < GIT_LOCATE_TTL_MS) {
    return { path: cachedGitPath.path, error: cachedGitPath.error };
  }
  const located = await locateAgent({ command: "git", setting: null, env });
  let path = located.found?.path ?? null;
  let error = located.error;
  if (path === "/usr/bin/git" && !macCltAvailable()) {
    path = null;
    error = "git requires Xcode Command Line Tools on macOS";
  }
  cachedGitPath = { path, error, checkedAt: now };
  return { path, error };
}

export function resetGitLocationCache(): void {
  cachedGitPath = null;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onExceed?: () => void,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        const remain = Math.max(0, maxBytes - total);
        if (remain > 0) {
          chunks.push(value.subarray(0, remain));
          total += remain;
        }
        truncated = true;
        onExceed?.();
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // Stream aborted after kill or truncation.
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), truncated };
}

/** Creates a shared git executor with concurrency limiting and in-flight coalescing. */
export function createGitExecutor(customLocate?: () => Promise<{ path: string | null; error: string | null }>): GitExecutor {
  const semaphore = new Semaphore(MAX_CONCURRENT);
  const inflight = new Map<string, Promise<GitExecResult>>();

  const execOnce = async (cwd: string, args: readonly string[], opts: GitExecOptions = {}): Promise<GitExecResult> => {
    const located = await (customLocate ? customLocate() : locateGit());
    if (!located.path) {
      return {
        ok: false,
        code: -1,
        stdout: "",
        stderr: located.error ?? "git not found",
        truncated: false,
        timedOut: false,
        unavailable: true,
      };
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const argv = [located.path, ...SAFE_GIT_FLAGS, ...args];

    return semaphore.run(async () => {
      let timedOut = false;
      let killedForSize = false;
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(argv, {
          cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            GIT_DIR: undefined,
            GIT_WORK_TREE: undefined,
            GIT_COMMON_DIR: undefined,
            GIT_INDEX_FILE: undefined,
            ...opts.env,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
            LC_MESSAGES: "C",
          },
        });
      } catch (err) {
        return {
          ok: false,
          code: -1,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          truncated: false,
          timedOut: false,
        };
      }

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, timeoutMs);

      try {
        const [out, err, code] = await Promise.all([
          readBounded(proc.stdout as ReadableStream<Uint8Array> | null, maxBytes, () => {
            killedForSize = true;
            try {
              proc.kill("SIGKILL");
            } catch {
              // ignore
            }
          }),
          readBounded(proc.stderr as ReadableStream<Uint8Array> | null, 64 * 1024),
          proc.exited,
        ]);
        const ok = !timedOut && (code === 0 || (killedForSize && out.truncated));
        return {
          ok,
          code,
          stdout: out.text,
          stderr: err.text.trim(),
          truncated: out.truncated,
          timedOut,
        };
      } finally {
        clearTimeout(timer);
      }
    });
  };

  return (cwd, args, opts) => {
    const key = opts?.coalesceKey;
    if (!key) return execOnce(cwd, args, opts);
    const existing = inflight.get(key);
    if (existing) return existing;
    const promise = execOnce(cwd, args, opts).finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  };
}

/** Shared singleton executor used by daemon routes. */
export const defaultGitExec: GitExecutor = createGitExecutor();

/** Strict validation for commit hashes accepted in query/path parameters. */
export function isValidCommitOid(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

/** Strict validation for repository-relative paths passed after `--`. */
export function isSafeRepoRelPath(value: string): boolean {
  if (!value || value.length > 4096) return false;
  if (value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const parts = value.split(/[\\/]/);
  return !parts.some((part) => part === "..");
}
