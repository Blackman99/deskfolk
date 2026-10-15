import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { HttpError } from "./errors";
import { listHostDir, locateHostFile, type HostFs } from "./host-paths";
import { classifyPath, expandHome, isAbsoluteHostPath, nodePathHost } from "./workspace-paths";
import { attachmentMime } from "./artifact-mime";
import { atomicWrite, fileEtag, withFileLock } from "./file-integrity";

export const WORKSPACE_LIST_LIMIT = 500;
/** Cap for PUT UTF-8 overwrite only. GET /v1/workspace/file has no size cap so the preview pane can open media. */
export const WORKSPACE_READ_BYTES_MAX = 1_000_000;

const SKIP_NAMES = new Set(["node_modules"]);

export type WorkspaceTreeEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
};

export type WorkspaceTreePage = {
  path: string;
  truncated: boolean;
  items: WorkspaceTreeEntry[];
};

/**
 * A path the file routes were given that is written absolute (`/x`, `~/x`, `C:\x`) and is not in
 * the workspace: a place elsewhere on this machine, read where it is. The workspace bounds where
 * Bots work, not what you can open. A relative path stays the workspace's, so `../x` is still an
 * escape; an absolute path into the workspace keeps the workspace's own rules.
 */
function outsideAbsolute(root: string | null, input: string, fs: HostFs): string | null {
  const home = fs.home;
  const expanded = expandHome(input.trim(), home ? { ...nodePathHost, homedir: () => home } : nodePathHost);
  if (!isAbsoluteHostPath(expanded)) return null;
  if (root) {
    try {
      if (classifyPath(root, expanded).zone === "inside") return null;
    } catch {
      // Unresolvable against the workspace: read as a host path, which reports why.
    }
  }
  return expanded;
}

/** `GET /v1/workspace/tree`: a workspace folder, or a folder elsewhere named by its absolute path. */
export function listCitedDir(root: string | null, input: string, fs: HostFs = {}): WorkspaceTreePage {
  const outside = outsideAbsolute(root, input, fs);
  if (outside) {
    const page = listHostDir(outside, fs);
    return { path: page.path, truncated: page.truncated, items: page.items };
  }
  if (!root) throw new HttpError(422, "invalid_args", "workspace is not set");
  return listWorkspaceDir(root, input);
}

/** `GET /v1/workspace/file`: a workspace file, or a file elsewhere named by its absolute path. */
export function locateCitedFile(root: string | null, input: string, fs: HostFs = {}): { abs: string; name: string; mime: string } {
  const outside = outsideAbsolute(root, input, fs);
  if (outside) {
    const name = (process.platform === "win32" ? win32 : posix).basename(outside);
    return { abs: locateHostFile(outside, fs), name, mime: attachmentMime(name) };
  }
  if (!root) throw new HttpError(422, "invalid_args", "workspace is not set");
  const located = locateWorkspaceFile(root, input);
  return { abs: located.abs, name: located.rel.split("/").pop() ?? located.rel, mime: located.mime };
}

export function listWorkspaceDir(root: string, relInput: string): WorkspaceTreePage {
  const classified = classifyWorkspaceRel(root, relInput);
  const logical = posix.normalize(relInput.trim() || ".");
  let st;
  try {
    st = statSync(classified.abs);
  } catch {
    throw new HttpError(404, "not_found", "path not found");
  }
  if (!st.isDirectory()) {
    throw new HttpError(422, "invalid_args", "path is not a directory");
  }
  let names: string[];
  try {
    names = readdirSync(classified.abs);
  } catch {
    throw new HttpError(422, "invalid_args", "could not list directory");
  }
  const kept = names.filter((name) => !skipName(name));
  kept.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const truncated = kept.length > WORKSPACE_LIST_LIMIT;
  const slice = truncated ? kept.slice(0, WORKSPACE_LIST_LIMIT) : kept;
  const items: WorkspaceTreeEntry[] = [];
  for (const name of slice) {
    const childAbs = join(classified.abs, name);
    const childRel = logical === "." ? name : `${logical}/${name}`;
    const child = classifyPath(root, childRel);
    if (child.zone !== "inside") continue;
    let kind: "file" | "dir" = "file";
    try {
      if (statSync(childAbs).isDirectory()) kind = "dir";
    } catch {
      kind = "file";
    }
    items.push({ name, path: childRel, kind });
  }
  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return { path: logical, truncated, items };
}

export function locateWorkspaceFile(
  root: string,
  relInput: string,
): { abs: string; rel: string; mime: string } {
  const classified = classifyWorkspaceRel(root, relInput);
  let st;
  try {
    st = statSync(classified.abs);
  } catch {
    throw new HttpError(404, "not_found", "path not found");
  }
  if (st.isDirectory()) {
    throw new HttpError(422, "invalid_args", "path is a directory");
  }
  return {
    abs: classified.abs,
    rel: classified.rel,
    mime: attachmentMime(classified.rel),
  };
}

/** Overwrite an existing inside-workspace UTF-8 file. Does not create, delete, or rename. */
export function writeWorkspaceFile(root: string, relInput: string, content: string, ifMatch?: string | null, stage?: (abs: string, content: string) => void): { rel: string; etag: string } {
  if (typeof content !== "string") {
    throw new HttpError(422, "invalid_args", "content must be a string");
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > WORKSPACE_READ_BYTES_MAX) {
    throw new HttpError(422, "too_large", "file is too large");
  }
  const located = locateWorkspaceFile(root, relInput);
  const etag = stage ? withFileLock(located.abs, () => {
    if (ifMatch != null && fileEtag(readFileSync(located.abs)) !== ifMatch) {
      throw new HttpError(409, "conflict", "file changed; reload before saving");
    }
    stage(located.abs, content);
    return fileEtag(Buffer.from(content));
  }) : atomicWrite(located.abs, content, ifMatch);
  return { rel: located.rel, etag };
}

export function skipName(name: string): boolean {
  if (name === "." || name === "..") return true;
  if (name.startsWith(".")) return true;
  return SKIP_NAMES.has(name);
}

function classifyWorkspaceRel(root: string, relInput: string): { abs: string; rel: string } {
  const raw = relInput.trim() === "" ? "." : relInput.trim();
  const classified = classifyPath(root, raw);
  if (classified.zone !== "inside") {
    throw new HttpError(422, "invalid_args", "path is outside the workspace");
  }
  return { abs: classified.abs, rel: classified.rel };
}
