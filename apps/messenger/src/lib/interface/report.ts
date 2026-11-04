/**
 * What a window tells the daemon after applying your interface (ADR 0106), so a Bot that cannot see
 * the screen can tell what took: selectors of the stylesheet matching nothing here just now, rules
 * the browser could not read, token values it would not take.
 */
import type { InterfaceProfile } from "@real-bot/protocol";

const UNMATCHED_MAX = 50;
/** States and parts no `querySelector` can match on a page at rest: dropped before asking. */
const DYNAMIC = /::?(?:hover|focus|focus-visible|focus-within|active|visited|target|checked|placeholder-shown|before|after|placeholder|selection|marker|backdrop|first-line|first-letter|file-selector-button|-webkit-[a-z-]+|-moz-[a-z-]+)(?:\([^)]*\))?/g;

/** The stylesheet's top-level blocks, each as written; comments and strings are kept whole. */
export function topLevelBlocks(css: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < css.length; at += 1) {
    const ch = css[at];
    if (ch === "/" && css[at + 1] === "*") {
      const end = css.indexOf("*/", at + 2);
      at = end < 0 ? css.length : end + 1;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      let end = at + 1;
      while (end < css.length && css[end] !== ch) end += css[end] === "\\" ? 2 : 1;
      at = end;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const block = css.slice(start, at + 1).trim();
        if (block) blocks.push(block);
        start = at + 1;
      }
      if (depth < 0) depth = 0;
    } else if (ch === ";" && depth === 0) {
      // A statement at the top: `@charset`, `@layer a, b;`.
      const block = css.slice(start, at + 1).trim();
      if (block) blocks.push(block);
      start = at + 1;
    }
  }
  const tail = css.slice(start).trim();
  if (tail && !/^\/\*[\s\S]*\*\/$/.test(tail)) blocks.push(tail);
  return blocks;
}

/** How many of those blocks the browser drops; null where it cannot be asked (no constructable sheets). */
export function droppedBlocks(css: string): number | null {
  if (typeof CSSStyleSheet === "undefined" || typeof CSSStyleSheet.prototype.replaceSync !== "function") return null;
  let dropped = 0;
  for (const block of topLevelBlocks(css)) {
    if (/^\/\*[\s\S]*\*\/$/.test(block)) continue;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(block);
      if (sheet.cssRules.length === 0) dropped += 1;
    } catch {
      dropped += 1;
    }
  }
  return dropped;
}

function styleRules(rules: CSSRuleList, out: CSSStyleRule[]): void {
  for (const rule of Array.from(rules)) {
    if ("selectorText" in rule && typeof (rule as CSSStyleRule).selectorText === "string") out.push(rule as CSSStyleRule);
    const nested = (rule as CSSGroupingRule).cssRules;
    if (nested) styleRules(nested, out);
  }
}

/** Selectors of the sheet that match nothing in `root` right now (each part of a list on its own). */
export function unmatchedSelectors(sheet: CSSStyleSheet | null, root: ParentNode = document): string[] {
  if (!sheet) return [];
  let rules: CSSStyleRule[] = [];
  try {
    styleRules(sheet.cssRules, rules);
  } catch {
    rules = [];
  }
  const out: string[] = [];
  for (const rule of rules) {
    for (const part of rule.selectorText.split(",")) {
      const selector = part.trim();
      if (!selector || selector === ":root" || selector.startsWith(":root[data-theme") || selector === "[data-theme=\"dark\"]") continue;
      const asked = selector.replace(DYNAMIC, "").trim() || "*";
      try {
        if (!root.querySelector(asked) && !out.includes(selector)) out.push(selector);
      } catch {
        // A selector this engine cannot ask about: not reported.
      }
      if (out.length >= UNMATCHED_MAX) return out;
    }
  }
  return out;
}

/**
 * Token values the browser would not take: one that is not a declaration at all, or one standing in
 * for a colour that is not a colour.
 */
export function badTokens(profile: InterfaceProfile, defaults: ReadonlyMap<string, string>, css: { supports(property: string, value: string): boolean } | undefined = globalThis.CSS): string[] {
  if (!css?.supports) return [];
  const out: string[] = [];
  for (const side of ["light", "dark"] as const) {
    for (const [name, value] of Object.entries(profile.tokens[side])) {
      const fallback = defaults.get(name);
      const colour = fallback !== undefined && css.supports("color", fallback);
      const ok = css.supports(name, value) && (!colour || css.supports("color", value) || /var\(/.test(value));
      if (!ok && !out.includes(name)) out.push(name);
    }
  }
  return out;
}
