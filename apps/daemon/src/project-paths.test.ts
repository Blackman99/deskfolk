import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { locateProjectPath } from "./project-paths";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A project folder holding the given files (a path ending in `/` is a folder). */
function project(paths: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "project-paths-")));
  dirs.push(dir);
  for (const path of paths) {
    if (path.endsWith("/")) mkdirSync(join(dir, path), { recursive: true });
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), "x");
    }
  }
  return dir;
}

test("a path under the project directory is there as written", () => {
  const dir = project(["web/src/app.ts", "README.md"]);
  expect(locateProjectPath(dir, "web/src/app.ts")).toEqual({ path: join(dir, "web/src/app.ts"), kind: "file", matches: [] });
  expect(locateProjectPath(dir, "./README.md")).toEqual({ path: join(dir, "README.md"), kind: "file", matches: [] });
  expect(locateProjectPath(dir, "web/src/")).toEqual({ path: join(dir, "web/src"), kind: "dir", matches: [] });
});

test("a path named from inside one repository of the folder, or by its name alone, is found under it", () => {
  const dir = project(["steez/comm/defs.go", "steez/srv/mcp/server.go", "web-admin/src/lib/adminApi.ts", "web-app/src/i18n/zh.ts"]);
  expect(locateProjectPath(dir, "comm/defs.go")).toEqual({ path: join(dir, "steez/comm/defs.go"), kind: "file", matches: ["steez/comm/defs.go"] });
  expect(locateProjectPath(dir, "src/lib/adminApi.ts").path).toBe(join(dir, "web-admin/src/lib/adminApi.ts"));
  expect(locateProjectPath(dir, "server.go").path).toBe(join(dir, "steez/srv/mcp/server.go"));
  expect(locateProjectPath(dir, "srv/mcp/").path).toBe(join(dir, "steez/srv/mcp"));
  // A name is matched whole, segment by segment.
  expect(locateProjectPath(dir, "rv/mcp/server.go")).toEqual({ path: null, kind: null, matches: [] });
});

test("the shallowest match wins; several at that depth find nothing and say where they are", () => {
  const dir = project(["api/zh.ts", "web/src/i18n/zh.ts", "a/server.go", "b/server.go"]);
  expect(locateProjectPath(dir, "zh.ts")).toEqual({ path: join(dir, "api/zh.ts"), kind: "file", matches: ["api/zh.ts"] });
  const both = locateProjectPath(dir, "server.go");
  expect(both.path).toBeNull();
  expect(both.matches.sort()).toEqual(["a/server.go", "b/server.go"]);
});

test("hidden folders, node_modules and symlinked folders are not looked in", () => {
  const outside = project(["elsewhere/only.ts"]);
  const dir = project([".wt/steez-main/comm/defs.go", "node_modules/pkg/index.ts", "steez/comm/defs.go"]);
  symlinkSync(join(outside, "elsewhere"), join(dir, "linked"));
  expect(locateProjectPath(dir, "comm/defs.go")).toEqual({ path: join(dir, "steez/comm/defs.go"), kind: "file", matches: ["steez/comm/defs.go"] });
  expect(locateProjectPath(dir, "pkg/index.ts").path).toBeNull();
  expect(locateProjectPath(dir, "only.ts").path).toBeNull();
});

test("a branch name, a folder asked for as a file and a climb out find nothing", () => {
  const dir = project(["feat/notes.md", "src/adverse-media.ts"]);
  expect(locateProjectPath(dir, "feat/adverse-media")).toEqual({ path: null, kind: null, matches: [] });
  expect(locateProjectPath(dir, "notes.md/").path).toBeNull();
  expect(locateProjectPath(dir, "../x/adverse-media.ts").path).toBeNull();
});

test("an absolute path or one from ~ is as written", () => {
  const home = project(["notes/todo.md"]);
  const dir = project([]);
  expect(locateProjectPath(dir, join(home, "notes/todo.md"))).toEqual({ path: join(home, "notes/todo.md"), kind: "file", matches: [] });
  expect(locateProjectPath(dir, "~/notes/todo.md", { home })).toEqual({ path: join(home, "notes/todo.md"), kind: "file", matches: [] });
  expect(locateProjectPath(dir, join(home, "gone.md")).path).toBeNull();
});

test("the lookup stops after its limit of entries rather than reading a whole disk", () => {
  const dir = project(["a/1.txt", "a/2.txt", "a/3.txt", "deep/x/target.ts"]);
  expect(locateProjectPath(dir, "target.ts").path).toBe(join(dir, "deep/x/target.ts"));
  expect(locateProjectPath(dir, "target.ts", { limit: 4 }).path).toBeNull();
});
