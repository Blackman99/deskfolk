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
    // Strip the comments parked above a rule. Left in, they become part of the selector, the
    // leftmost "compound" is `/*`, and the rule's classes are never declared — so every rule
    // with a section comment over it was invisible to the orphan check.
    const head = text.slice(0, text.indexOf("{")).replace(/\/\*[\s\S]*?\*\//g, " ");
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
    // No newlines inside a chunk. A quote regex that may cross lines walks straight over the
    // apostrophe in an English copy string and swallows unrelated code, and every word in the
    // wreckage then counts as a class in use — which is how `.detail` stayed in this sheet long
    // after the component that rendered it was deleted.
    const chunks = [
      ...[...text.matchAll(/class="([^"\n]*)"/g)].map((m) => m[1]!),
      ...[...text.matchAll(/`([^`\n]*)`/g)].map((m) => m[1]!),
      ...[...text.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]!),
      ...[...text.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]!),
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

/**
 * A guard on the extraction itself: if it breaks, the orphan test above passes vacuously.
 * Deliberately not a count and not a class name — the global sheet shrinks every time a pane
 * takes its styles back, so either would just be a tripwire on progress. This checks the two
 * functions directly, on input that does not move.
 */
test("the check can still read a sheet and the markup", () => {
  const sample = `
    /* a comment with a .decoy in it */
    .a, .b .c { color: red }
    @media (max-width: 1px) { .d:hover > .e { color: red } }
    :root { --x: 1 }
  `;
  expect(selectors(sample).sort()).toEqual([".a", ".b .c", ".d:hover > .e", ":root"]);
  expect(selectors(sample).flatMap(leftmostClasses).sort()).toEqual(["a", "b", "d"]);
  // and the source side still sees real markup
  expect(literals.has("composer")).toBe(true);
  expect(prefixes.size).toBeGreaterThan(5);
});
