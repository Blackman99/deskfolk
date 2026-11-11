/** A width switch holds while a pane is resized by hand. */
import { signal } from "nsh";
import { expect, test } from "nsh/test";
import { paneResize, settled } from "./drag-settle";

test("a switch follows the width at rest, holds through a resize by hand and catches up after", () => {
  const width = signal(800);
  const wide = settled(() => width() >= 760);
  expect(wide()).toBe(true);
  width.set(700);
  expect(wide()).toBe(false);
  width.set(800);
  paneResize.begin();
  width.set(700);
  expect(wide()).toBe(true);
  width.set(650);
  expect(wide()).toBe(true);
  paneResize.end();
  expect(wide()).toBe(false);
});

test("nested resizes hold until the last ends", () => {
  const width = signal(800);
  const wide = settled(() => width() >= 760);
  expect(wide()).toBe(true);
  paneResize.begin();
  paneResize.begin();
  width.set(700);
  paneResize.end();
  expect(wide()).toBe(true);
  paneResize.end();
  expect(wide()).toBe(false);
});
