/**
 * Catches POSIX-only host-path assumptions in `app/.ui/` and `app/stories/` on macOS before they
 * fail an hour later on the Windows CI runner:
 * - appending `/` directly to a host path (`${seeded.projectDir}/…`, `${seeded.workspace}/…`,
 *   `${seeded.elsewhere}/…`, `${projectDir}/…`) — use `joinHostPath` instead;
 * - `.lastIndexOf("/")` on a host path — use `folderOfPath` or `baseName` instead;
 * - passing hardcoded `"/tmp"` to a live runtime setting (such as `pick_workspace_folder`) — use
 *   a real host path from `seeded` instead.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const app = resolve(import.meta.dir, "../app");
const appPath = (file: string) => relative(app, file).split(sep).join("/");

function collect(dir: string): string[] {
  const out: string[] = [];
  const walk = (here: string) => {
    for (const name of readdirSync(here)) {
      if (name === ".nsh" || name === "node_modules") continue;
      const full = join(here, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const RULES: Array<{ name: string; pattern: RegExp; scope: "all" | "ui" }> = [
  {
    name: "host path joined with `/` instead of joinHostPath",
    pattern: /\$\{(?:seeded\.(?:workspace|workspaceAlt|projectDir|elsewhere)|projectDir)\}\//,
    scope: "all",
  },
  {
    name: "lastIndexOf(\"/\") on a path instead of folderOfPath / baseName",
    pattern: /\.lastIndexOf\(\s*["']\/["']\s*\)/,
    scope: "all",
  },
  {
    name: "hardcoded \"/tmp\" passed to a live runtime test instead of a seeded directory",
    pattern: /["']\/tmp["']/,
    scope: "ui",
  },
];

test("screen tests and stories do not hardcode POSIX host-path separators or /tmp", () => {
  const uiFiles = collect(join(app, ".ui"));
  const storyFiles = collect(join(app, "stories"));
  const hits: string[] = [];
  for (const [scope, files] of [["ui", uiFiles], ["stories", storyFiles]] as const) {
    for (const file of files) {
      const rel = appPath(file);
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      for (const [idx, line] of lines.entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        for (const rule of RULES) {
          if (rule.scope === "ui" && scope !== "ui") continue;
          if (rule.pattern.test(line)) hits.push(`${rel}:${idx + 1} (${rule.name}): ${trimmed}`);
        }
      }
    }
  }
  expect(hits).toEqual([]);
});
