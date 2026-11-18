/** Your code colours (ADR 0106): the themes you pick from, by the names they go by. */
import type { InterfaceCodeThemeDark, InterfaceCodeThemeLight } from "@real-bot/protocol";

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
