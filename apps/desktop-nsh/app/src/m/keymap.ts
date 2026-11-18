/**
 * The one place that knows which key is "the" shortcut modifier on this platform, and how a
 * shortcut is written down. Everything that used to sniff `navigator.platform` for ⌘ itself goes
 * through here instead, so the mac/Windows split is made once.
 */
import { desktopPlatform, type DesktopPlatform } from "./platform.ts";

type ModifierKeys = {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  getModifierState?: (key: string) => boolean;
};

/**
 * Ctrl+Alt held together, the way Windows reports AltGr on layouts that need it to type a
 * character (`@`, `\`, an accent) — `getModifierState` is the real signal where it exists,
 * `ctrlKey && altKey` the fallback for event doubles that don't implement it.
 */
export function isAltGraph(event: Pick<ModifierKeys, "ctrlKey" | "altKey" | "getModifierState">): boolean {
  if (typeof event.getModifierState === "function") {
    try {
      return event.getModifierState("AltGraph");
    } catch {
      // A double that declares the method without knowing this key name.
    }
  }
  return event.ctrlKey && event.altKey;
}

/**
 * Whether `event` carries this platform's "primary" shortcut modifier: ⌘ on mac, Ctrl elsewhere.
 * False while AltGr is down — someone typing a character, not invoking a shortcut.
 */
export function isPrimaryModifier(event: ModifierKeys, platform: DesktopPlatform = desktopPlatform()): boolean {
  if (isAltGraph(event)) return false;
  return platform === "mac" ? event.metaKey : event.ctrlKey;
}

/** A modifier token `formatShortcut` knows, or a literal key to print as-is (`"B"`, `"\\"`). */
export type ShortcutPart = "mod" | "shift" | "alt" | (string & {});

const MAC_GLYPH: Partial<Record<ShortcutPart, string>> = { shift: "⇧", alt: "⌥", mod: "⌘" };
const OTHER_LABEL: Partial<Record<ShortcutPart, string>> = { mod: "Ctrl", alt: "Alt", shift: "Shift" };
/** Ctrl, then Alt, then Shift — the order every non-mac label here is written in, whatever order `parts` lists them. */
const OTHER_ORDER: readonly ShortcutPart[] = ["mod", "alt", "shift"];

/**
 * A shortcut the way this platform writes it. Mac renders Apple's own glyphs in the order
 * `parts` gives them — Apple orders Shift before Command for some shortcuts and after for
 * others, so the caller's order is the one kept, not a fixed rule. Everywhere else the modifiers
 * are always Ctrl, then Alt, then Shift, joined with "+", however `parts` was written; only the
 * key itself keeps its position.
 *
 * `formatShortcut(["mod", "B"])` → `⌘B` / `Ctrl+B`; `formatShortcut(["shift", "mod", "\\"])` →
 * `⇧⌘\` / `Ctrl+Shift+\`.
 */
export function formatShortcut(parts: readonly ShortcutPart[], platform: DesktopPlatform = desktopPlatform()): string {
  if (platform === "mac") {
    return parts.map((part) => MAC_GLYPH[part] ?? part).join("");
  }
  const mods = OTHER_ORDER.filter((mod) => parts.includes(mod)).map((mod) => OTHER_LABEL[mod]!);
  const rest = parts.filter((part) => !(part in OTHER_LABEL));
  return [...mods, ...rest].join("+");
}
