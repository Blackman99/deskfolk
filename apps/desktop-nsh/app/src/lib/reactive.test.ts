import { computed, effect, signal } from "nsh";
import { expect, test } from "nsh/test";
import { deep, derived, rawState, snapshot, state } from "./reactive";

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
