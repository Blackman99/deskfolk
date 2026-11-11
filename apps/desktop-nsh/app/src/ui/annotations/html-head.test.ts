/** A page's viewport `<meta>` is looked for in its head, not in the megabytes after it. */
import { expect, test } from "nsh/test";
import { headOf } from "./HtmlAnnotator";

test("the head ends where the body starts, whatever its case", () => {
  expect(headOf("<html><head><meta name=viewport content=width=500></head><body><p>x</p></body></html>")).toBe(
    "<html><head><meta name=viewport content=width=500></head>",
  );
  expect(headOf("<HEAD></HEAD><BODY>x")).toBe("<HEAD></HEAD>");
});

test("a page without a body is read to its first 256 KiB", () => {
  const page = "<meta name=viewport content=width=device-width>" + "x".repeat(300 * 1024);
  expect(headOf(page).length).toBe(256 * 1024);
  expect(headOf("<p>short</p>")).toBe("<p>short</p>");
});
