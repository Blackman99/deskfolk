/**
 * Small pure helpers of the interface profile (ADR 0106) that the native windows share: the bubble
 * following a changed accent, the surface a window is, and whether the address asked for the app's
 * own look. The native app has no stylesheet to apply (ADR 0117).
 */
import type { InterfaceSurface } from "@real-bot/protocol";
import { HOSTED_MESSENGER } from "../remote/mode.ts";

/**
 * Your own lines' bubble (`--you`) is written out in `tokens.css` rather than taken from the
 * accent: light it is the accent's own colour, dark a step deeper so white words read on it. A
 * profile that changes the accent in a look but not the bubble has the bubble follow, the same way:
 * light takes the accent and its text colour, dark the accent mixed 70% with black in oklab (the
 * default accent comes out as the default bubble, #276c78 for #1b6b7a). Set `--you` to keep it apart.
 */
const YOU_FROM_ACCENT: Record<"light" | "dark", Record<string, string>> = {
  light: { "--you": "var(--accent)", "--you-text": "var(--on-accent)" },
  dark: { "--you": "color-mix(in oklab, var(--accent) 70%, black)" },
};

export function followingAccent(tokens: Record<string, string>, look: "light" | "dark"): Record<string, string> {
  if (!("--accent" in tokens)) return tokens;
  const out = { ...tokens };
  for (const [name, value] of Object.entries(YOU_FROM_ACCENT[look])) {
    if (!(name in tokens)) out[name] = value;
  }
  return out;
}

/** Whether the page was opened asking for the app's own look (`?ui=default`): a way back no stylesheet can hide. */
export function defaultAskedInUrl(loc: { search: string } | undefined = typeof location === "undefined" ? undefined : location): boolean {
  if (!loc) return false;
  return new URLSearchParams(loc.search).get("ui") === "default";
}

export function surfaceOf(narrow: boolean, hosted = HOSTED_MESSENGER): InterfaceSurface {
  if (narrow) return "phone";
  return hosted ? "tablet" : "desktop";
}
