/**
 * Svelte 5's runes on NSH's signals, so the messenger's stores (`*.svelte.ts`) run here with their
 * logic unchanged (`scripts/port-runes.ts` rewrites the rune syntax into these):
 *
 * - `state(v)` is `$state(v)`: objects and arrays come back as deep proxies whose properties are
 *   signals, so `list.push(x)` and `row.done = true` are seen by whatever read them, as in Svelte.
 * - `rawState(v)` is `$state.raw(v)`: only replacing the value is seen.
 * - `derived(fn)` is `$derived.by(fn)` (and `$derived(expr)` as `derived(() => expr)`).
 * - `effect(fn)` is `$effect(fn)`; `untrack`, `tick` and `snapshot` (`$state.snapshot`) as in Svelte.
 */
import { computed, effect as nshEffect, signal, untracked, type Signal } from "nsh";

const RAW = Symbol("deskfolk.raw");
const PROXIES = new WeakMap<object, object>();

type Box<T> = { get(): T; set(value: T): void };

function plain(value: unknown): value is Record<PropertyKey, unknown> | unknown[] {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `value`, deeply reactive when it is a plain object or an array; anything else as it is. */
export function deep<T>(value: T): T {
  if (!plain(value)) return value;
  if ((value as Record<PropertyKey, unknown>)[RAW]) return value;
  const known = PROXIES.get(value);
  if (known) return known as T;
  const target = value as Record<PropertyKey, unknown>;
  const sources = new Map<PropertyKey, Signal<unknown>>();
  const keys = signal(0);
  const source = (key: PropertyKey) => {
    let s = sources.get(key);
    if (!s) {
      s = signal<unknown>(untracked(() => target[key as string]), { equals: false });
      sources.set(key, s);
    }
    return s;
  };
  const proxy = new Proxy(target, {
    get(t, key, receiver) {
      if (key === RAW) return t;
      if (typeof key === "symbol") return Reflect.get(t, key, receiver);
      const own = Object.prototype.hasOwnProperty.call(t, key);
      if (!own) {
        // Array methods and the like: not state; reading an absent key still tracks its arrival.
        if (key in t) return Reflect.get(t, key, receiver);
        keys();
        return undefined;
      }
      source(key)();
      const current = t[key];
      if (plain(current)) {
        const wrapped = deep(current);
        if (wrapped !== current) t[key] = wrapped;
        return wrapped;
      }
      return current;
    },
    set(t, key, value) {
      if (typeof key === "symbol") return Reflect.set(t, key, value);
      const had = Object.prototype.hasOwnProperty.call(t, key);
      const lengthBefore = Array.isArray(t) ? t.length : 0;
      const next = deep(value);
      if (had && Object.is(t[key], next) && key !== "length") return true;
      t[key] = next;
      sources.get(key)?.set(next);
      if (Array.isArray(t) && t.length !== lengthBefore) {
        sources.get("length")?.set(t.length);
        keys.update((n) => n + 1);
      } else if (!had) {
        keys.update((n) => n + 1);
      }
      return true;
    },
    deleteProperty(t, key) {
      if (typeof key === "symbol") return Reflect.deleteProperty(t, key);
      const had = Object.prototype.hasOwnProperty.call(t, key);
      const ok = Reflect.deleteProperty(t, key);
      if (had) {
        sources.get(key)?.set(undefined);
        keys.update((n) => n + 1);
      }
      return ok;
    },
    has(t, key) {
      if (key === RAW) return true;
      keys();
      return Reflect.has(t, key);
    },
    ownKeys(t) {
      keys();
      return Reflect.ownKeys(t);
    },
  });
  PROXIES.set(value, proxy);
  return proxy as T;
}

/** A plain copy of `value` with every proxy taken off (`$state.snapshot`). */
export function snapshot<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const raw = ((value as Record<PropertyKey, unknown>)[RAW] as T | undefined) ?? value;
  if (Array.isArray(raw)) return raw.map((item) => snapshot(item)) as T;
  if (!plain(raw)) return raw;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) copy[key] = snapshot((raw as Record<string, unknown>)[key]);
  return copy as T;
}

/** `$state(initial)`: a value whose objects and arrays are deeply reactive. */
export function state<T>(initial: T): Box<T>;
export function state<T = undefined>(): Box<T | undefined>;
export function state<T>(initial?: T): Box<T | undefined> {
  const s = signal<T | undefined>(deep(initial), { equals: (a, b) => Object.is(a, b) });
  return { get: () => s(), set: (value) => s.set(deep(value)) };
}

/** `$state.raw(initial)`: only a new value is seen. */
export function rawState<T>(initial: T): Box<T>;
export function rawState<T = undefined>(): Box<T | undefined>;
export function rawState<T>(initial?: T): Box<T | undefined> {
  const s = signal<T | undefined>(initial, { equals: (a, b) => Object.is(a, b) });
  return { get: () => s(), set: (value) => s.set(value) };
}

/** `$derived.by(fn)`. */
export function derived<T>(fn: () => T): { get(): T } {
  const c = computed(() => fn());
  return { get: () => c() };
}

/** `$effect(fn)`. */
export function effect(fn: () => void | (() => void)): void {
  nshEffect(fn);
}

/** `untrack` from `svelte`. */
export function untrack<T>(fn: () => T): T {
  return untracked(fn);
}

/** `tick` from `svelte`: settles once the changes made so far have run their effects. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** `onMount` from `svelte`, outside a component: runs at once (a store has no mount). */
export function onMount(fn: () => void | (() => void)): void {
  queueMicrotask(() => void fn());
}
