import type { HighlighterCore, ThemedToken } from "shiki/core";
import { SHIKI_THEMES } from "./shiki-highlighter.ts";
import type { HighlightLang } from "./highlight-lang.ts";

export type CssHighlightHandle = {
  dispose: () => void;
  update: () => void;
};

type MountOptions = {
  lang: HighlightLang;
  watch?: boolean;
  delay?: number;
};

function tokenHex(raw: string): string | null {
  const hex = raw.match(/#([0-9a-fA-F]{3,8})\b/);
  return hex ? `#${hex[1]}` : null;
}

function themeFromStyleKey(key: string): string | null {
  const lower = key.toLowerCase();
  if (lower === "light" || lower.includes("light")) return "light";
  if (lower === "dark" || lower.includes("dark")) return "dark";
  return null;
}

export function themeColorsFromHtmlStyle(
  style: ThemedToken["htmlStyle"],
): Array<{ theme: string; color: string }> {
  if (!style || typeof style !== "object") return [];
  const out: Array<{ theme: string; color: string }> = [];
  for (const key of Object.keys(style)) {
    const theme = themeFromStyleKey(key);
    if (!theme) continue;
    const color = tokenHex(style[key] ?? "");
    if (!color) continue;
    out.push({ theme, color });
  }
  return out;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dualColors(token: ThemedToken): { light?: string; dark?: string } {
  const colors = themeColorsFromHtmlStyle(token.htmlStyle);
  let light: string | undefined;
  let dark: string | undefined;
  for (const row of colors) {
    if (row.theme === "light") light = row.color;
    if (row.theme === "dark") dark = row.color;
  }
  return { light, dark };
}

export function tokensToHighlightedHtml(
  source: string,
  highlighter: HighlighterCore,
  lang: HighlightLang,
): string {
  if (!source) return "";
  if (lang === "plaintext") return escapeHtml(source);

  const tokenized = highlighter.codeToTokens(source, {
    lang,
    themes: SHIKI_THEMES,
    cssVariablePrefix: "",
    defaultColor: false,
  });

  let html = "";
  for (let i = 0; i < tokenized.tokens.length; i++) {
    const line = tokenized.tokens[i]!;
    for (const token of line) {
      const text = escapeHtml(token.content);
      if (!text) continue;
      const { light, dark } = dualColors(token);
      if (!light && !dark) {
        html += text;
        continue;
      }
      const style = [
        light ? `--shiki-light:${light}` : "",
        dark ? `--shiki-dark:${dark}` : "",
      ]
        .filter(Boolean)
        .join(";");
      html += `<span class="tok" style="${style}">${text}</span>`;
    }
    if (i < tokenized.tokens.length - 1) html += "\n";
  }
  return html;
}

function throttle(fn: () => void, delay: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let trailing = false;
  return () => {
    if (timer) {
      trailing = true;
      return;
    }
    fn();
    timer = setTimeout(() => {
      timer = null;
      if (trailing) {
        trailing = false;
        fn();
      }
    }, delay);
  };
}

/** Paint Shiki tokens as spans with light/dark CSS variables (visible in WKWebView). */
export function mountCssHighlight(
  el: HTMLElement,
  highlighter: HighlighterCore,
  options: MountOptions,
): CssHighlightHandle {
  const lang = options.lang;
  const watch = options.watch ?? false;
  const delay = options.delay ?? 33;
  let disposed = false;
  let last = "";
  /** What this handle left in the element, so someone else's rewrite is still noticed. */
  let painted: ChildNode | null = null;

  const paintNow = (): void => {
    if (disposed) return;
    const source = el.textContent ?? "";
    // Looking for a token span instead missed plain text, which paints to itself and has no span
    // to find: every pass rewrote the block, and the rewrite woke the observer that asks for the
    // next pass — a plain fenced block flickered a dozen times a second for as long as it was on
    // screen, and took the markdown around it with it.
    if (source === last && el.firstChild === painted) return;
    const html = tokensToHighlightedHtml(source, highlighter, lang);
    last = source;
    if (html !== el.innerHTML) el.innerHTML = html;
    painted = el.firstChild;
  };

  const update = watch ? throttle(paintNow, delay) : paintNow;
  if (watch) el.addEventListener("input", update);
  paintNow();

  return {
    update,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (watch) el.removeEventListener("input", update);
    },
  };
}
