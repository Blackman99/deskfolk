import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UI_FLOORS, UI_HOOKS } from "@real-bot/protocol";

/**
 * The styling hooks a stylesheet of yours counts on (ADR 0106) stay in the markup. Each name in
 * `UI_HOOKS` must be written as `data-ui="<name>"` in some component, and the floors a window
 * checks as `data-floor="<name>"`. Rename or drop one and this fails before a profile breaks.
 */
const SRC = fileURLToPath(new URL("../../", import.meta.url));

function svelteSources(): string[] {
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".svelte")) sources.push(readFileSync(path, "utf8"));
    }
  };
  walk(join(SRC, "lib"));
  walk(join(SRC, "routes"));
  return sources;
}

const SOURCES = svelteSources();

test("there are components to check", () => {
  expect(SOURCES.length).toBeGreaterThan(0);
});

test("every data-ui hook is still in the markup", () => {
  for (const [name] of UI_HOOKS) {
    const found = SOURCES.some((source) => source.includes(`data-ui="${name}"`));
    expect({ hook: name, found }).toEqual({ hook: name, found: true });
  }
});

test("every data-floor the app checks is still in the markup", () => {
  for (const name of UI_FLOORS) {
    const found = SOURCES.some((source) => source.includes(`data-floor="${name}"`));
    expect({ floor: name, found }).toEqual({ floor: name, found: true });
  }
});
