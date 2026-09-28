/**
 * Where the daemon's data directory lives by default, before `REAL_BOT_DATA_DIR` overrides it.
 * Pure: no I/O, no `node:*` imports — this package also runs in the messenger's browser bundle
 * (the Tauri dev-server plugin resolves the same default on the Vite/Node side). Callers own
 * reading `REAL_BOT_DATA_DIR`; this only computes the fallback.
 */
import { APP_SUPPORT_DIRNAME } from "./index.ts";

export type AppDataDirOptions = {
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
};

/**
 * - win32: `%LOCALAPPDATA%\real-bot`, or `<home>\AppData\Local\real-bot` when `LOCALAPPDATA` is
 *   unset (joined with `\`).
 * - every other platform: `<home>/Library/Application Support/real-bot` (joined with `/`),
 *   unchanged from before this function existed.
 */
export function defaultAppDataDir(options: AppDataDirOptions): string {
  if (options.platform === "win32") {
    const local = options.env.LOCALAPPDATA;
    return local
      ? `${local}\\${APP_SUPPORT_DIRNAME}`
      : `${options.home}\\AppData\\Local\\${APP_SUPPORT_DIRNAME}`;
  }
  return `${options.home}/Library/Application Support/${APP_SUPPORT_DIRNAME}`;
}
