import { expect, test } from "bun:test";
import {
  previewFromUrl,
  sanitizePreviewPath,
  selectionFromUrl,
  sessionFromUrl,
  sessionUrl,
} from "./session-url.ts";

const at = (search: string) => new URL(`http://localhost:5173/${search}`);

test("reads the session out of the query", () => {
  expect(sessionFromUrl(at("?s=abc"))).toBe("abc");
  expect(sessionFromUrl(at(""))).toBeNull();
});

test("reads the preview path out of the query", () => {
  expect(previewFromUrl(at("?p=out/mock.html"))).toBe("out/mock.html");
  expect(previewFromUrl(at("?s=abc&p=inbox%2Fclip.mp4"))).toBe("inbox/clip.mp4");
  expect(previewFromUrl(at("?s=abc"))).toBeNull();
});

test("returns null when the URL already says the right thing", () => {
  expect(sessionUrl(at("?s=abc"), "abc")).toBeNull();
  expect(sessionUrl(at(""), null)).toBeNull();
  expect(sessionUrl(at("?s=abc&p=out/a.html"), "abc", "out/a.html")).toBeNull();
});

test("adds, replaces and drops the session", () => {
  expect(sessionUrl(at(""), "abc")).toBe("/?s=abc");
  expect(sessionUrl(at("?s=abc"), "def")).toBe("/?s=def");
  expect(sessionUrl(at("?s=abc"), null)).toBe("/");
});

test("adds, replaces and drops the preview without touching the session", () => {
  expect(sessionUrl(at("?s=abc"), "abc", "out/a.html")).toBe("/?s=abc&p=out%2Fa.html");
  expect(sessionUrl(at("?s=abc&p=out/a.html"), "abc", "inbox/b.md")).toBe(
    "/?s=abc&p=inbox%2Fb.md",
  );
  expect(sessionUrl(at("?s=abc&p=out/a.html"), "abc", null)).toBe("/?s=abc");
});

test("omitting preview leaves an existing preview query alone", () => {
  expect(sessionUrl(at("?s=abc&p=out/a.html"), "def")).toBe("/?s=def&p=out%2Fa.html");
});

test("encoded and raw slashes in the preview query are the same location", () => {
  expect(sessionUrl(at("?s=abc&p=out/a.html"), "abc", "out/a.html")).toBeNull();
  expect(sessionUrl(at("?s=abc&p=out%2Fa.html"), "abc", "out/a.html")).toBeNull();
});

test("leaves other query parameters alone", () => {
  expect(sessionUrl(at("?debug=1"), "abc")).toBe("/?debug=1&s=abc");
  expect(sessionUrl(at("?debug=1&s=abc"), null)).toBe("/?debug=1");
  expect(sessionUrl(at("?debug=1&s=abc"), "abc", "out/a.html")).toBe(
    "/?debug=1&s=abc&p=out%2Fa.html",
  );
});

test("sanitizePreviewPath rejects escapes and empty values", () => {
  expect(sanitizePreviewPath("out/a.html")).toBe("out/a.html");
  expect(sanitizePreviewPath(" ./out/a.html ")).toBe("out/a.html");
  expect(sanitizePreviewPath("")).toBeNull();
  expect(sanitizePreviewPath("/etc/passwd")).toBeNull();
  expect(sanitizePreviewPath("https://example.com/a")).toBeNull();
  expect(sanitizePreviewPath("../secret")).toBeNull();
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
