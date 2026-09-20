import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { HttpError } from "./errors";
import { classifyPath } from "./workspace-paths";

export const HOST_LIST_LIMIT = 500;
const SKIP_NAMES = new Set(["node_modules"]);

export type HostTreeEntry = { name: string; path: string; kind: "file" | "dir" };
export type HostTreePage = { path: string; parent: string | null; truncated: boolean; items: HostTreeEntry[] };

export type HostFs = {
  home?: string;
  readdir?: typeof readdirSync;
  stat?: typeof statSync;
};

export function currentHome(fs: HostFs = {}): string {
  return posixAbs(fs.home ?? homedir());
}

/** Resolve an absolute host path with the same symlink walk as workspace classifyPath. */
export function resolveHostPath(input: string, fs: HostFs = {}): string {
  const raw = input.trim() || currentHome(fs);
  if (!raw.startsWith("/") || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) {
    throw new HttpError(422, "invalid_args", "path must be an absolute host directory");
  }
  try {
    return posixAbs(classifyPath(raw.startsWith("/") ? "/" : currentHome(fs), raw).abs);
  } catch (error) {
    throw hostFsError(error);
  }
}

export function assertHostReadable(abs: string, fs: HostFs = {}): string {
  const resolved = posixAbs(abs);
  if (isForeignHome(resolved, currentHome(fs))) {
    throw new HttpError(403, "host_permission", "authorize once on the Mac");
  }
  let st;
  try {
    st = (fs.stat ?? statSync)(resolved);
  } catch (error) {
    throw hostFsError(error);
  }
  if (!st.isDirectory()) throw new HttpError(422, "invalid_args", "path is not a directory");
  return resolved;
}

export function listHostDir(input: string, fs: HostFs = {}): HostTreePage {
  const resolved = assertHostReadable(resolveHostPath(input, fs), fs);
  let names: string[];
  try {
    names = (fs.readdir ?? readdirSync)(resolved);
  } catch (error) {
    throw hostFsError(error);
  }
  const kept = names.filter((name) => !skipName(name));
  kept.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const truncated = kept.length > HOST_LIST_LIMIT;
  const slice = truncated ? kept.slice(0, HOST_LIST_LIMIT) : kept;
  const home = currentHome(fs);
  const items: HostTreeEntry[] = [];
  for (const name of slice) {
    const childRaw = resolved === "/" ? `/${name}` : `${resolved}/${name}`;
    let childAbs: string;
    try {
      childAbs = posixAbs(classifyPath("/", childRaw).abs);
    } catch {
      continue;
    }
    if (isForeignHome(childAbs, home)) continue;
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
  return { path: resolved, parent: resolved === "/" ? null : dirname(resolved), truncated, items };
}

export function isForeignHome(abs: string, home: string): boolean {
  const users = "/Users/";
  if (abs === "/Users" || abs === "/Users/") return false;
  if (!abs.startsWith(users)) return false;
  const name = abs.slice(users.length).split("/")[0] ?? "";
  if (!name || name === "Shared") return false;
  return name !== basename(posixAbs(home));
}

function skipName(name: string): boolean {
  if (name === "." || name === "..") return true;
  if (name.startsWith(".")) return true;
  return SKIP_NAMES.has(name);
}

function posixAbs(path: string): string {
  if (path === "/") return "/";
  return path.replace(/\/+$/, "") || "/";
}

function isDenied(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "EACCES" || code === "EPERM" || code === "EAUTH";
}

function hostFsError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (isDenied(error)) return new HttpError(403, "host_permission", "authorize once on the Mac");
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
    return new HttpError(404, "not_found", "path not found");
  }
  return new HttpError(422, "invalid_args", "could not list directory");
}
