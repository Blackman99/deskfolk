import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The stylesheet is global, so nothing tells you when a rule stops being used — a deleted
 * component leaves its styles behind and they sit there for months. `svelte-check` only sees a
 * component's own `<style>`, and 25 of the 27 components here have none. This is that check.
 */
const STYLES = "src/lib/styles";
const SOURCE_DIRS = ["src/lib", "src/routes"];

/**
 * Third-party widgets Monaco renders into `document.body`, outside anything this app builds.
 * They are styled from the leftmost position, so the descendant rule below cannot spot them.
 * Add to this only for DOM the app genuinely does not render.
 */
const EXTERNAL_DOM = new Set(["context-view", "monaco-hover", "workbench-hover"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function topLevelBlocks(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of css) {
    buf += ch;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        out.push(buf);
        buf = "";
      }
    }
  }
  return out;
}

/** Every selector in the sheet, with `@media` and friends unwrapped. */
function selectors(css: string): string[] {
  const out: string[] = [];
  const visit = (block: string) => {
    const text = block.trim();
    if (!text.includes("{")) return;
    if (text.startsWith("@")) {
      const inner = text.slice(text.indexOf("{") + 1, text.lastIndexOf("}"));
      for (const nested of topLevelBlocks(inner)) visit(nested);
      return;
    }
    const head = text.slice(0, text.indexOf("{"));
    for (const part of head.split(",")) if (part.trim()) out.push(part.trim());
  };
  for (const block of topLevelBlocks(css)) visit(block);
  return out;
}

/** The compound the app itself puts on an element — `.a` in `.a .b`, `.a > .b`, `.a:hover`. */
function leftmostClasses(selector: string): string[] {
  const head = selector.split(/\s|>|\+|~/)[0] ?? "";
  return [...head.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]!);
}

const cssFiles = readdirSync(STYLES)
  .filter((n) => n.endsWith(".css") && n !== "index.css")
  .sort();

const declared = new Map<string, string>();
for (const name of cssFiles) {
  for (const selector of selectors(readFileSync(join(STYLES, name), "utf8"))) {
    for (const cls of leftmostClasses(selector)) if (!declared.has(cls)) declared.set(cls, name);
  }
}

const literals = new Set<string>();
/** `class="tab is-{kind}"` can only tell us that every `is-*` might be in play. */
const prefixes = new Set<string>();
for (const dir of SOURCE_DIRS) {
  for (const path of walk(dir)) {
    if (!/\.(svelte|ts)$/.test(path) || path.includes(".test.") || path.includes(`${STYLES}/`)) continue;
    const text = readFileSync(path, "utf8");
    const chunks = [
      ...[...text.matchAll(/class="([^"]*)"/g)].map((m) => m[1]!),
      ...[...text.matchAll(/`([^`]*)`/g)].map((m) => m[1]!),
      ...[...text.matchAll(/'([^']*)'/g)].map((m) => m[1]!),
      ...[...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]!),
    ];
    for (const chunk of chunks) {
      for (const m of chunk.matchAll(/([A-Za-z][\w-]*-)\$?\{/g)) prefixes.add(m[1]!);
      for (const w of chunk.replace(/\$?\{[^}]*\}/g, " ").matchAll(/[A-Za-z][\w-]*/g)) literals.add(w[0]);
    }
    for (const m of text.matchAll(/class:([\w-]+)/g)) literals.add(m[1]!);
  }
}

function isUsed(cls: string): boolean {
  if (literals.has(cls) || EXTERNAL_DOM.has(cls)) return true;
  for (const prefix of prefixes) if (cls.startsWith(prefix)) return true;
  return false;
}

test("every class the app styles is a class the app renders", () => {
  const orphans = [...declared.entries()]
    .filter(([cls]) => !isUsed(cls))
    .map(([cls, file]) => `${file}: .${cls}`)
    .sort();
  expect(orphans).toEqual([]);
});

test("index.css imports every stylesheet in the directory", () => {
  const index = readFileSync(join(STYLES, "index.css"), "utf8");
  const imported = [...index.matchAll(/@import "\.\/([^"]+)"/g)].map((m) => m[1]!);
  expect([...imported].sort()).toEqual(cssFiles);
});

test("the sheet declares enough classes for this check to mean something", () => {
  // A guard on the parser itself: if selector extraction breaks, the orphan test passes vacuously.
  expect(declared.size).toBeGreaterThan(400);
  expect(prefixes.size).toBeGreaterThan(5);
});
