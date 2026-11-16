import { expect, test } from "nsh/test";
import { SIDEBAR_MAX, SIDEBAR_MIN } from "../../m/sidebar/sidebar-width.ts";
import {
  FOLD_MAX_MS,
  FOLD_MIN_MS,
  FOLD_SIDEBAR,
  FOLD_STEP_PT,
  FOLD_TEXT,
  foldOpenness,
  foldRailIcon,
  foldValue,
  RAIL_STAGGER_CAP,
  sidebarFoldAt,
  sidebarFoldMs,
} from "./sidebar-fold";

/** The macOS rail (64 points and the traffic lights' 20). */
const RAIL = 84;

/** The widths a fold goes through at 60 frames a second (or `fps`). */
const frames = (from: number, to: number, fps = 60) => {
  const out: number[] = [from];
  for (let ms = 1000 / fps; ; ms += 1000 / fps) {
    const width = sidebarFoldAt(from, to, ms);
    if (width === null) return out;
    out.push(width);
  }
};
const steps = (widths: number[]) => widths.slice(1).map((w, i) => Math.abs(w - widths[i]!));

test("the edge starts where it was, moves every frame the same way and ends where it goes", () => {
  expect(sidebarFoldAt(260, RAIL, 0)).toBe(260);
  expect(sidebarFoldAt(260, RAIL, -5)).toBe(260);
  expect(sidebarFoldAt(260, RAIL, sidebarFoldMs(RAIL - 260))).toBeNull();
  const closing = frames(260, RAIL);
  for (let i = 1; i < closing.length; i++) expect(closing[i]!).toBeLessThan(closing[i - 1]!);
  const opening = frames(RAIL, 260);
  for (let i = 1; i < opening.length; i++) expect(opening[i]!).toBeGreaterThan(opening[i - 1]!);
  // It never goes past either end: the panes beside it would wrap twice.
  for (const w of [...closing, ...opening]) expect(w >= RAIL - 1e-9 && w <= 260 + 1e-9).toBe(true);
});

test("the edge is not linear: it starts soft, is quickest early and settles slowly", () => {
  const s = steps(frames(260, RAIL));
  const peak = Math.max(...s);
  const at = s.indexOf(peak);
  // Soft start: the first frame moves a fraction of the fastest.
  expect(s[0]!).toBeLessThan(peak / 4);
  // Quickest in the first half, and from there each frame moves less than the one before.
  expect(at).toBeLessThan(s.length / 2);
  for (let i = at + 2; i < s.length; i++) expect(s[i]!).toBeLessThanOrEqual(s[i - 1]! + 1e-9);
  // Most of the way is behind it at half time, and the last quarter of the time covers little of it.
  const D = sidebarFoldMs(RAIL - 260);
  const covered = (ms: number) => (260 - (sidebarFoldAt(260, RAIL, ms) as number)) / (260 - RAIL);
  expect(covered(D / 2)).toBeGreaterThan(0.65);
  expect(1 - covered(D * 0.75)).toBeLessThan(0.1);
});

test("no frame moves the edge much past the step a long reply beside it can be laid out in", () => {
  // Beside a long reply, laying the panes out after a step of 50 to 100 points took some 40 ms and
  // kept to a frame for some 25 points. The fold takes longer the farther it goes, up to its longest.
  for (const full of [SIDEBAR_MIN, 260, 360]) {
    for (const s of [...steps(frames(full, RAIL)), ...steps(frames(RAIL, full))]) expect(s).toBeLessThan(FOLD_STEP_PT + 1);
  }
  // At the widest sidebar the longest run caps it, a little over.
  for (const s of steps(frames(SIDEBAR_MAX, RAIL))) expect(s).toBeLessThan(FOLD_STEP_PT * 1.3);
  expect(sidebarFoldMs(RAIL - SIDEBAR_MIN)).toBe(FOLD_MIN_MS);
  expect(sidebarFoldMs(SIDEBAR_MAX - RAIL)).toBe(FOLD_MAX_MS);
  expect(sidebarFoldMs(360 - RAIL)).toBeGreaterThan(FOLD_MIN_MS);
});

test("how open the column is runs from the rail to the sidebar's width", () => {
  expect(foldOpenness(RAIL, RAIL, 260)).toBe(0);
  expect(foldOpenness(260, RAIL, 260)).toBe(1);
  expect(foldOpenness(172, RAIL, 260)).toBe(0.5);
  expect(foldOpenness(40, RAIL, 260)).toBe(0);
  expect(foldOpenness(300, RAIL, 260)).toBe(1);
});

test("at rest every view is as it would be without the fold", () => {
  // Open (the sidebar, a phone's roster): the words and the sidebar whole, in place.
  expect(foldValue(FOLD_TEXT.opacity, 1)).toBe(1);
  expect(foldValue(FOLD_TEXT.translateX, 1)).toBe(0);
  expect(foldValue(FOLD_SIDEBAR.opacity, 1)).toBe(1);
  // Shut (the rail): every icon whole, at its size.
  for (let order = 0; order <= RAIL_STAGGER_CAP + 3; order++) {
    expect(foldValue(foldRailIcon(order).opacity, 0)).toBe(1);
    expect(foldValue(foldRailIcon(order).scale, 0)).toBe(1);
  }
});

test("the words and the icons move differently: the words go first and come last, the icons hold", () => {
  const close = frames(260, RAIL).map((w) => foldOpenness(w, RAIL, 260));
  const textGone = close.findIndex((p) => foldValue(FOLD_TEXT.opacity, p) === 0);
  const iconsFading = close.findIndex((p) => foldValue(FOLD_SIDEBAR.opacity, p) < 1);
  const railComing = close.findIndex((p) => foldValue(foldRailIcon(0).opacity, p) > 0);
  // Folding: the words are gone while the sidebar's avatars are still whole, and well before the rail's icons come.
  expect(textGone).toBeGreaterThan(0);
  expect(textGone).toBeLessThan(iconsFading);
  expect(textGone).toBeLessThan(railComing);
  expect(textGone).toBeLessThan(close.length / 2);
  // Mid-fold the words have drawn in towards the avatars.
  expect(foldValue(FOLD_TEXT.translateX, close[textGone - 1]!)).toBeLessThan(0);

  const open = frames(RAIL, 260).map((w) => foldOpenness(w, RAIL, 260));
  const textComing = open.findIndex((p) => foldValue(FOLD_TEXT.opacity, p) > 0);
  const railGone = open.findIndex((p) => foldValue(foldRailIcon(0).opacity, p) === 0);
  const iconsWhole = open.findIndex((p) => foldValue(FOLD_SIDEBAR.opacity, p) === 1);
  // Unfolding: the rail's icons have gone and the sidebar's are whole before the first word shows.
  expect(railGone).toBeLessThan(textComing);
  expect(iconsWhole).toBeLessThan(textComing);
});

test("the rail's icons come one after another from the top, grow a little past their size and settle", () => {
  // Finer than a frame: at 60 fps two icons a step apart can land in the same frame.
  const close = frames(260, RAIL, 600).map((w) => foldOpenness(w, RAIL, 260));
  const whole = (order: number) => close.findIndex((p) => foldValue(foldRailIcon(order).opacity, p) === 1);
  expect(whole(0)).toBeLessThan(whole(5));
  expect(whole(5)).toBeLessThan(whole(RAIL_STAGGER_CAP));
  // Past the cap they come together.
  expect(foldRailIcon(RAIL_STAGGER_CAP + 4)).toEqual(foldRailIcon(RAIL_STAGGER_CAP));
  for (const order of [0, 5, RAIL_STAGGER_CAP]) {
    const scales = close.map((p) => foldValue(foldRailIcon(order).scale, p));
    expect(scales[0]!).toBeLessThan(0.9);
    expect(Math.max(...scales)).toBeGreaterThan(1.01);
    expect(Math.max(...scales)).toBeLessThan(1.06);
    expect(Math.abs(scales[scales.length - 1]! - 1)).toBeLessThan(0.01);
  }
  // Every one is whole by the time the edge comes to rest.
  expect(foldValue(foldRailIcon(RAIL_STAGGER_CAP).opacity, close[close.length - 1]!)).toBe(1);
});
