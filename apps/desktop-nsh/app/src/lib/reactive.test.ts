import { computed, effect, signal } from "nsh";
import { expect, test } from "nsh/test";
import { deep, derived, rawState, reconciledState, snapshot, state } from "./reactive";

test("a field's new value is seen", () => {
  const count = state(0);
  const doubled = derived(() => count.get() * 2);
  count.set(4);
  expect(doubled.get()).toBe(8);
});

test("pushing into a state array is seen, and so is its length", () => {
  const list = state<number[]>([]);
  const total = computed(() => list.get().reduce((a, b) => a + b, 0));
  const length = computed(() => list.get().length);
  list.get().push(3);
  list.get().push(4);
  expect(total()).toBe(7);
  expect(length()).toBe(2);
});

test("changing a nested field is seen by what read it", () => {
  const rows = state([{ id: "a", done: false }]);
  const done = computed(() => rows.get()[0]!.done);
  expect(done()).toBe(false);
  rows.get()[0]!.done = true;
  expect(done()).toBe(true);
});

test("adding and removing keys is seen by Object.keys", () => {
  const map = state<Record<string, number>>({});
  const names = computed(() => Object.keys(map.get()).join(","));
  map.get().b = 2;
  map.get().a = 1;
  expect(names()).toBe("b,a");
  delete map.get().b;
  expect(names()).toBe("a");
});

test("raw state sees only a new value", () => {
  const box = rawState({ n: 1 });
  const n = computed(() => box.get().n);
  box.get().n = 2;
  expect(n()).toBe(1);
  box.set({ n: 3 });
  expect(n()).toBe(3);
});

test("a snapshot is plain and detached", () => {
  const value = deep({ list: [{ x: 1 }] });
  const copy = snapshot(value);
  value.list[0]!.x = 9;
  expect(copy.list[0]!.x).toBe(1);
  expect(JSON.stringify(copy)).toBe('{"list":[{"x":1}]}');
});

test("an effect runs again when a deep value it read changes", () => {
  const seen: number[] = [];
  const s = state({ n: 1 });
  const tick = signal(0);
  effect(() => {
    tick();
    seen.push(s.get().n);
  });
  s.get().n = 2;
  expect(seen[seen.length - 1]).toBe(2);
});

test("class instances and other non-plain values are left alone", () => {
  const date = new Date(0);
  expect(deep(date)).toBe(date);
  const map = new Map([["a", 1]]);
  expect(deep(map)).toBe(map);
});

test("a derived field may read what the constructor sets after it, as Svelte's lazy $derived may", () => {
  class Ledger {
    readonly #input: { now: number };
    readonly total = derived(() => this.#input.now * 2);
    constructor(now: number) {
      this.#input = { now };
    }
  }
  expect(new Ledger(21).total.get()).toBe(42);
});

test("a derived first read inside an effect keeps following its signals after the effect runs again", () => {
  const n = signal(1);
  const other = signal(0);
  const twice = derived(() => n() * 2);
  const seen: number[] = [];
  effect(() => {
    other();
    seen.push(twice.get());
  });
  other.set(1);
  n.set(5);
  expect(twice.get()).toBe(10);
  expect(seen[seen.length - 1]).toBe(10);
});

test("a derived is computed once until what it read changes", () => {
  let runs = 0;
  const n = signal(1);
  const twice = derived(() => {
    runs++;
    return n() * 2;
  });
  expect(runs).toBe(0);
  twice.get();
  twice.get();
  expect(runs).toBe(1);
  n.set(2);
  expect(twice.get()).toBe(4);
  expect(runs).toBe(2);
});

test("a derived first read while another derived computes", () => {
  const n = signal(3);
  const inner = derived(() => n() + 1);
  const outer = derived(() => inner.get() * 10);
  expect(outer.get()).toBe(40);
  n.set(4);
  expect(outer.get()).toBe(50);
});

type Snap = { rows: { id: string; n: number }[]; settings: { locale: string }; extra?: string };
const snap = (): Snap => ({ rows: [{ id: "a", n: 1 }, { id: "b", n: 2 }], settings: { locale: "zh" } });

test("a reconciled value replaced whole runs only the readers of what changed", () => {
  const box = reconciledState<Snap>(snap());
  let rowReads = 0;
  let localeReads = 0;
  const rows = computed(() => {
    rowReads++;
    return box.get().rows.map((r) => `${r.id}${r.n}`).join(",");
  });
  const locale = computed(() => {
    localeReads++;
    return box.get().settings.locale;
  });
  expect(rows()).toBe("a1,b2");
  expect(locale()).toBe("zh");
  const held = box.get();
  // An event that changes one row, sharing the rest, as `applyEvent` returns it.
  const before = box.get();
  box.set({ ...before, rows: before.rows.map((r) => (r.id === "b" ? { ...r, n: 3 } : r)) });
  expect(rows()).toBe("a1,b3");
  expect(locale()).toBe("zh");
  expect(localeReads).toBe(1);
  expect(rowReads).toBe(2);
  // The same value, the same proxy: nothing reads it again.
  expect(box.get()).toBe(held);
  box.set({ ...box.get() });
  expect(rows()).toBe("a1,b3");
  expect(rowReads).toBe(2);
});

test("a changed array under a reconciled value is a new array, as identity caches expect; an unchanged one is kept", () => {
  const box = reconciledState<Snap>(snap());
  const settings = box.get().settings;
  const rows = box.get().rows;
  let firstReads = 0;
  const first = computed(() => {
    firstReads++;
    return box.get().rows[0]?.n;
  });
  const count = computed(() => box.get().rows.length);
  expect(first()).toBe(1);
  const cur = box.get();
  box.set({ ...cur, rows: [cur.rows[0]!, { id: "b", n: 5 }, { id: "c", n: 6 }] });
  expect(box.get().rows).not.toBe(rows);
  expect(box.get().settings).toBe(settings);
  expect(count()).toBe(3);
  expect(box.get().rows[1]!.n).toBe(5);
  expect(first()).toBe(1);
  box.set({ ...box.get(), rows: [box.get().rows[0]!] });
  expect(count()).toBe(1);
  expect(box.get().rows[1]).toBe(undefined);
});

test("a reconciled record is replaced, not merged, and a dropped key is heard", () => {
  const box = reconciledState<Snap>({ ...snap(), extra: "x" });
  const settings = box.get().settings;
  const extra = computed(() => box.get().extra);
  expect(extra()).toBe("x");
  const { extra: _gone, ...rest } = box.get();
  box.set({ ...rest, settings: { locale: "en" } });
  expect(box.get().settings).not.toBe(settings);
  expect(settings.locale).toBe("zh");
  expect(box.get().settings.locale).toBe("en");
  expect(extra()).toBe(undefined);
});

test("one reconciled set runs an effect that read two changed keys once", () => {
  const box = reconciledState<Snap>(snap());
  let runs = 0;
  effect(() => {
    void box.get().settings.locale;
    void box.get().rows.length;
    runs++;
  });
  expect(runs).toBe(1);
  const cur = box.get();
  box.set({ ...cur, settings: { locale: "en" }, rows: [...cur.rows, { id: "c", n: 3 }] });
  expect(runs).toBe(2);
});
