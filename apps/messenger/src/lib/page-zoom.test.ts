import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lockPageZoom } from "./page-zoom.ts";

test("the page locks its scale, so a phone or iPad cannot pinch-zoom it", () => {
  const html = readFileSync(new URL("../app.html", import.meta.url), "utf8");
  expect(html).toContain(
    'content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no"',
  );
});

test("a pinch does not zoom the page, and the thing under the fingers still hears it", () => {
  const doc = document.implementation.createHTMLDocument("zoom");
  const child = doc.createElement("div");
  doc.body.append(child);
  const heard: string[] = [];
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    child.addEventListener(type, () => heard.push(type));
  }
  lockPageZoom(doc);
  lockPageZoom(doc);
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    child.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  // Once each: locking twice must not stack listeners, and nothing stops the event on its way.
  expect(heard).toEqual(["gesturestart", "gesturechange", "gestureend"]);
});
