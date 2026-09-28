import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { HttpError } from "./errors";
import { classifyPath, hostPathRoot, isAbsoluteHostPath, isWithinPath, type PathHost } from "./workspace-paths";

export const HOST_LIST_LIMIT = 500;
const SKIP_NAMES = new Set(["node_modules"]);

export type HostTreeEntry = { name: string; path: string; kind: "file" | "dir" };
export type HostTreePage = { path: string; parent: string | null; truncated: boolean; items: HostTreeEntry[] };

export type HostFs = {
  home?: string;
  readdir?: typeof readdirSync;
  stat?: typeof statSync;
  /** The file system the symlink walk runs on, and its platform; tests hand in a Windows one. */
  paths?: PathHost;
};

function platformOf(fs: HostFs): NodeJS.Platform {
  return fs.paths?.platform ?? process.platform;
}

function currentHome(fs: HostFs = {}): string {
  return hostAbs(fs.home ?? fs.paths?.homedir() ?? homedir(), platformOf(fs));
}

/** Resolve an absolute host path with the same symlink walk as workspace classifyPath. */
export function resolveHostPath(input: string, fs: HostFs = {}): string {
  const platform = platformOf(fs);
  const raw = input.trim() || currentHome(fs);
  if (!isAbsoluteHostPath(raw, platform) || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) {
    throw new HttpError(422, "invalid_args", "path must be an absolute host directory");
  }
  try {
    return hostAbs(classifyPath(hostPathRoot(raw, platform), raw, fs.paths).abs, platform);
  } catch (error) {
    throw hostFsError(error, platform);
  }
}

function assertHostReadable(abs: string, fs: HostFs = {}): string {
  const platform = platformOf(fs);
  const resolved = hostAbs(abs, platform);
  if (isForeignHome(resolved, currentHome(fs), platform)) {
    throw new HttpError(403, "host_permission", permissionMessage(platform));
  }
  let st;
  try {
    st = (fs.stat ?? statSync)(resolved);
  } catch (error) {
    throw hostFsError(error, platform);
  }
  if (!st.isDirectory()) throw new HttpError(422, "invalid_args", "path is not a directory");
  return resolved;
}

export function listHostDir(input: string, fs: HostFs = {}): HostTreePage {
  const platform = platformOf(fs);
  const resolved = assertHostReadable(resolveHostPath(input, fs), fs);
  let names: string[];
  try {
    names = (fs.readdir ?? readdirSync)(resolved);
  } catch (error) {
    throw hostFsError(error, platform);
  }
  const kept = names.filter((name) => !skipName(name));
  kept.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const truncated = kept.length > HOST_LIST_LIMIT;
  const slice = truncated ? kept.slice(0, HOST_LIST_LIMIT) : kept;
  const home = currentHome(fs);
  const root = hostPathRoot(resolved, platform);
  const items: HostTreeEntry[] = [];
  for (const name of slice) {
    const childRaw = resolved === root ? `${root}${name}` : `${resolved}${platform === "win32" ? "\\" : "/"}${name}`;
    let childAbs: string;
    try {
      childAbs = hostAbs(classifyPath(hostPathRoot(childRaw, platform), childRaw, fs.paths).abs, platform);
    } catch {
      continue;
    }
    if (isForeignHome(childAbs, home, platform)) continue;
    let kind: "file" | "dir" = "file";
    try {
      if ((fs.stat ?? statSync)(childAbs).isDirectory()) kind = "dir";
    } catch (error) {
      if (isDenied(error)) continue;
      kind = "file";
    }
    items.push({ name, path: childAbs, kind });
  }
  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  const parent = resolved === root ? null : (platform === "win32" ? win32 : posix).dirname(resolved);
  return { path: resolved, parent, truncated, items };
}

/**
 * Another user's home folder, which the picker never shows: `/Users/<name>` on a Mac, and on
 * Windows any folder beside the user's own profile (`C:\Users\<name>`) except Public.
 */
export function isForeignHome(abs: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return isForeignWindowsProfile(abs, home);
  const users = "/Users/";
  if (abs === "/Users" || abs === "/Users/") return false;
  if (!abs.startsWith(users)) return false;
  const name = abs.slice(users.length).split("/")[0] ?? "";
  if (!name || name === "Shared") return false;
  return name !== posix.basename(hostAbs(home, platform));
}

function isForeignWindowsProfile(abs: string, home: string): boolean {
  const profile = hostAbs(home, "win32");
  const users = win32.dirname(profile);
  // A profile straight under a drive or share root has no folder of profiles beside it.
  if (!isAbsoluteHostPath(users, "win32") || users === hostPathRoot(users, "win32")) return false;
  if (!isWithinPath(users, abs, "win32")) return false;
  const name = abs.slice(users.length).split(/[\\/]/).filter(Boolean)[0] ?? "";
  if (!name || name.toLowerCase() === "public") return false;
  return name.toLowerCase() !== win32.basename(profile).toLowerCase();
}

function skipName(name: string): boolean {
  if (name === "." || name === "..") return true;
  if (name.startsWith(".")) return true;
  return SKIP_NAMES.has(name);
}

/** No trailing separator, except on a root (`/`, `C:\`, `\\server\share\`). */
function hostAbs(path: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    if (!isAbsoluteHostPath(path, "win32")) return path;
    const root = hostPathRoot(path, "win32");
    if (!path.toLowerCase().startsWith(root.toLowerCase())) return path.replace(/[\\/]+$/, "");
    const rest = path.slice(root.length).replace(/[\\/]+$/, "");
    return rest ? `${root}${rest}` : root;
  }
  if (path === "/") return "/";
  return path.replace(/\/+$/, "") || "/";
}

/** macOS asks once in Privacy & Security; Windows just denies what the account may not read. */
function permissionMessage(platform: NodeJS.Platform): string {
  return platform === "win32" ? "access is denied on this computer" : "authorize once on the Mac";
}

function isDenied(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "EACCES" || code === "EPERM" || code === "EAUTH";
}

function hostFsError(error: unknown, platform: NodeJS.Platform): HttpError {
  if (error instanceof HttpError) return error;
  if (isDenied(error)) return new HttpError(403, "host_permission", permissionMessage(platform));
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
    return new HttpError(404, "not_found", "path not found");
  }
  return new HttpError(422, "invalid_args", "could not list directory");
}
