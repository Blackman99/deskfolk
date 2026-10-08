/**
 * Guarded `localStorage`: a server render, a window without storage, or a read or write that
 * throws (a private window, blocked site data) all come back as "nothing kept" instead of an error.
 */

/** The stored string, or null when nothing is kept or storage is unavailable. */
export function readStored(key: string): string | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Keeps `value` under `key`; a refusing storage is ignored. */
export function writeStored(key: string, value: string): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A private window or blocked storage: the choice just is not kept.
  }
}

/** Drops `key`; a refusing storage is ignored. */
export function forgetStored(key: string): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

export type PersistedWidth = {
  load(): number;
  save(width: number): void;
  clamp(width: number, containerWidth?: number): number;
};

/**
 * A width kept per browser and clamped to its container: at least `min`, at most `max`, and at
 * most `ratio` of the container's width (never below `min`).
 */
export function persistedWidth(opts: {
  key: string;
  min: number;
  default: number;
  ratio: number;
  max?: number;
}): PersistedWidth {
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  function clamp(width: number, containerWidth: number = Number.POSITIVE_INFINITY): number {
    const ceiling = Math.min(max, Math.max(opts.min, Math.floor(containerWidth * opts.ratio)));
    return Math.min(ceiling, Math.max(opts.min, Math.round(width)));
  }
  return {
    clamp,
    load() {
      const raw = readStored(opts.key);
      const n = raw ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return opts.default;
      return clamp(n);
    },
    save(width) {
      writeStored(opts.key, String(Math.round(width)));
    },
  };
}
