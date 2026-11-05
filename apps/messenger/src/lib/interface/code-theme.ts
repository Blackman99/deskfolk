/**
 * Your code colours (ADR 0106) on the page: a theme's token colours are made for its own
 * background, so the surfaces code sits on — chat's code blocks, a command's output — take that
 * background and text colour too, through `--code-surface` and `--code-ink`. A look with no theme
 * chosen sets them to `initial`, and the surfaces fall back to the app's own.
 */
import type { InterfaceCodeThemeDark, InterfaceCodeThemeLight } from "@real-bot/protocol";
import { chosenCodeTheme, codeThemeSurface } from "../shiki-highlighter.ts";

/** How each code theme is called where you pick one: their own names, the same in every language. */
export const CODE_THEME_LABELS: Record<InterfaceCodeThemeLight | InterfaceCodeThemeDark, string> = {
  "github-light": "GitHub Light",
  "vitesse-light": "Vitesse Light",
  "one-light": "One Light",
  "solarized-light": "Solarized Light",
  "catppuccin-latte": "Catppuccin Latte",
  "rose-pine-dawn": "Rosé Pine Dawn",
  "gruvbox-light-medium": "Gruvbox Light",
  "everforest-light": "Everforest Light",
  "light-plus": "Light+ (VS Code)",
  "min-light": "Min Light",
  "github-dark": "GitHub Dark",
  "vitesse-dark": "Vitesse Dark",
  "one-dark-pro": "One Dark Pro",
  dracula: "Dracula",
  nord: "Nord",
  "tokyo-night": "Tokyo Night",
  "solarized-dark": "Solarized Dark",
  "catppuccin-mocha": "Catppuccin Mocha",
  "rose-pine": "Rosé Pine",
  monokai: "Monokai",
  "gruvbox-dark-medium": "Gruvbox Dark",
  "dark-plus": "Dark+ (VS Code)",
  "min-dark": "Min Dark",
};

export const CODE_THEME_STYLE_ID = "deskfolk-code-theme";

type Surface = { bg: string; fg: string } | null;

export function codeSurfaceCss(light: Surface, dark: Surface): string {
  const side = (surface: Surface) => surface
    ? `  --code-surface: ${surface.bg};\n  --code-ink: ${surface.fg};`
    : "  --code-surface: initial;\n  --code-ink: initial;";
  if (!light && !dark) return "";
  return `:root {\n${side(light)}\n}\n\n:root[data-theme="dark"],\n[data-theme="dark"] {\n${side(dark)}\n}`;
}

/** Writes the surfaces for the code colours in force; none chosen takes the style away. */
export async function paintCodeSurfaces(doc: Document | undefined = typeof document === "undefined" ? undefined : document): Promise<void> {
  if (!doc) return;
  const chosen = chosenCodeTheme();
  const light = chosen.light ? await codeThemeSurface(chosen.light) : null;
  const dark = chosen.dark ? await codeThemeSurface(chosen.dark) : null;
  // Chosen again while these were read: the later call paints.
  if (JSON.stringify(chosenCodeTheme()) !== JSON.stringify(chosen)) return;
  const css = codeSurfaceCss(light, dark);
  let style = doc.getElementById(CODE_THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = doc.createElement("style");
    style.id = CODE_THEME_STYLE_ID;
    doc.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}
