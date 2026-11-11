/**
 * What a video or audio preview hands NSH's player. The players on the desktops (AVPlayer on macOS)
 * open a file path or an http(s) URL, never the `blob:` URL the loader makes of the bytes: given
 * one they answer "unsupported URL" and the pane said the file was gone. The browser's `<video>` on
 * the web takes the blob as before.
 */

/** A path that names its file on its own: `/…` on macOS and Linux, `C:\…` or `\\server\…` on Windows. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * The file on this computer that `relpath` names: itself when absolute (a project session's files,
 * ADR 0095), else under the workspace root; null with no root to put it under, or for `~/…` (the
 * home is the runtime's to know).
 */
export function localFilePath(relpath: string, workspaceRoot: string | null | undefined): string | null {
  const path = relpath.trim();
  if (!path) return null;
  if (isAbsolutePath(path)) return path;
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) return null;
  const root = (workspaceRoot ?? "").replace(/[\\/]+$/, "");
  if (!root) return null;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${sep}${path.replace(/^\.?[\\/]+/, "").replace(/[\\/]/g, sep)}`;
}

/**
 * The file the player opens where it lies: on a desktop whose runtime is on this computer, the file
 * by its path (an attachment's content is the same file, `/v1/attachments/:id/content` reads it
 * where it lies). Null on the web, for a remote runtime and for a path it cannot place; those play
 * the loaded bytes. The loader reads no bytes for a file this names (`ArtifactLoaderHost.mediaFile`).
 */
export function mediaFilePath(input: {
  web: boolean;
  local: boolean;
  relpath: string;
  workspaceRoot: string | null | undefined;
}): string | null {
  return !input.web && input.local ? localFilePath(input.relpath, input.workspaceRoot) : null;
}

/** The player's source: the file by its path where `mediaFilePath` names one, else the loaded bytes' URL. */
export function mediaSource(input: {
  web: boolean;
  local: boolean;
  relpath: string;
  workspaceRoot: string | null | undefined;
  blobUrl: string | null;
}): string {
  return mediaFilePath(input) ?? input.blobUrl ?? "";
}
