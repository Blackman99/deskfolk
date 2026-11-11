import { expect, test } from "nsh/test";
import { SIDEBAR_FOLD_MS, sidebarFoldAt } from "./sidebar-fold";

/** The widths a fold goes through at 60 frames a second. */
const frames = (from: number, to: number) => {
  const out: number[] = [];
  for (let ms = 0; ; ms += 1000 / 60) {
    const width = sidebarFoldAt(from, to, ms);
    if (width === null) return out;
    out.push(width);
  }
};

test("the fold starts at the width it had, moves a step each frame and is over after a quarter second", () => {
  expect(sidebarFoldAt(300, 88, 0)).toBe(300);
  expect(sidebarFoldAt(300, 88, -5)).toBe(300);
  expect(sidebarFoldAt(300, 88, SIDEBAR_FOLD_MS)).toBeNull();
  const closing = frames(300, 88);
  expect(closing.length).toBeGreaterThanOrEqual(14);
  for (let i = 1; i < closing.length; i++) expect(closing[i]!).toBeLessThan(closing[i - 1]!);
  const opening = frames(88, 300);
  for (let i = 1; i < opening.length; i++) expect(opening[i]!).toBeGreaterThan(opening[i - 1]!);
  // It leaves fast and settles: three quarters of the way at half time, each step smaller than the last.
  expect(Math.abs((sidebarFoldAt(0, 100, SIDEBAR_FOLD_MS / 2) as number) - 75)).toBeLessThan(0.5);
  for (let i = 2; i < closing.length; i++) expect(closing[i - 1]! - closing[i]!).toBeLessThan(closing[i - 2]! - closing[i - 1]!);
});

test("no frame moves the edge much more than its share, so laying the panes out again keeps up", () => {
  // A long reply beside the column took some 40 ms to lay out after a step of 50 to 100 points (the
  // Svelte curve, cubic-bezier(0.16, 1, 0.3, 1), covers some five shares in its first frame), and
  // kept to a frame for steps of a few points.
  const closing = frames(300, 88);
  // A frame's share of the way: 212 points over the frames of a quarter second.
  const share = 212 / (SIDEBAR_FOLD_MS / (1000 / 60));
  expect(300 - closing[1]!).toBeLessThan(share * 2);
  for (let i = 1; i < closing.length; i++) expect(closing[i - 1]! - closing[i]!).toBeLessThan(share * 2);
});
