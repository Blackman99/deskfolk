/**
 * Writes `app/theme.json` (NSH's theme, shadcn's `cssVars`) from the messenger's design tokens
 * (`apps/messenger/src/lib/styles/tokens.css`, brand direction A), so the NSH screens use the same
 * colours, radii and type scale by the same names: `--ink` is `text-ink`, `--line` is
 * `border-line`, `--pane` is `bg-pane`, `--radius-md` is `rounded-(--radius-md)`.
 *
 * Two names would collide with NSH's own tokens, which `nsh/base` components read with another
 * meaning, so they are renamed: `--accent` (the brand teal) is `brand`, `--muted` (grey text) is
 * `ink-muted`. NSH's own tokens (`background`, `primary`, `muted`, `accent`, `sidebar`, …) are
 * mapped from the messenger's, so `nsh/base` components wear the brand too.
 *
 * Shadows, durations and easings are not theme values in NSH and are left out.
 *
 *   bun apps/desktop-nsh/scripts/theme-from-tokens.ts [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const tokensPath = resolve(root, "../messenger/src/lib/styles/tokens.css");
const out = join(root, "app", "theme.json");
const css = readFileSync(tokensPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const RENAME: Record<string, string> = { accent: "brand", muted: "ink-muted" };

function block(selectorStart: RegExp): Map<string, string> {
  const at = css.search(selectorStart);
  if (at < 0) throw new Error(`no block ${selectorStart}`);
  const open = css.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = css.slice(open + 1, end);
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(match[1]!, match[2]!.trim().replace(/\s+/g, " "));
  return tokens;
}

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|color-mix\(|transparent$|white$|black$|currentColor$)/i;
const LENGTH = /^-?\d+(\.\d+)?(px|rem)$/;

function value(name: string, raw: string, all: Map<string, string>, seen = new Set<string>()): string | null {
  const v = raw.replace(/var\(--([a-z0-9-]+)\)/g, (_m, ref: string) => `var(--${RENAME[ref] ?? ref})`);
  if (/^var\(--[a-z0-9-]+\)$/.test(v)) {
    // A token that is another token: keep it if that one is a value NSH takes.
    const ref = raw.slice(6, -1);
    if (seen.has(ref)) return null;
    seen.add(ref);
    const target = all.get(ref);
    return target && value(ref, target, all, seen) !== null ? v : null;
  }
  if (name.startsWith("font") && !name.startsWith("font-size") && !name.startsWith("font-weight")) return v;
  if (name === "mono") return v;
  if (COLOR.test(v) && !/\d+px/.test(v)) return v;
  if (LENGTH.test(v)) return v;
  return null;
}

function convert(tokens: Map<string, string>, all: Map<string, string>): Record<string, string> {
  const outTokens: Record<string, string> = {};
  for (const [name, raw] of tokens) {
    const v = value(name, raw, all);
    if (v !== null) outTokens[RENAME[name] ?? name] = v;
  }
  return outTokens;
}

/**
 * `--ground-tint` is a share, not a colour, so NSH has no token for it. What it is for is: the ground
 * over the window's material (`Shell.svelte`, `color-mix(--ground --ground-tint, transparent)`),
 * so that colour is the token, `bg-ground-glass`, in each look.
 */
function groundGlass(all: Map<string, string>): Record<string, string> {
  const tint = all.get("ground-tint");
  return tint ? { "ground-glass": `color-mix(in srgb, var(--ground) ${tint}, transparent)` } : {};
}

/**
 * The sidebar's quiet greys on the material (`Sidebar.svelte`: `.side` under `data-material="glass"`
 * and dark sets `--muted: #a8b3b8; --muted-light: #8b989e`). Dark glass is lighter than the dark
 * ground was, so there they go up a step: a preview line keeps 4:1 at the glass's bright end and
 * the search icon stays legible; light keeps its own. Not in tokens.css (a selector's, not the
 * root's), so named here: `text-ink-muted-glass`, `tint-muted-light-glass`.
 */
const MUTED_ON_GLASS = {
  light: { "ink-muted-glass": "var(--ink-muted)", "muted-light-glass": "var(--muted-light)" },
  dark: { "ink-muted-glass": "#a8b3b8", "muted-light-glass": "#8b989e" },
};

const light = block(/:root\s*\{/);
const dark = block(/:root\[data-theme="dark"\]/);
const allLight = new Map(light);
const allDark = new Map([...light, ...dark]);
const lightOut = { ...convert(light, allLight), ...groundGlass(allLight), ...MUTED_ON_GLASS.light };
const darkOut = { ...convert(dark, allDark), ...groundGlass(allDark), ...MUTED_ON_GLASS.dark };

/** NSH's own tokens, from the messenger's, so `nsh/base` wears the brand. */
function builtins(t: Record<string, string>): Record<string, string> {
  const pick = (...names: string[]) => names.map((n) => t[n]).find((v) => v !== undefined) ?? null;
  const map: Record<string, string | null> = {
    background: pick("bg"),
    foreground: pick("ink"),
    card: pick("pane"),
    "card-foreground": pick("ink"),
    popover: pick("pane"),
    "popover-foreground": pick("ink"),
    primary: pick("brand"),
    "primary-foreground": pick("you-text"),
    secondary: pick("line-subtle"),
    "secondary-foreground": pick("ink-secondary"),
    muted: pick("line-subtle"),
    "muted-foreground": pick("ink-muted"),
    accent: pick("accent-tint"),
    "accent-foreground": pick("brand"),
    destructive: pick("danger"),
    border: pick("line"),
    input: pick("line"),
    ring: pick("brand"),
    sidebar: "rgba(0, 0, 0, 0)",
    "sidebar-foreground": pick("ink"),
    "sidebar-accent": pick("accent-tint"),
    "sidebar-accent-foreground": pick("brand"),
    "sidebar-border": pick("line"),
    "you-foreground": pick("you-text"),
  };
  return Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => e[1] !== null));
}

const theme = {
  cssVars: {
    theme: {
      radius: "10px",
      "font-sans": "system-ui",
      // The platform's own monospace (SF Mono on a Mac, Consolas on Windows): a named family the
      // system lacks falls back to the proportional system font.
      "font-mono": "monospace",
    },
    light: { ...lightOut, ...builtins({ ...lightOut }) },
    dark: { ...darkOut, ...builtins({ ...lightOut, ...darkOut }) },
  },
};
const text = `${JSON.stringify(theme, null, 2)}\n`;

// Shadows and focus rings are not theme values: a module of them per look, `var()`s resolved.
function resolved(raw: string, all: Map<string, string>, depth = 0): string {
  if (depth > 8) return raw;
  return raw.replace(/var\(--([a-z0-9-]+)(?:,\s*([^)]+))?\)/g, (_m, ref: string, fallback?: string) => {
    const target = all.get(ref);
    return target ? resolved(target, all, depth + 1) : (fallback ?? "transparent");
  });
}
function shadows(all: Map<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, raw] of all) {
    if (name.startsWith("shadow-") || name.endsWith("focus-ring")) result[name.replace(/^shadow-/, "")] = resolved(raw, all);
  }
  return result;
}
const shadowsOut = join(root, "app", "src", "ui", "shadows.generated.ts");
const shadowsText =
  `// Generated by scripts/theme-from-tokens.ts from apps/messenger/src/lib/styles/tokens.css; do not edit.\n` +
  `export const SHADOWS = ${JSON.stringify({ light: shadows(allLight), dark: shadows(allDark) }, null, 2)} as const;\n`;

if (process.argv.includes("--check")) {
  let stale = false;
  if (readFileSync(out, "utf8") !== text) {
    console.error("app/theme.json is behind tokens.css: run scripts/theme-from-tokens.ts");
    stale = true;
  }
  if (readFileSync(shadowsOut, "utf8") !== shadowsText) {
    console.error("app/src/ui/shadows.generated.ts is behind tokens.css: run scripts/theme-from-tokens.ts");
    stale = true;
  }
  if (stale) process.exit(1);
  console.log("app/theme.json and the shadows match tokens.css");
} else {
  writeFileSync(out, text);
  writeFileSync(shadowsOut, shadowsText);
  console.log(`app/theme.json: ${Object.keys(theme.cssVars.light).length} light, ${Object.keys(theme.cssVars.dark).length} dark tokens; shadows written`);
}
