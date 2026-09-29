/**
 * A tiny, single-level glob: enough for a continuity check's `path` (`shots/*_MASTER_V2.mp4`) and
 * for the organizer's safety rule that a proposed check's `path` has to match a file the plan
 * already cited. `*` matches any run of characters within one path segment — it never crosses a
 * `/` — and `?` matches exactly one; everything else in the pattern is literal. Deliberately not a
 * general glob engine (no `**`, no character classes): the deliverables this matches are flat
 * filenames like `*_REEDIT_MASTER.mp4`, not nested trees.
 */

export function isGlobPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

const SPECIAL = /[.+^${}()|[\]\\]/;

export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (const ch of pattern) {
    if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += SPECIAL.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * The pattern split at the last `/` before its first wildcard: everything before is a fixed
 * directory (jail-checked as an ordinary path — no wildcard reaches `classifyPath`), everything
 * from there on is matched per entry by {@link globToRegExp}. A pattern with no wildcard is its
 * own fixed path, with an empty file-glob half (the caller treats that as "not a glob").
 */
export function splitGlobDir(pattern: string): { dir: string; filePattern: string } {
  const firstWildcard = pattern.search(/[*?]/);
  if (firstWildcard === -1) return { dir: pattern, filePattern: "" };
  const cut = pattern.lastIndexOf("/", firstWildcard);
  if (cut === -1) return { dir: ".", filePattern: pattern };
  return { dir: pattern.slice(0, cut), filePattern: pattern.slice(cut + 1) };
}
