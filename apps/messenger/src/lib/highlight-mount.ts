import type { HighlightLang } from "./highlight-lang.ts";
import { mountCssHighlight, type CssHighlightHandle } from "./css-highlight.ts";
import { ensureHighlightLang, getShikiHighlighter } from "./shiki-highlighter.ts";

export const HIGHLIGHT_CHAR_LIMIT = 200_000;

export async function bindCssHighlight(
  el: HTMLElement,
  lang: HighlightLang,
  opts: { watch?: boolean } = {},
): Promise<CssHighlightHandle | null> {
  if (!el.isConnected) return null;
  const size = el.textContent?.length ?? 0;
  if (size === 0 || size > HIGHLIGHT_CHAR_LIMIT) return null;
  await ensureHighlightLang(lang);
  if (!el.isConnected) return null;
  const highlighter = await getShikiHighlighter();
  if (!el.isConnected) return null;
  return mountCssHighlight(el, highlighter, { lang, watch: opts.watch ?? false });
}
