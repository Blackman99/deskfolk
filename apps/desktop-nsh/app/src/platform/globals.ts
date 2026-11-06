/**
 * The browser globals the messenger's logic reads, where NSH's runtime has none (the desktops'
 * QuickJS; a browser keeps its own): a synchronous `localStorage` kept in NSH's `Storage` (read
 * whole before the app starts, written through), `sessionStorage`, `navigator`, `structuredClone`
 * and a `matchMedia` that answers from the window's size.
 */
import { locale, platform, Storage, windowSize } from "nsh";
import { RelativeTimeFormat } from "./relative-time";

type StorageLike = {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
};

function memoryStorage(entries: Map<string, string>, persist?: (key: string, value: string | null) => void): StorageLike {
  return {
    get length() {
      return entries.size;
    },
    getItem: (key) => entries.get(String(key)) ?? null,
    setItem(key, value) {
      entries.set(String(key), String(value));
      persist?.(String(key), String(value));
    },
    removeItem(key) {
      entries.delete(String(key));
      persist?.(String(key), null);
    },
    clear() {
      for (const key of [...entries.keys()]) persist?.(key, null);
      entries.clear();
    },
    key: (index) => [...entries.keys()][index] ?? null,
  };
}

function clone<T>(value: T, seen = new Map<unknown, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [k, v] of value) copy.set(clone(k, seen), clone(v, seen));
    return copy as T;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const v of value) copy.add(clone(v, seen));
    return copy as T;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return (value as unknown as { slice(): T }).slice();
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) (copy as Record<string, unknown>)[key] = clone((value as Record<string, unknown>)[key], seen);
  return copy as T;
}

/** `(max-width: 680px)`, `(min-width: …)`, `(prefers-reduced-motion: reduce)`: what the app asks. */
export function mediaMatches(query: string, width: number): boolean {
  let all = true;
  for (const part of query.split(/\band\b/)) {
    const max = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(part);
    const min = /min-width:\s*(\d+(?:\.\d+)?)px/.exec(part);
    if (max) all &&= width <= Number(max[1]);
    else if (min) all &&= width >= Number(min[1]);
    else if (/hover:\s*hover|pointer:\s*fine/.test(part)) all &&= platform.desktop;
    else if (/hover:\s*none|pointer:\s*coarse/.test(part)) all &&= !platform.desktop;
    else all &&= false;
  }
  return all;
}

let installed = false;
const kept = new Map<string, string>();

/**
 * Installs the globals at once (`localStorage` empty until `loadStorage()` fills it). Imported for
 * its effect by `install.ts`, before anything that reads them.
 */
export function installGlobals(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as Record<string, unknown>;
  if (typeof g.structuredClone !== "function") g.structuredClone = (value: unknown) => clone(value);
  const intl = g.Intl as Record<string, unknown> | undefined;
  if (intl && typeof intl.RelativeTimeFormat !== "function") intl.RelativeTimeFormat = RelativeTimeFormat;
  if (typeof g.navigator === "undefined") {
    const os = platform.os;
    g.navigator = {
      platform: os === "macos" || os === "ios" ? "MacIntel" : os === "windows" ? "Win32" : "Linux x86_64",
      userAgent: `Deskfolk NSH (${os})`,
      get language() {
        return locale();
      },
      get languages() {
        return [locale()];
      },
      maxTouchPoints: platform.desktop ? 0 : 5,
      onLine: true,
    };
  }
  if (typeof g.matchMedia !== "function") {
    g.matchMedia = (query: string) => ({
      get matches() {
        return mediaMatches(query, windowSize().width);
      },
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
  }
  if (typeof g.sessionStorage === "undefined") g.sessionStorage = memoryStorage(new Map());
  if (typeof g.localStorage === "undefined") {
    nativeStorage = true;
    g.localStorage = memoryStorage(kept, (key, value) => {
      void (value === null ? Storage.removeItem(key) : Storage.setItem(key, value)).catch((error) =>
        console.error("storage write failed", String(error)),
      );
    });
  }
}

let nativeStorage = false;

/** Fills `localStorage` with what NSH's `Storage` kept; resolves before the app's modules load. */
export async function loadStorage(): Promise<void> {
  if (!nativeStorage) return;
  try {
    for (const key of await Storage.keys()) {
      const value = await Storage.getItem(key);
      if (value !== null && !kept.has(key)) kept.set(key, value);
    }
  } catch (error) {
    console.error("storage could not be read", String(error));
  }
}
