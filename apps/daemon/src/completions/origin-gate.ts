/** How many streams go to one origin at once. */


export type OriginGate = {
  acquire: (key: string, signal: AbortSignal) => Promise<boolean>;
  release: (key: string) => void;
};

export function originKey(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/$/, "");
  }
}

export function createOriginGate(limit: number): OriginGate {
  const slots = new Map<string, number>();
  const waiters = new Map<string, Array<() => boolean>>();

  function wake(key: string): void {
    const queue = waiters.get(key);
    while (queue && queue.length > 0) {
      const next = queue.shift();
      if (queue.length === 0) waiters.delete(key);
      if (next?.()) return;
    }
  }

  function acquire(key: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const used = slots.get(key) ?? 0;
    if (used < limit) {
      slots.set(key, used + 1);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = (): boolean => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          resolve(false);
          return false;
        }
        slots.set(key, (slots.get(key) ?? 0) + 1);
        resolve(true);
        return true;
      };
      const onAbort = () => {
        const queue = waiters.get(key);
        if (queue) {
          const idx = queue.indexOf(grant);
          if (idx >= 0) queue.splice(idx, 1);
          if (queue.length === 0) waiters.delete(key);
        }
        resolve(false);
      };
      const queue = waiters.get(key) ?? [];
      queue.push(grant);
      waiters.set(key, queue);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function release(key: string): void {
    const used = slots.get(key) ?? 0;
    if (used <= 1) slots.delete(key);
    else slots.set(key, used - 1);
    wake(key);
  }

  return { acquire, release };
}
