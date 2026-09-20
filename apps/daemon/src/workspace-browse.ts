import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { HttpError } from "./errors";
import { classifyPath } from "./workspace-paths";
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

function skipName(name: string): boolean {
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
