/**
 * Where the user's own Claude Code lives, when they tell us (ADR 0061). Nothing else about Claude
 * Code is stored: Deskfolk runs it and asks it about itself, it never keeps its credentials.
 */
import { HttpError } from "../errors";
import { setSetting, type StoreContext } from "./shared";

const KEY = "claude_code_path";
/** Long enough for any real path, short enough that a pasted blob is refused. */
const PATH_MAX = 1024;

/** The `claude` executable you pointed at, or null to let the daemon look for one. */
export function claudeCodePath(ctx: StoreContext): string | null {
  const value = ctx.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(KEY)?.value ?? "";
  return value.trim() ? value.trim() : null;
}

/**
 * An absolute path (or one under `~/`) to keep, or null / "" to forget it. Windows spellings count
 * too: `C:\…`, `\\server\share\…`, `~\…`.
 */
export function setClaudeCodePath(ctx: StoreContext, value: unknown): string | null {
  if (value === null || (typeof value === "string" && value.trim() === "")) {
    setSetting(ctx, KEY, "");
    return null;
  }
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "path must be a string or null");
  const trimmed = value.trim();
  if (trimmed.length > PATH_MAX) throw new HttpError(422, "invalid_args", "path is too long");
  if (!/^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(trimmed)) {
    throw new HttpError(422, "invalid_args", "path must be absolute");
  }
  setSetting(ctx, KEY, trimmed);
  return trimmed;
}
