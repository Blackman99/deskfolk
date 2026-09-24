import type { TerminalColors } from "@real-bot/protocol";
import type { ITheme } from "@xterm/xterm";
import type { ISearchDecorationOptions } from "@xterm/addon-search";
import type { ResolvedTheme } from "../theme.ts";

/**
 * The terminal's colours, in step with the app's light and dark.
 *
 * Background and text are the pane's own tokens, so a terminal is the pane it sits in and not a
 * black hole in a light window. The sixteen ANSI colours are the same slate-and-blue family the
 * rest of the app is drawn in: brighter ones on the dark pane, deeper ones on the white one.
 */
const ANSI: Record<ResolvedTheme, Required<Pick<ITheme,
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow" | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite"
>>> = {
  light: {
    black: "#0f172a",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#94a3b8",
    brightBlack: "#64748b",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#eab308",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#e2e8f0",
  },
  dark: {
    black: "#334155",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#facc15",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#cbd5e1",
    brightBlack: "#64748b",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#f8fafc",
  },
};

/** What the pane tokens resolve to when a stylesheet has not loaded, as in a test. */
const FALLBACK: Record<ResolvedTheme, { background: string; foreground: string }> = {
  light: { background: "#ffffff", foreground: "#0f172a" },
  dark: { background: "#161e2b", foreground: "#f1f5f9" },
};

const SELECTION: Record<ResolvedTheme, { active: string; inactive: string }> = {
  light: { active: "#2563eb40", inactive: "#94a3b840" },
  dark: { active: "#60a5fa4d", inactive: "#64748b4d" },
};

export function terminalTheme(resolved: ResolvedTheme, token: (name: string) => string = () => ""): ITheme {
  const background = token("--pane").trim() || FALLBACK[resolved].background;
  const foreground = token("--ink").trim() || FALLBACK[resolved].foreground;
  return {
    ...ANSI[resolved],
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: SELECTION[resolved].active,
    selectionInactiveBackground: SELECTION[resolved].inactive,
  };
}

const ANSI_ORDER = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/**
 * A theme as the daemon wants it for answering colour requests: `#rrggbb` only. A token that is
 * not a plain colour (a `#fff`, an `rgb()`) is spelled out or, failing that, left to the fallback.
 */
export function terminalColors(resolved: ResolvedTheme, theme: ITheme): TerminalColors {
  const background = hex6(theme.background) ?? FALLBACK[resolved].background;
  const foreground = hex6(theme.foreground) ?? FALLBACK[resolved].foreground;
  const palette = ANSI_ORDER.map((name) => hex6(theme[name]));
  return {
    foreground,
    background,
    cursor: hex6(theme.cursor) ?? foreground,
    ...(palette.every((colour): colour is string => colour !== null) ? { palette } : {}),
  };
}

function hex6(colour: string | undefined): string | null {
  const value = colour?.trim().toLowerCase() ?? "";
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (rgb) return `#${rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
  return null;
}

/**
 * Programs pick colours for a black screen. On the white one, yellow and "white" text would be
 * all but invisible, so xterm is asked to darken whatever falls under WCAG's 4.5:1 there. The
 * dark pane is what those programs were written for and is left exactly as they asked.
 */
export function minimumContrast(resolved: ResolvedTheme): number {
  return resolved === "light" ? 4.5 : 1;
}

/** Find's highlights. xterm takes only `#RRGGBB` for these. */
export function findDecorations(resolved: ResolvedTheme): ISearchDecorationOptions {
  return resolved === "light"
    ? {
        matchBackground: "#fef08a",
        matchOverviewRuler: "#eab308",
        activeMatchBackground: "#fdba74",
        activeMatchColorOverviewRuler: "#ea580c",
      }
    : {
        matchBackground: "#713f12",
        matchOverviewRuler: "#ca8a04",
        activeMatchBackground: "#c2410c",
        activeMatchColorOverviewRuler: "#f97316",
      };
}

/** Light or dark as the window is showing it right now, which `data-theme` on the root says. */
export function documentTheme(root: HTMLElement | undefined = globalThis.document?.documentElement): ResolvedTheme {
  const attr = root?.getAttribute("data-theme");
  if (attr === "dark" || attr === "light") return attr;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
