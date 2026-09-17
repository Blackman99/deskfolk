import { expect, test } from "bun:test";
import {
  escapeHtml,
  themeColorsFromHtmlStyle,
  tokensToHighlightedHtml,
} from "./css-highlight.ts";
import { ensureHighlightLang, getShikiHighlighter, SHIKI_THEMES } from "./shiki-highlighter.ts";

test("themeColorsFromHtmlStyle reads light/dark hex from Shiki htmlStyle", () => {
  expect(
    themeColorsFromHtmlStyle({
      light: "#111111",
      dark: "color:#eeeeee",
      "--dummy": "skip",
    }),
  ).toEqual([
    { theme: "light", color: "#111111" },
    { theme: "dark", color: "#eeeeee" },
  ]);
  expect(themeColorsFromHtmlStyle(undefined)).toEqual([]);
});

test("escapeHtml keeps token text from becoming markup", () => {
  expect(escapeHtml(`a <b> & "c"`)).toBe(`a &lt;b&gt; &amp; "c"`);
});

test("codeToTokens with dual github themes fills htmlStyle colors", async () => {
  await ensureHighlightLang("typescript");
  const highlighter = await getShikiHighlighter();
  const result = highlighter.codeToTokens("const x = 1;", {
    lang: "typescript",
    themes: SHIKI_THEMES,
    cssVariablePrefix: "",
    defaultColor: false,
  });
  const token = result.tokens.flat().find((row) => row.content.includes("const"));
  expect(token).toBeTruthy();
  const colors = themeColorsFromHtmlStyle(token?.htmlStyle);
  expect(colors.some((c) => c.theme === "light")).toBe(true);
  expect(colors.some((c) => c.theme === "dark")).toBe(true);
});

test("tokensToHighlightedHtml wraps JSON keys and strings in dual-theme spans", async () => {
  await ensureHighlightLang("json");
  const highlighter = await getShikiHighlighter();
  const html = tokensToHighlightedHtml(
    `{"currency":"CNY"}`,
    highlighter,
    "json",
  );
  expect(html).toContain('class="tok"');
  expect(html).toContain("--shiki-light:");
  expect(html).toContain("--shiki-dark:");
  expect(html).toContain("currency");
  expect(html).not.toContain("<script>");
});
