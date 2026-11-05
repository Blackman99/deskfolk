import { afterEach, describe, expect, test } from "bun:test";
import { INTERFACE_CODE_THEMES } from "@real-bot/protocol";
import { mountCssHighlight, tokensToHighlightedHtml } from "../css-highlight.ts";
import { monacoThemeName } from "../overlays/artifact-monaco.ts";
import { ensureHighlightLang, getShikiHighlighter, monacoShikiThemes, onCodeThemeChange, setCodeTheme, shikiThemes } from "../shiki-highlighter.ts";
import { CODE_THEME_LABELS, CODE_THEME_STYLE_ID, codeSurfaceCss, paintCodeSurfaces } from "./code-theme.ts";

afterEach(async () => {
  await setCodeTheme(undefined);
  document.getElementById(CODE_THEME_STYLE_ID)?.remove();
  document.body.innerHTML = "";
});

describe("code colours (ADR 0106)", () => {
  test("unset, chat keeps GitHub and the editor Vitesse", async () => {
    await setCodeTheme(undefined);
    expect(shikiThemes()).toEqual({ light: "github-light", dark: "github-dark" });
    expect(monacoShikiThemes()).toEqual({ light: "vitesse-light", dark: "vitesse-dark" });
    expect(monacoThemeName("light")).toBe("vitesse-light");
  });

  test("a theme chosen for one look paints chat and the editor in it; the other look keeps the app's own", async () => {
    await setCodeTheme({ dark: "dracula" });
    expect(shikiThemes()).toEqual({ light: "github-light", dark: "dracula" });
    expect(monacoThemeName("dark")).toBe("dracula");
    expect(monacoThemeName("light")).toBe("vitesse-light");
    await ensureHighlightLang("typescript");
    const html = tokensToHighlightedHtml("const x = 1;", await getShikiHighlighter(), "typescript");
    // Dracula's keywords are pink.
    expect(html.toLowerCase()).toContain("--shiki-dark:#ff79c6");
  });

  test("code already on screen is painted again once the theme is in", async () => {
    await ensureHighlightLang("typescript");
    const el = document.createElement("code");
    el.textContent = "const x = 1;";
    document.body.appendChild(el);
    const handle = mountCssHighlight(el, await getShikiHighlighter(), { lang: "typescript" });
    expect(el.innerHTML.toLowerCase()).not.toContain("#ff79c6");
    let told = 0;
    const stop = onCodeThemeChange(() => {
      told += 1;
    });
    await setCodeTheme({ dark: "dracula" });
    expect(told).toBe(1);
    expect(el.innerHTML.toLowerCase()).toContain("--shiki-dark:#ff79c6");
    // Asking for the same again does nothing.
    await setCodeTheme({ dark: "dracula" });
    expect(told).toBe(1);
    stop();
    handle.dispose();
  });

  test("the surfaces code sits on take the theme's own background and text colour", async () => {
    expect(codeSurfaceCss(null, null)).toBe("");
    expect(codeSurfaceCss(null, { bg: "#282a36", fg: "#f8f8f2" })).toBe(
      ":root {\n  --code-surface: initial;\n  --code-ink: initial;\n}\n\n:root[data-theme=\"dark\"],\n[data-theme=\"dark\"] {\n  --code-surface: #282a36;\n  --code-ink: #f8f8f2;\n}",
    );
    await setCodeTheme({ light: "solarized-light", dark: "dracula" });
    await paintCodeSurfaces();
    const css = document.getElementById(CODE_THEME_STYLE_ID)?.textContent?.toLowerCase() ?? "";
    expect(css).toContain("--code-surface: #282a36");
    expect(css).toContain("--code-surface: #fdf6e3");
    await setCodeTheme(undefined);
    await paintCodeSurfaces();
    expect(document.getElementById(CODE_THEME_STYLE_ID)).toBeNull();
  });

  test("a theme not on the list is left out", async () => {
    await setCodeTheme({ dark: "synthwave-84" as never });
    expect(shikiThemes().dark).toBe("github-dark");
  });

  test("every theme on the list loads, has a name, and gives a background and text colour", async () => {
    const highlighter = await getShikiHighlighter();
    for (const look of ["light", "dark"] as const) {
      for (const theme of INTERFACE_CODE_THEMES[look]) {
        await setCodeTheme({ [look]: theme });
        expect(highlighter.getLoadedThemes()).toContain(theme);
        expect(CODE_THEME_LABELS[theme]).toBeTruthy();
        const { bg, fg } = highlighter.getTheme(theme);
        expect({ theme, bg: Boolean(bg), fg: Boolean(fg) }).toEqual({ theme, bg: true, fg: true });
      }
    }
  });
});
