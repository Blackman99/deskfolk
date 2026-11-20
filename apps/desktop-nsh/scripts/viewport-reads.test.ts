/**
 * The app reads the size of its window in one place, `app/src/platform/viewport.ts`
 * (`viewportSize`). On the desktops NSH's `windowSize()` is the size of the app's host, which never
 * shows (NSH's window model since longbridge/nsh#2307), not of the window the app is drawn in; the
 * one reader there knows which to read. This check fails on any other source that imports it.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const app = resolve(import.meta.dir, "../app");
const READER = "src/platform/viewport.ts";

function sources(): string[] {
  const out = [join(app, "App.tsx"), join(app, "Hosted.tsx"), join(app, "Story.tsx")];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
  };
  walk(join(app, "src"));
  walk(join(app, "stories"));
  return out;
}

test("only viewport.ts reads NSH's windowSize", () => {
  const readers = sources()
    .filter((file) => /\bwindowSize\b/.test(readFileSync(file, "utf8")))
    .map((file) => relative(app, file).split(sep).join("/"));
  expect(readers).toEqual([READER]);
});
