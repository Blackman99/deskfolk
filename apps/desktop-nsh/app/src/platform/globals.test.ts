import "./install";
import { expect, test } from "nsh/test";
import { createKeyedPersist, mediaMatches } from "./globals";

test("the messenger's media queries answer from the width", () => {
  expect(mediaMatches("(max-width: 680px)", 390)).toBe(true);
  expect(mediaMatches("(max-width: 680px)", 1100)).toBe(false);
  expect(mediaMatches("(min-width: 1000px)", 1100)).toBe(true);
  expect(mediaMatches("(min-width: 621px) and (max-width: 999px)", 800)).toBe(true);
  expect(mediaMatches("(prefers-color-scheme: dark)", 800)).toBe(false);
  expect(typeof mediaMatches("(prefers-reduced-motion: reduce)", 800)).toBe("boolean");
  expect(mediaMatches("(prefers-reduced-motion: reduce)", 800, true)).toBe(true);
  expect(mediaMatches("(prefers-reduced-motion: reduce)", 800, false)).toBe(false);
});

test("localStorage keeps what is set, synchronously", () => {
  const storage = (globalThis as unknown as { localStorage: Storage }).localStorage;
  storage.setItem("deskfolk-test", "1");
  expect(storage.getItem("deskfolk-test")).toBe("1");
  storage.removeItem("deskfolk-test");
  expect(storage.getItem("deskfolk-test")).toBe(null);
});

test("structuredClone and navigator exist", () => {
  const g = globalThis as unknown as { structuredClone(v: unknown): unknown; navigator: { platform: string } };
  const value = { a: [1, { b: new Date(0) }] };
  const copy = g.structuredClone(value) as typeof value;
  expect(copy).not.toBe(value);
  expect(JSON.stringify(copy)).toBe(JSON.stringify(value));
  expect(typeof g.navigator.platform).toBe("string");
});

test("relative times read as the browser's Intl.RelativeTimeFormat would", () => {
  const zh = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  expect(zh.format(0, "second")).toBe("现在");
  expect(zh.format(-1, "day")).toBe("昨天");
  expect(zh.format(-3, "hour")).toBe("3小时前");
  const en = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  expect(en.format(-1, "minute")).toBe("1 minute ago");
  expect(en.format(-5, "days")).toBe("5 days ago");
  expect(en.format(-1, "day")).toBe("yesterday");
});

test("Intl formatters may be called without new, as in a browser", () => {
  const plain = (Intl.DateTimeFormat as unknown as (l: string, o: object) => Intl.DateTimeFormat)("en-US", { timeZone: "UTC", year: "numeric" });
  expect(plain.format(new Date(0))).toBe("1970");
  expect(new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric" }) instanceof Intl.DateTimeFormat).toBe(true);
  expect(typeof Intl.DateTimeFormat.supportedLocalesOf).toBe("function");
});

test("createKeyedPersist serialises writes per key and flushes the latest value (including deletes)", async () => {
  const map = new Map<string, string>();
  const started: Array<{ key: string; value: string | null; finish: () => void }> = [];
  const flush = createKeyedPersist(
    (key) => (map.has(key) ? map.get(key)! : null),
    (key, value) =>
      new Promise<void>((resolve) => {
        started.push({ key, value, finish: resolve });
      }),
  );

  // First keystroke starts writing immediately (no debounce).
  map.set("k1", "a");
  flush("k1");
  expect(started.map((s) => [s.key, s.value])).toEqual([["k1", "a"]]);

  // Rapid typing while the first write is still in flight collapses to the latest state.
  map.set("k1", "ab");
  flush("k1");
  map.set("k1", "abc");
  flush("k1");
  // Another key proceeds independently without waiting on k1.
  map.set("k2", "x");
  flush("k2");
  expect(started.map((s) => [s.key, s.value])).toEqual([["k1", "a"], ["k2", "x"]]);

  started[0]!.finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(started.map((s) => [s.key, s.value])).toEqual([["k1", "a"], ["k2", "x"], ["k1", "abc"]]);

  // Deleting while "abc" is still writing must land after "abc", never before it.
  map.delete("k1");
  flush("k1");
  started[2]!.finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(started.map((s) => [s.key, s.value])).toEqual([["k1", "a"], ["k2", "x"], ["k1", "abc"], ["k1", null]]);

  started[1]!.finish();
  started[3]!.finish();
});
