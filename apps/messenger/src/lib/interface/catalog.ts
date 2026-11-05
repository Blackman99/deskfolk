/**
 * What the app has for a Bot to look things up in (ADR 0106): every design token with its default in
 * each look, read off the stylesheets this window loaded, and every plain string of its words. The
 * desktop window sends it once per connection; the daemon keeps it in memory for `describe_interface`.
 * Neither your profile's sheet nor the code colours' surfaces count as the app's.
 */
import type { InterfaceCatalog } from "@real-bot/protocol";
import { COPY, copyLeaves } from "../copy.ts";
import { INTERFACE_STYLE_ID } from "./apply.ts";
import { CODE_THEME_STYLE_ID } from "./code-theme.ts";

type TokenDefaults = { light: Map<string, string>; dark: Map<string, string> };

function walk(rules: CSSRuleList, into: TokenDefaults): void {
  for (const rule of Array.from(rules)) {
    const style = (rule as CSSStyleRule).style;
    const selector = (rule as CSSStyleRule).selectorText;
    if (style && typeof selector === "string") {
      const parts = selector.split(",").map((part) => part.trim());
      const side = parts.includes(":root") ? "light" : parts.some((part) => part.startsWith(":root[data-theme=\"dark\"]") || part.startsWith(":root[data-theme='dark']")) ? "dark" : null;
      if (side) {
        for (let at = 0; at < style.length; at += 1) {
          const name = style[at]!;
          if (name.startsWith("--")) into[side].set(name, style.getPropertyValue(name).trim());
        }
      }
    }
    const nested = (rule as CSSGroupingRule).cssRules;
    // Only rules that always apply: a token under `@media (prefers-color-scheme)` is the fallback before the theme is known.
    if (nested && !(rule as CSSMediaRule).media) walk(nested, into);
  }
}

/** The tokens the app's own sheets define, by look; your profile's sheet is left out. */
export function tokenDefaults(doc: Document = document): TokenDefaults {
  const into: TokenDefaults = { light: new Map(), dark: new Map() };
  for (const sheet of Array.from(doc.styleSheets)) {
    const owner = (sheet.ownerNode as Element | null)?.id;
    if (owner === INTERFACE_STYLE_ID || owner === CODE_THEME_STYLE_ID) continue;
    try {
      walk(sheet.cssRules, into);
    } catch {
      // A sheet from elsewhere that will not be read.
    }
  }
  return into;
}

export function interfaceCatalog(appVersion: string | null, doc: Document = document): InterfaceCatalog {
  const defaults = tokenDefaults(doc);
  const names = [...new Set([...defaults.light.keys(), ...defaults.dark.keys()])].sort();
  return {
    app_version: appVersion,
    tokens: names.map((name) => ({ name, light: defaults.light.get(name) ?? null, dark: defaults.dark.get(name) ?? null })),
    copy: { zh: copyLeaves(COPY.zh), en: copyLeaves(COPY.en) },
  };
}
