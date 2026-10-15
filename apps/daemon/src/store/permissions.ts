/**
 * Permission modes (ADR 0092): the app's, kept in settings, and the one a Bot may carry instead. The
 * tools ask {@link permissionModeFor} and decide by `permissionVerdict`; only you change either.
 */
import { DEFAULT_PERMISSION_MODE, isPermissionMode, type PermissionMode } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { setSetting, type StoreContext } from "./shared";

const KEY = "permission_mode";

/** The mode every Bot without its own runs in. */
export function appPermissionMode(ctx: StoreContext): PermissionMode {
  const raw = ctx.db.query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`).get(KEY)?.value;
  return isPermissionMode(raw) ? raw : DEFAULT_PERMISSION_MODE;
}

/** Sets the app's mode from `PATCH /v1/settings`. */
export function setAppPermissionMode(ctx: StoreContext, value: unknown): void {
  setSetting(ctx, KEY, requirePermissionMode(value));
}

/** A Bot's own mode as a request names it: a mode, or null to follow the app's. */
export function incomingPermissionMode(value: unknown): PermissionMode | null {
  if (value === null || value === undefined || value === "") return null;
  return requirePermissionMode(value);
}

function requirePermissionMode(value: unknown): PermissionMode {
  if (!isPermissionMode(value)) {
    throw new HttpError(422, "invalid_args", "permission_mode must be read_only, ask_first, auto or allow_all");
  }
  return value;
}

/** The mode a Bot's calls are decided by: its own, else the app's (also for a Bot no longer there). */
export function permissionModeFor(ctx: StoreContext, botId: string | null | undefined): PermissionMode {
  if (botId) {
    const own = ctx.db
      .query<{ permission_mode: string | null }, [string]>(`SELECT permission_mode FROM bots WHERE id = ?`)
      .get(botId)?.permission_mode;
    if (isPermissionMode(own)) return own;
  }
  return appPermissionMode(ctx);
}
