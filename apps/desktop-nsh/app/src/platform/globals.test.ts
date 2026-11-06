import "./install";
import { expect, test } from "nsh/test";
import { mediaMatches } from "./globals";

test("the messenger's media queries answer from the width", () => {
  expect(mediaMatches("(max-width: 680px)", 390)).toBe(true);
  expect(mediaMatches("(max-width: 680px)", 1100)).toBe(false);
  expect(mediaMatches("(min-width: 1000px)", 1100)).toBe(true);
  expect(mediaMatches("(min-width: 621px) and (max-width: 999px)", 800)).toBe(true);
  expect(mediaMatches("(prefers-color-scheme: dark)", 800)).toBe(false);
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
