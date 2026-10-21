import { readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectPathLookup } from "@real-bot/protocol";
import { skipName } from "./workspace-browse";
import { isAbsoluteHostPath } from "./workspace-paths";

/** How many entries a lookup by name reads before it stops: a folder that size is not one project. */
export const PROJECT_LOOKUP_VISIT_LIMIT = 20_000;

const NOWHERE: ProjectPathLookup = { path: null, kind: null, matches: [] };

/**
 * Where a path a project session's agent cites is (ADR 0095). Its words are relative to wherever it
 * was working, which is the project directory only while it stays there: in a folder holding
 * several repositories it names `src/lib/api.ts` from inside one of them, or just `server.go`. So:
 * written absolute or from `~`, as written; under the project directory, there; else the file or
 * folder under it whose path ends in the cited one, the shallowest, and none when the shallowest
 * are several. Hidden folders and `node_modules` are not looked in, as the explorer does not list
 * them, and a symlinked folder is not followed.
 */
export function locateProjectPath(dir: string, cited: string, opts: { home?: string; limit?: number } = {}): ProjectPathLookup {
  const written = cited.trim().replace(/^\.[\\/]+/, "");
  const wantDir = /[\\/]$/.test(written);
  const rel = written.replace(/[\\/]+$/, "");
  if (!rel || rel.length > 4096 || /[\x00-\x1f\x7f]/.test(rel)) return NOWHERE;
  const fits = (kind: "file" | "dir" | null): kind is "file" | "dir" => kind !== null && (!wantDir || kind === "dir");

  if (/^~[\\/]/.test(rel) || isAbsoluteHostPath(rel)) {
    const abs = /^~[\\/]/.test(rel) ? join(opts.home ?? homedir(), rel.slice(2)) : rel;
    const kind = kindOf(abs);
    return fits(kind) ? { path: abs, kind, matches: [] } : NOWHERE;
  }
  const atRoot = join(dir, rel);
  const kind = kindOf(atRoot);
  if (fits(kind)) return { path: atRoot, kind, matches: [] };

  const wanted = rel.split(/[\\/]+/);
  if (wanted.includes("..") || wanted.includes(".")) return NOWHERE;
  const name = wanted[wanted.length - 1]!;
  const limit = opts.limit ?? PROJECT_LOOKUP_VISIT_LIMIT;
  // Level by level, so the first level with a match holds the shallowest ones: deeper levels are
  // not read.
  const found: Array<{ segments: string[]; kind: "file" | "dir" }> = [];
  let level: string[][] = [[]];
  let visited = 0;
  scan: while (level.length > 0 && found.length === 0) {
    const next: string[][] = [];
    for (const segments of level) {
      let entries: Dirent[];
      try {
        entries = readdirSync(join(dir, ...segments), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (skipName(entry.name)) continue;
        if (++visited > limit) break scan;
        const child = [...segments, entry.name];
        if (entry.isDirectory()) next.push(child);
        if (entry.name !== name || !endsWith(child, wanted)) continue;
        const childKind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : kindOf(join(dir, ...child));
        if (fits(childKind)) found.push({ segments: child, kind: childKind });
      }
    }
    level = next;
  }
  const matches = found.map((match) => match.segments.join("/"));
  if (found.length !== 1) return { ...NOWHERE, matches };
  return { path: join(dir, ...found[0]!.segments), kind: found[0]!.kind, matches };
}

function endsWith(path: string[], tail: string[]): boolean {
  if (path.length < tail.length) return false;
  const offset = path.length - tail.length;
  return tail.every((segment, i) => path[offset + i] === segment);
}

function kindOf(abs: string): "file" | "dir" | null {
  try {
    return statSync(abs).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}
