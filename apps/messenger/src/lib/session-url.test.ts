import { expect, test } from "bun:test";
import { selectionFromUrl, sessionFromUrl, sessionUrl } from "./session-url.ts";

const at = (search: string) => new URL(`http://localhost:5173/${search}`);

test("reads the session out of the query", () => {
  expect(sessionFromUrl(at("?s=abc"))).toBe("abc");
  expect(sessionFromUrl(at(""))).toBeNull();
});

test("returns null when the URL already says the right thing", () => {
  expect(sessionUrl(at("?s=abc"), "abc")).toBeNull();
  expect(sessionUrl(at(""), null)).toBeNull();
});

test("adds, replaces and drops the session", () => {
  expect(sessionUrl(at(""), "abc")).toBe("/?s=abc");
  expect(sessionUrl(at("?s=abc"), "def")).toBe("/?s=def");
  expect(sessionUrl(at("?s=abc"), null)).toBe("/");
});

test("leaves other query parameters alone", () => {
  expect(sessionUrl(at("?debug=1"), "abc")).toBe("/?debug=1&s=abc");
  expect(sessionUrl(at("?debug=1&s=abc"), null)).toBe("/?debug=1");
});

test("a URL that matches the selection asks for nothing", () => {
  expect(selectionFromUrl("abc", "abc", ["abc"])).toEqual({ action: "none" });
  expect(selectionFromUrl(null, null, [])).toEqual({ action: "none" });
});

test("an empty query clears the selection", () => {
  expect(selectionFromUrl(null, "abc", ["abc"])).toEqual({ action: "clear" });
});

test("a known session is selected", () => {
  expect(selectionFromUrl("def", "abc", ["abc", "def"])).toEqual({ action: "select", id: "def" });
});

test("an id the snapshot has never seen waits rather than fetching", () => {
  expect(selectionFromUrl("zzz", null, ["abc"])).toEqual({ action: "wait", id: "zzz" });
});
