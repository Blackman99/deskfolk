/**
 * Why the runtime is or is not up, in a file you can read afterwards.
 *
 * The window says only "can't reach the runtime", which is the same sentence for every reason it
 * cannot connect. When the daemon dies before it listens — a database it cannot open, a port it
 * cannot take — that sentence is all anybody gets: the process is gone, its stderr went wherever
 * the supervisor sent it, and nothing is left to read. This file is the fixed place to look.
 *
 * It holds starts, refusals and fatal errors. It never holds the local token, an endpoint key or
 * anything else secret: callers pass the line, and no caller passes one.
 */
import { appendFileSync, chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir } from "./descriptor";

export const STARTUP_LOG_NAME = "daemon.log";

/** Small enough to read in one sitting, large enough to hold a few crash loops. */
export const STARTUP_LOG_MAX_BYTES = 64 * 1024;

export function startupLogPath(dataDir: string): string {
  return join(dataDir, STARTUP_LOG_NAME);
}

/**
 * Appends one timestamped line. Logging is never the reason a start fails, so every error here is
 * swallowed: a daemon that cannot write its log still has a runtime to bring up.
 */
export function logStartup(dataDir: string, line: string): void {
  try {
    ensureDataDir(dataDir);
    const path = startupLogPath(dataDir);
    appendFileSync(path, `${new Date().toISOString()} ${oneLine(line)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    trim(path);
  } catch {
    // best effort
  }
}

/** The message and the top of the stack, bounded — enough to name the cause, not a core dump. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const frames = (error.stack ?? "")
    .split("\n")
    .slice(1, 4)
    .map((frame) => frame.trim())
    .filter(Boolean);
  return frames.length > 0 ? `${error.message} | ${frames.join(" | ")}` : error.message;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Keeps the newest half once the file grows past the cap, cut at a line boundary. */
function trim(path: string): void {
  if (statSync(path).size <= STARTUP_LOG_MAX_BYTES) return;
  const text = readFileSync(path, "utf8");
  const tail = text.slice(-Math.floor(STARTUP_LOG_MAX_BYTES / 2));
  const cut = tail.indexOf("\n");
  writeFileSync(path, cut === -1 ? tail : tail.slice(cut + 1), { mode: 0o600 });
  chmodSync(path, 0o600);
}
