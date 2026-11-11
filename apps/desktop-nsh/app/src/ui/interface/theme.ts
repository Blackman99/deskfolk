/**
 * Your interface profile's tokens as NSH's theme (ADR 0108 decisions 2 and 3): the app's own theme
 * (`theme.json`, made from `tokens.css` by `scripts/theme-from-tokens.ts`) with the profile's
 * values laid over it, look by look, and NSH's own tokens worked out again from the result, put in
 * force at run time.
 *
 * The one place the app calls NSH's internal `setup()` of `nsh:rt` (typed in `nsh-rt.d.ts`): the
 * entry loads `nsh.json`'s theme with it, and a second call swaps the theme while the app runs —
 * `token()`, classes and `nsh/base` all follow, on the desktops, the web and in tests. When NSH
 * has a public `setTheme`, it replaces the three calls here.
 *
 * Names follow the script: no `--`, `--accent` is `brand`, `--muted` is `ink-muted`, and the same
 * inside `var()`. A value NSH cannot read would not just be ignored — it takes the other look's
 * value, or drops the token and every class naming it — so each is read by the engine first, under
 * a name of its own, and left out when it does not come back as the kind the app's token is. Values
 * naming each other in a ring are left out too (NSH refuses the whole theme for one).
 */
import { batch, colorScheme, signal, token, untracked } from "nsh";
import { setup } from "nsh:rt";
import type { InterfaceProfile } from "@real-bot/protocol";
import { followingAccent } from "../../m/interface/apply.ts";
import appTheme from "../../../theme.json";

type Vars = Record<string, string>;
export type ThemeFile = { cssVars: { theme: Vars; light: Vars; dark: Vars } };
export type Look = "light" | "dark";

export const APP_THEME = appTheme as ThemeFile;
const APP_JSON = JSON.stringify(APP_THEME);

const RENAME: Record<string, string> = { accent: "brand", muted: "ink-muted" };

/** A profile's token (`--accent`) by the theme's name (`brand`). */
export function themeName(name: string): string {
  const bare = name.replace(/^--/, "");
  return RENAME[bare] ?? bare;
}

/** A profile's value with the `var()`s it names renamed as the theme has them. */
export function themeValue(value: string): string {
  return value.replace(/var\(\s*--([a-z0-9-]+)/gi, (_m, ref: string) => `var(--${RENAME[ref] ?? ref}`);
}

/**
 * NSH's own tokens (what `nsh/base` draws with) from the app's: `builtins()` of
 * `scripts/theme-from-tokens.ts`, the same table (the script reads files under Bun, so the app
 * cannot import it). An empty profile must give `theme.json` back exactly (`roundTrip`).
 */
const BUILTINS: Record<string, { from: string } | { value: string }> = {
  background: { from: "bg" },
  foreground: { from: "ink" },
  card: { from: "pane" },
  "card-foreground": { from: "ink" },
  popover: { from: "pane" },
  "popover-foreground": { from: "ink" },
  primary: { from: "brand" },
  "primary-foreground": { from: "you-text" },
  secondary: { from: "line-subtle" },
  "secondary-foreground": { from: "ink-secondary" },
  muted: { from: "line-subtle" },
  "muted-foreground": { from: "ink-muted" },
  accent: { from: "accent-tint" },
  "accent-foreground": { from: "brand" },
  destructive: { from: "danger" },
  border: { from: "line" },
  input: { from: "line" },
  ring: { from: "brand" },
  sidebar: { value: "rgba(0, 0, 0, 0)" },
  "sidebar-foreground": { from: "ink" },
  "sidebar-accent": { from: "accent-tint" },
  "sidebar-accent-foreground": { from: "brand" },
  "sidebar-border": { from: "line" },
  "you-foreground": { from: "you-text" },
};

function builtins(t: Vars): Vars {
  const out: Vars = {};
  for (const [name, rule] of Object.entries(BUILTINS)) {
    const value = "value" in rule ? rule.value : t[rule.from];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** The tokens the app's theme has a place for; NSH's own are worked out, not set. */
const PLACES = new Set([...Object.keys(APP_THEME.cssVars.light), ...Object.keys(APP_THEME.cssVars.dark)].filter((name) => !(name in BUILTINS)));

/** One value of the profile, as the theme names it. */
type Entry = { look: Look; name: string; value: string; from: string };

/** What the last paint did with the profile's tokens (by the profile's names, `light:--accent`). */
export type ThemeOutcome = {
  on: boolean;
  /** In force. */
  applied: string[];
  /** The theme has no place for them (shadows, durations, type sizes, NSH's own tokens). */
  notHere: string[];
  /** NSH could not read the value as the kind of token it is, or it names itself through others. */
  unread: string[];
};

/** The theme `entries` make: the app's, the entries over it, NSH's own worked out again. */
export function themeWith(entries: readonly Entry[]): ThemeFile {
  const { theme, light: appLight, dark: appDark } = APP_THEME.cssVars;
  const light: Vars = { ...appLight };
  const dark: Vars = { ...appDark };
  for (const entry of entries) (entry.look === "light" ? light : dark)[entry.name] = entry.value;
  return {
    cssVars: {
      theme: { ...theme },
      light: { ...light, ...builtins(light) },
      dark: { ...dark, ...builtins({ ...light, ...dark }) },
    },
  };
}

/** The profile's tokens that have a place, renamed, `--you` following `--accent` as ADR 0106 has it. */
export function profileEntries(profile: InterfaceProfile): { entries: Entry[]; notHere: string[] } {
  const entries: Entry[] = [];
  const notHere: string[] = [];
  for (const look of ["light", "dark"] as const) {
    for (const [from, value] of Object.entries(followingAccent(profile.tokens[look], look))) {
      const name = themeName(from);
      const key = `${look}:${from}`;
      if (PLACES.has(name)) entries.push({ look, name, value: themeValue(value), from: key });
      else if (from in profile.tokens[look]) notHere.push(key);
    }
  }
  return { entries, notHere };
}

/** The names a value refers to through `var()`. */
function refs(value: string | undefined): string[] {
  return value ? [...value.matchAll(/var\(\s*--([a-z0-9-]+)/gi)].map((m) => m[1]!) : [];
}

/** The entries whose name comes back to itself through the `var()`s of `vars`. */
function inRings(vars: Vars, names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const start of names) {
    const seen = new Set<string>();
    const stack = refs(vars[start]);
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (at === start) {
        out.add(start);
        break;
      }
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...refs(vars[at]));
    }
  }
  return out;
}

const read = (name: string): unknown => (token as unknown as (name: string) => unknown)(name);
const kindOf = (value: unknown): "colour" | "number" | "other" | "none" =>
  value === undefined || value === null ? "none" : typeof value === "number" ? "number" : typeof value === "string" && /^#[0-9a-f]{8}$/i.test(value) ? "colour" : "other";

let current = APP_JSON;
const outcome = signal<ThemeOutcome>({ on: false, applied: [], notHere: [], unread: [] });
const settle = (next: ThemeOutcome): ThemeOutcome => {
  outcome.set(next);
  return next;
};

function put(json: string): void {
  setup(null, json, null, null);
}

/** The probe names a check reads values back under, in both looks so neither fills the other. */
const PROBE = "zz-interface-probe-";

/**
 * The entries NSH reads as the kind of token each replaces: all are tried at once under names of
 * their own over the app's theme. Leaves that theme in force: the caller puts the real one next,
 * in the same turn, so nothing of it is drawn.
 */
function readable(entries: readonly Entry[]): Entry[] {
  const { theme, light, dark } = APP_THEME.cssVars;
  const probes: Vars = {};
  entries.forEach((entry, i) => (probes[`${PROBE}${i}`] = entry.value));
  const file: ThemeFile = { cssVars: { theme, light: { ...light, ...probes }, dark: { ...dark, ...probes } } };
  put(JSON.stringify(file));
  return entries.filter((entry, i) => {
    const want = kindOf(read(entry.name));
    return want !== "none" && kindOf(read(`${PROBE}${i}`)) === want;
  });
}

/**
 * Puts `profile`'s tokens in force over the app's theme, or the app's theme alone (null, or `on`
 * false). Returns what took; `themeOutcome()` keeps it for the window's report and the story.
 */
export function paintProfile(profile: InterfaceProfile | null, on = true): ThemeOutcome {
  return untracked(() =>
    batch(() => {
      if (!profile || !on) {
        if (current !== APP_JSON) put((current = APP_JSON));
        return settle({ on: false, applied: [], notHere: [], unread: [] });
      }
      const { entries, notHere } = profileEntries(profile);
      const probed = entries.length > 0;
      const good = probed ? readable(entries) : [];
      // Rings: every name the profile sets, followed through its look's `var()`s (dark falls back to light).
      const file = themeWith(good);
      const ringed = new Set<string>();
      for (const look of ["light", "dark"] as const) {
        const vars = look === "light" ? file.cssVars.light : { ...file.cssVars.light, ...file.cssVars.dark };
        for (const name of inRings(vars, good.filter((e) => e.look === look).map((e) => e.name))) ringed.add(`${look}:${name}`);
      }
      const kept = good.filter((e) => !ringed.has(`${e.look}:${e.name}`));
      const json = JSON.stringify(kept.length === good.length ? file : themeWith(kept));
      // After a probe the probe's theme is in force, so the real one goes in even when unchanged.
      if (probed || json !== current) put((current = json));
      // NSH refuses a whole theme it cannot read and keeps the last: the probes still answering means it did.
      if (probed && read(`${PROBE}0`) !== undefined) {
        put((current = APP_JSON));
        return settle({ on: false, applied: [], notHere, unread: entries.map((e) => e.from) });
      }
      const unread = entries.filter((e) => !kept.includes(e)).map((e) => e.from);
      return settle({ on: true, applied: kept.map((e) => e.from), notHere, unread });
    }),
  );
}

/** What the last paint did (reactive). */
export function themeOutcome(): ThemeOutcome {
  return outcome();
}

/** Token values in the look shown now, under the theme in force. */
export function tokensNow(names: readonly string[]): Record<string, unknown> {
  return untracked(() => Object.fromEntries(names.map((name) => [name, read(name)])));
}

/** The app's own values, by look: `theme.json` does not change while the app runs. */
const appValues: Record<Look, Map<string, unknown>> = { light: new Map(), dark: new Map() };

/**
 * Token values in the look shown now under the app's own theme. Each is read once per look: while a
 * profile is in force the app's theme is put in and the profile's back within this turn, so nothing
 * of it is drawn, and a check after that (a floor scrolled in) swaps nothing.
 */
export function tokensOfApp(names: readonly string[]): Record<string, unknown> {
  return untracked(() => {
    const known = appValues[colorScheme() === "dark" ? "dark" : "light"];
    const missing = names.filter((name) => !known.has(name));
    if (missing.length > 0) {
      const values =
        current === APP_JSON
          ? tokensNow(missing)
          : batch(() => {
              put(APP_JSON);
              const out = tokensNow(missing);
              put(current);
              return out;
            });
      for (const name of missing) known.set(name, values[name]);
    }
    return Object.fromEntries(names.map((name) => [name, known.get(name)]));
  });
}

/** Whether an empty profile gives `theme.json` back exactly: the builtins table matches the script's. */
export function roundTrip(): boolean {
  return JSON.stringify(themeWith([])) === APP_JSON;
}
