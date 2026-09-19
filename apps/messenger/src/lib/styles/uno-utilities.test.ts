import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createGenerator } from "unocss";
import config from "../../../uno.config.ts";

/**
 * A utility that generates nothing is invisible: the class sits in the markup, the style simply
 * does not happen, and neither `svelte-check` nor the type checker has an opinion. The border
 * utilities are the live example — they are blocklisted, so writing `border-t` looks right and
 * does nothing at all.
 *
 * So: every token that is shaped like a utility has to produce CSS. Tokens that are not (the
 * app's own semantic class names) are left alone, which is why this matches on the prefixes the
 * codebase actually uses rather than trying to guess.
 */
const PREFIXES = [
  "w", "h", "min-w", "min-h", "max-w", "max-h", "p", "px", "py", "pt", "pr", "pb", "pl",
  "m", "mx", "my", "mt", "mr", "mb", "ml", "gap", "gap-x", "gap-y", "text", "bg", "rounded",
  "shadow", "font", "leading", "tracking", "opacity", "z", "top", "right", "bottom", "left",
  "inset", "border", "flex", "grid", "items", "justify", "self", "shrink", "grow", "order",
  "overflow", "overflow-x", "overflow-y", "whitespace", "cursor", "select", "object", "align",
  "pointer-events", "list",
];
const BARE = new Set([
  "flex", "grid", "block", "inline", "inline-flex", "inline-block", "hidden", "contents",
  "relative", "absolute", "fixed", "sticky", "static", "uppercase", "lowercase", "capitalize",
  "italic", "truncate", "underline", "no-underline", "shrink", "grow",
]);
/**
 * The value half has to look like one too, or the app's own names get swept in: `top-actions`
 * and `text-muted` share a prefix and only one of them is a utility.
 */
const COLORS = new Set(
  Object.keys((config.theme as { colors?: Record<string, string> }).colors ?? {}),
);
const VALUES = new Set([
  "t", "r", "b", "l", "x", "y", "full", "auto", "fit", "screen", "none", "px", "min", "max",
  "center", "start", "end", "between", "around", "evenly", "stretch", "baseline",
  "col", "row", "col-reverse", "row-reverse", "wrap", "nowrap", "hidden", "visible", "scroll",
  "ellipsis", "clip", "pointer", "default", "text", "move", "not-allowed", "grab", "col-resize",
  "middle", "top", "bottom", "cover", "contain", "fill", "normal", "medium", "semibold", "bold",
  "light", "mono", "sans", "serif", "sm", "md", "lg", "xl", "xs", "sheet", "pre", "pre-wrap",
  "transparent", "current", "inherit", "0", "1", "all", "left", "right", "justify",
]);

function utilityValue(v: string): boolean {
  if (!v) return false;
  if (/^\[.*\]$/.test(v)) return true;
  if (/^\d+(p\d)?$/.test(v)) return true;
  return VALUES.has(v) || COLORS.has(v);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".svelte")) out.push(p);
  }
  return out;
}

export function looksLikeUtility(token: string): boolean {
  if (BARE.has(token)) return true;
  // longest prefix first, so `max-w-17` is not read as the `m` prefix
  for (const p of [...PREFIXES].sort((a, b) => b.length - a.length)) {
    if (token.startsWith(p + "-")) return utilityValue(token.slice(p.length + 1));
  }
  return false;
}

const tokens = new Set<string>();
for (const path of walk("src")) {
  const text = readFileSync(path, "utf8");
  const markup = text.split("<style>")[0]!;
  for (const m of markup.matchAll(/class="([^"\n]*)"/g)) {
    for (const t of m[1]!.replace(/\{[^}]*\}/g, " ").split(/\s+/)) {
      if (t && looksLikeUtility(t)) tokens.add(t);
    }
  }
}

test("every utility-shaped class in the markup actually generates CSS", async () => {
  const uno = await createGenerator(config);
  const dead: string[] = [];
  for (const t of [...tokens].sort()) {
    const { css } = await uno.generate(t, { preflights: false });
    if (!css.replace(/\/\*[\s\S]*?\*\//g, "").trim()) dead.push(t);
  }
  expect(dead).toEqual([]);
});

test("the scan is looking at something", () => {
  expect(tokens.size).toBeGreaterThan(100);
});

test("a blocklisted utility is caught, not silently ignored", async () => {
  // Guards the guard: `border-t` generates nothing because of the blocklist, and that is exactly
  // the failure this file exists to make visible.
  const uno = await createGenerator(config);
  const { css } = await uno.generate("border-t", { preflights: false });
  expect(css.replace(/\/\*[\s\S]*?\*\//g, "").trim()).toBe("");
  expect(looksLikeUtility("border-t")).toBe(true);
});
