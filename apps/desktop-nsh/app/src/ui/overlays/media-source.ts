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
 * The player's source: on a desktop whose runtime is on this computer, the file by its path (an
 * attachment's content is the same file, `/v1/attachments/:id/content` reads it where it lies); else
 * the loaded bytes' URL (the web, a remote runtime).
 */
export function mediaSource(input: {
  web: boolean;
  local: boolean;
  relpath: string;
  workspaceRoot: string | null | undefined;
  blobUrl: string | null;
}): string {
  if (!input.web && input.local) {
    const path = localFilePath(input.relpath, input.workspaceRoot);
    if (path) return path;
  }
  return input.blobUrl ?? "";
}
