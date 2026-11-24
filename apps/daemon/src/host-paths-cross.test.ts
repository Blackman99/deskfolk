/**
 * Cross-platform real-filesystem check for `locateHostFile` and `listHostDir` against raw
 * `tmpdir()` with the real `homedir()` (no `{ home }` override and no pre-canonicalized path).
 * On Windows runners whose username exceeds 8 characters (`runneradmin`), `tmpdir()` spells the
 * profile with an 8.3 short name (`C:\Users\RUNNER~1\…`); this must still be recognized as the
 * current user's own profile rather than refused with 403 `host_permission`.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHostDir, locateHostFile } from "./host-paths";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("locateHostFile and listHostDir read files under raw tmpdir() without treating 8.3 short profile names as foreign", () => {
  const rawTmp = tmpdir();
  if (process.platform === "win32" && !rawTmp.includes("~")) {
    console.log(`[host-paths-cross] tmpdir() has no 8.3 short segment on this host: ${rawTmp}`);
  }
  const dir = mkdtempSync(join(rawTmp, "real-bot-host-cross-"));
  dirs.push(dir);
  const file = join(dir, "notes.md");
  writeFileSync(file, "# Elsewhere\n");

  const located = locateHostFile(file);
  expect(located.toLowerCase().endsWith("notes.md")).toBe(true);

  const page = listHostDir(dir, {}, { dotted: true });
  expect(page.items.map((row) => row.name)).toEqual(["notes.md"]);
});
