/**
 * Hardened argv-only `gh` CLI runner with TTL caching and stale fallback (ADR 0118).
 * Relies strictly on the user's local `gh` authentication; Deskfolk stores no GitHub tokens.
 */
import { locateAgent } from "../agents/locate";

export type GhExecOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  coalesceKey?: string;
};

export type GhExecResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  unavailable?: boolean;
};

export type GhExecutor = (cwd: string, args: readonly string[], opts?: GhExecOptions) => Promise<GhExecResult>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT = 4;
const GH_LOCATE_TTL_MS = 60_000;

let cachedGhPath: { path: string | null; error: string | null; checkedAt: number } | null = null;

export async function locateGh(env: Record<string, string | undefined> = process.env): Promise<{ path: string | null; error: string | null }> {
  const now = Date.now();
  if (cachedGhPath && now - cachedGhPath.checkedAt < GH_LOCATE_TTL_MS) {
    return { path: cachedGhPath.path, error: cachedGhPath.error };
  }
  const located = await locateAgent({ command: "gh", setting: null, env });
  cachedGhPath = { path: located.found?.path ?? null, error: located.error, checkedAt: now };
  return { path: cachedGhPath.path, error: cachedGhPath.error };
}

export function resetGhLocationCache(): void {
  cachedGhPath = null;
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

async function readBounded(stream: ReadableStream<Uint8Array> | null, maxBytes: number, onExceed?: () => void): Promise<{ text: string; truncated: boolean }> {
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
    // ignore
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

export function createGhExecutor(customLocate?: () => Promise<{ path: string | null; error: string | null }>): GhExecutor {
  const semaphore = new Semaphore(MAX_CONCURRENT);
  const inflight = new Map<string, Promise<GhExecResult>>();

  const execOnce = async (cwd: string, args: readonly string[], opts: GhExecOptions = {}): Promise<GhExecResult> => {
    const located = await (customLocate ? customLocate() : locateGh());
    if (!located.path) {
      return {
        ok: false,
        code: -1,
        stdout: "",
        stderr: located.error ?? "gh not found",
        truncated: false,
        timedOut: false,
        unavailable: true,
      };
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const argv = [located.path, ...args];

    return semaphore.run(async () => {
      let timedOut = false;
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(argv, {
          cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            GH_PROMPT_DISABLED: "1",
            NO_COLOR: "1",
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
          // ignore
        }
      }, timeoutMs);

      try {
        const [out, err, code] = await Promise.all([
          readBounded(proc.stdout as ReadableStream<Uint8Array> | null, maxBytes, () => {
            try {
              proc.kill("SIGKILL");
            } catch {
              // ignore
            }
          }),
          readBounded(proc.stderr as ReadableStream<Uint8Array> | null, 64 * 1024),
          proc.exited,
        ]);
        return {
          ok: !timedOut && code === 0,
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

export const defaultGhExec: GhExecutor = createGhExecutor();

/** Lightweight bounded in-memory TTL cache with stale-on-error support. */
export class StaleTtlCache<T> {
  private readonly entries = new Map<string, { value: T; fetchedAt: string; expiresAt: number }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 200) {}

  getFresh(key: string): { value: T; fetchedAt: string } | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) return null;
    return { value: hit.value, fetchedAt: hit.fetchedAt };
  }

  getStale(key: string): { value: T; fetchedAt: string } | null {
    const hit = this.entries.get(key);
    return hit ? { value: hit.value, fetchedAt: hit.fetchedAt } : null;
  }

  set(key: string, value: T, fetchedAt = new Date().toISOString()): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, fetchedAt, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}
