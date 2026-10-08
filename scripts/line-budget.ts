/**
 * Fails when a source file grows past the line limit.
 *
 * Every tracked (or new, not ignored) source file must stay at or under `limit` lines. The files
 * that were already over it when this check landed are listed under `allow` with their own cap
 * (their size then plus about 5%, so work in flight still fits); they may shrink but not grow past
 * it. Splitting one below the limit means deleting its entry in the same change, and a stale entry
 * fails the check so the list only ever gets shorter.
 *
 *   bun scripts/line-budget.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Budget = { limit: number; allow: Record<string, number> };

const SOURCE = /\.(ts|tsx|js|mjs|cjs|svelte|rs|swift|py|sh|css|sql)$/;
// Vendored third-party code keeps its upstream layout.
const VENDORED = /(^|\/)vendor\//;

const root = join(import.meta.dir, "..");
const budget = JSON.parse(readFileSync(join(import.meta.dir, "line-budget.json"), "utf8")) as Budget;

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter((file) => SOURCE.test(file) && !VENDORED.test(file) && existsSync(join(root, file)));

function lineCount(file: string): number {
  const text = readFileSync(join(root, file), "utf8");
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const problems: string[] = [];
const seen = new Set<string>();
for (const file of files) {
  const lines = lineCount(file);
  const cap = budget.allow[file];
  if (cap === undefined) {
    if (lines > budget.limit) {
      problems.push(`${file}: ${lines} lines, over the ${budget.limit}-line limit. Split it.`);
    }
    continue;
  }
  seen.add(file);
  if (lines <= budget.limit) {
    problems.push(`${file}: ${lines} lines, under the limit now. Delete its entry from scripts/line-budget.json.`);
  } else if (lines > cap) {
    problems.push(`${file}: grew to ${lines} lines, past its cap of ${cap}. Split it rather than raising the cap.`);
  }
}
for (const file of Object.keys(budget.allow)) {
  if (!seen.has(file)) problems.push(`${file}: no such source file. Delete its entry from scripts/line-budget.json.`);
}

if (problems.length > 0) {
  console.error(`line budget: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`line budget: ${files.length} source files checked, ${seen.size} still over ${budget.limit} lines on the allowance list`);
