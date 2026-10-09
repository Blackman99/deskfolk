/**
 * Where the user's own Claude Code lives, when they tell us, and the config directories their
 * Claude accounts live in (ADR 0061). Nothing else about Claude Code is stored: Deskfolk runs it and
 * asks it about itself, it never keeps its credentials.
 */
import { CLAUDE_CONFIG_DIRS_MAX, normalizeConfigDir, sameConfigDir, tildeDir, tooWideForConfigDir } from "../claude-code/account";
import { HttpError } from "../errors";
import { setSetting, type StoreContext } from "./shared";

const KEY = "claude_code_path";
const DIRS_KEY = "claude_code_config_dirs";
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

/** The config directories of the Claude accounts you listed, besides the daemon's own environment. */
export function claudeCodeConfigDirs(ctx: StoreContext): string[] {
  const raw = ctx.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(DIRS_KEY)?.value ?? "";
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((dir): dir is string => typeof dir === "string" && dir.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * The whole list, as the Settings card sends it after an add or a removal: each an absolute path
 * (or one under `~/`), kept absolute and without a trailing separator, each once. One a Bot runs on
 * stays until that Bot is moved to another account: taking it away would move the Bot's spending
 * without you choosing.
 */
export function setClaudeCodeConfigDirs(ctx: StoreContext, value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(422, "invalid_args", "config_dirs must be a list of paths");
  if (value.length > CLAUDE_CONFIG_DIRS_MAX) throw new HttpError(422, "invalid_args", `at most ${CLAUDE_CONFIG_DIRS_MAX} accounts can be listed`);
  const dirs: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new HttpError(422, "invalid_args", "config_dirs must be a list of paths");
    const dir = normalizeConfigDir(entry);
    if (!dir) throw new HttpError(422, "invalid_args", `${entry.trim().slice(0, 200)} is not an absolute path`);
    if (tooWideForConfigDir(dir)) throw new HttpError(422, "invalid_args", `${tildeDir(dir)} is your home folder or holds it: name the account's own directory, such as ~/.claude-b`);
    if (!dirs.some((kept) => sameConfigDir(kept, dir))) dirs.push(dir);
  }
  const removed = claudeCodeConfigDirs(ctx).filter((dir) => !dirs.some((kept) => sameConfigDir(kept, dir)));
  for (const dir of removed) {
    const users = ctx.db
      .query<{ name: string }, [string]>("SELECT name FROM bots WHERE deleted_at IS NULL AND agent_config_dir = ? ORDER BY name COLLATE NOCASE")
      .all(dir)
      .map((row) => row.name);
    if (users.length > 0) {
      throw new HttpError(409, "conflict", `${tildeDir(dir)} is the Claude account of ${users.join(", ")}: move ${users.length === 1 ? "that Bot" : "those Bots"} to another account first`);
    }
    // Reading lines on it as well: taking it away would move that spending without you choosing.
    const reading = ctx.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'reader_config_dir'").get()?.value ?? "";
    if (reading && sameConfigDir(reading, dir)) {
      throw new HttpError(409, "conflict", `${tildeDir(dir)} is the Claude account lines are read on: choose another reader model or account first`);
    }
    // A rung of the model ladder spends it too (ADR 0076).
    if (ladderConfigDirs(ctx).some((used) => sameConfigDir(used, dir))) {
      throw new HttpError(409, "conflict", `${tildeDir(dir)} is the Claude account of a rung on the model ladder: take that rung off or move it to another account first`);
    }
  }
  setSetting(ctx, DIRS_KEY, dirs.length > 0 ? JSON.stringify(dirs) : "");
  return dirs;
}

/** The accounts the model ladder's Claude rungs spend (ADR 0076). */
export function ladderConfigDirs(ctx: StoreContext): string[] {
  try {
    const rungs = JSON.parse(ctx.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'model_ladder'").get()?.value || "[]") as unknown;
    return Array.isArray(rungs)
      ? rungs.flatMap((rung) => (rung && rung.runner === "claude_code" && typeof rung.config_dir === "string" ? [rung.config_dir as string] : []))
      : [];
  } catch {
    return [];
  }
}

/**
 * A config directory a request names for a Claude account: null or "" for the daemon's own
 * environment, otherwise one of the listed directories, kept as the list keeps it.
 */
export function listedConfigDir(ctx: StoreContext, value: unknown, field: string): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return null;
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", `${field} must be a string or null`);
  const dir = normalizeConfigDir(value);
  const listed = dir ? claudeCodeConfigDirs(ctx).find((kept) => sameConfigDir(kept, dir)) : undefined;
  if (!listed) throw new HttpError(422, "invalid_args", `${field} must be one of the Claude accounts listed in Settings`);
  return listed;
}
