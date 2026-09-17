import type { Theme } from "@real-bot/protocol";

export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "real-bot-theme";

/** Resolves the effective UI theme ('light' or 'dark') given user preference and system mode */
export function resolveTheme(preference: Theme, systemIsDark: boolean): ResolvedTheme {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return systemIsDark ? "dark" : "light";
}

/** Determines the next theme in the quick-toggle cycle */
export function nextTheme(current: Theme): Theme {
  if (current === "system") return "light";
  if (current === "light") return "dark";
  return "system";
}

/** Reads the cached theme preference from localStorage with safe fallback to 'system' */
export function getStoredThemePreference(): Theme {
  if (typeof window === "undefined" || !window.localStorage) {
    return "system";
  }
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") {
      return raw;
    }
  } catch {
    // Ignore localStorage access errors
  }
  return "system";
}

/** Saves the theme preference to localStorage */
export function saveStoredThemePreference(theme: Theme): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore localStorage write errors
  }
}

/** Applies resolved theme attributes and classes to the root document element */
export function applyThemeToDocument(resolved: ResolvedTheme, preference: Theme): void {
  if (typeof document === "undefined" || !document.documentElement) {
    return;
  }
  const root = document.documentElement;
  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-theme-preference", preference);
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

/** Pure TypeScript Theme Manager usable anywhere (browser, tests, SSR) */
export class ThemeManager {
  preference: Theme = "system";
  systemIsDark: boolean = false;
  private mediaQuery: MediaQueryList | null = null;
  private listener: ((e: MediaQueryListEvent) => void) | null = null;
  private subscribers = new Set<() => void>();

  get resolved(): ResolvedTheme {
    return resolveTheme(this.preference, this.systemIsDark);
  }

  constructor(initialPreference?: Theme) {
    this.preference = initialPreference ?? getStoredThemePreference();
    if (typeof window !== "undefined" && window.matchMedia) {
      this.mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      this.systemIsDark = this.mediaQuery.matches;
    }
  }

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private notify(): void {
    applyThemeToDocument(this.resolved, this.preference);
    for (const sub of this.subscribers) {
      try {
        sub();
      } catch {
        // ignore subscriber errors
      }
    }
  }

  init(): () => void {
    if (typeof window === "undefined") return () => {};

    if (window.matchMedia) {
      this.mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      this.systemIsDark = this.mediaQuery.matches;

      this.listener = (e: MediaQueryListEvent) => {
        this.systemIsDark = e.matches;
        this.notify();
      };

      if (this.mediaQuery.addEventListener) {
        this.mediaQuery.addEventListener("change", this.listener);
      } else if ("addListener" in this.mediaQuery) {
        (this.mediaQuery as unknown as { addListener: (cb: unknown) => void }).addListener(this.listener);
      }
    }

    this.notify();

    return () => {
      this.destroy();
    };
  }

  setTheme(newPreference: Theme): void {
    this.preference = newPreference;
    saveStoredThemePreference(newPreference);
    this.notify();
  }

  cycleTheme(): void {
    this.setTheme(nextTheme(this.preference));
  }

  syncFromSnapshot(snapshotTheme: Theme): void {
    if (snapshotTheme && snapshotTheme !== this.preference) {
      this.preference = snapshotTheme;
      saveStoredThemePreference(snapshotTheme);
      this.notify();
    }
  }

  destroy(): void {
    if (this.mediaQuery && this.listener) {
      if (this.mediaQuery.removeEventListener) {
        this.mediaQuery.removeEventListener("change", this.listener);
      } else if ("removeListener" in this.mediaQuery) {
        (this.mediaQuery as unknown as { removeListener: (cb: unknown) => void }).removeListener(this.listener);
      }
      this.listener = null;
    }
  }
}

export const themeManager = new ThemeManager();
