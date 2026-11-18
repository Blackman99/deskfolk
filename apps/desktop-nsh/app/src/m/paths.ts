/**
 * Host filesystem paths — as opposed to the workspace-relative `/`-paths on the wire (contract
 * §7), which never change: those are always `/`-joined, on every platform, by agreement with the
 * daemon and the DB. A host root can be POSIX (`/Users/you/ws`) or Windows (`C:\Users\you\ws`,
 * `\\server\share\ws`); everything here works out which from the root string itself.
 */

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** A drive letter (`C:\`, `C:/`) or a UNC share (`\\server\share…`). */
export function isWindowsHostPath(path: string): boolean {
  return WINDOWS_DRIVE_ABSOLUTE.test(path) || path.startsWith("\\\\");
}

/** The separator a host root spells its own paths with. */
export function hostSeparator(root: string): "\\" | "/" {
  return isWindowsHostPath(root) ? "\\" : "/";
}

/** A POSIX absolute path, or a Windows one — a drive letter or a UNC share. */
export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") || isWindowsHostPath(path);
}

/**
 * Join a workspace-relative `/`-path onto a host root, in the root's own separator — a root like
 * `C:\ws` joins `src/a.ts` into `C:\ws\src\a.ts`. Rejects anything that would escape the root, or
 * that is already absolute.
 */
export function joinHostPath(root: string, rel: string): string | null {
  const base = root.trim();
  const path = rel.trim();
  if (!base || !path) return null;
  if (path.startsWith("/") || path.includes("://")) return null;
  const sep = hostSeparator(base);
  let depth = 0;
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (depth === 0) return null;
      parts.pop();
      depth--;
      continue;
    }
    parts.push(seg);
    depth++;
  }
  const prefix = base.endsWith(sep) ? base.slice(0, -1) : base;
  if (parts.length === 0) return prefix;
  return `${prefix}${sep}${parts.join(sep)}`;
}

/** A path's last segment, splitting on both separators — for a host absolute path, which may spell either. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return trimmed;
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}
