import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One piece of content, two hosts, and nothing that lets them drift apart.
 *
 * On a wide desktop window the terminal, the workspace and the rest are panes; below the narrow
 * breakpoint they are the slide-over pages they have always been. The way that goes wrong is a
 * `mode` or `phone` prop on the content, which is an invitation for the two to grow different
 * behaviour a line at a time. So the content components are checked here rather than trusted:
 * they hold no host chrome, no breakpoint, and no opinion about which host they are in.
 */
const ROOT = new URL("../", import.meta.url).pathname;

function viewFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith("View.svelte")) found.push(path);
    }
  };
  walk(ROOT);
  return found.sort();
}

test("there are content components to check", () => {
  // If this ever drops to zero the checks below are vacuous and would pass silently.
  expect(viewFiles().length).toBeGreaterThan(0);
});

test("content holds no host chrome", () => {
  for (const file of viewFiles()) {
    const source = readFileSync(file, "utf8");
    // Positioning itself against the window is the host's job. A pane is not the window.
    expect({ file, fixed: source.includes("position: fixed") }).toEqual({ file, fixed: false });
    expect({ file, scrim: source.includes("backdropClick") }).toEqual({ file, scrim: false });
    expect({ file, slide: source.includes("mobile-page-slide") }).toEqual({ file, slide: false });
  }
});

test("content does not decide which host it is in", () => {
  for (const file of viewFiles()) {
    const source = readFileSync(file, "utf8");
    expect({ file, breakpoint: source.includes("max-width: 680px") }).toEqual({ file, breakpoint: false });
    expect({ file, media: source.includes("matchMedia") }).toEqual({ file, media: false });
    // A boolean that says "I am on a phone" is exactly how the two hosts start diverging.
    for (const banned of ["phone:", "isPhone", "variant:", "mode = "]) {
      expect({ file, banned, present: source.includes(banned) }).toEqual({ file, banned, present: false });
    }
  }
});
