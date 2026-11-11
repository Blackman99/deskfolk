import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;
const state = (app: App) => app.texts().find((t) => t.includes("float="))!;
/** A branch's weights as the readout prints them. */
const weights = (app: App, id: string): number[] => {
  const m = new RegExp(`${id}:\\w+\\[([0-9./]+)\\]`).exec(state(app));
  return m ? m[1]!.split("/").map(Number) : [];
};
const open = async () => {
  const app = await openStory("workbench");
  await app.waitFor("id:wb-state", { timeout: 15_000 });
  return app;
};

test("dragging the divider between the panes moves the seam and commits the shares on release", async () => {
  const app = await open();
  expect(weights(app, "r")).toEqual([0.5, 0.5]);
  await app.drag("id:wb-sash-r-1", { x: 110 });
  const [a, c] = weights(app, "r");
  expect(a!).toBeGreaterThan(0.55);
  expect(Math.abs(a! + c! - 1)).toBeLessThan(0.02);
  // The column's own division is not touched.
  expect(weights(app, "c")).toEqual([0.5, 0.5]);
  // The other way.
  await app.drag("id:wb-sash-r-1", { x: -330 });
  expect(weights(app, "r")[0]!).toBeLessThan(0.45);
});

test("a divider in the column moves along the other axis, and stops at the panes' minimum", async () => {
  const app = await open();
  await app.drag("id:wb-sash-c-1", { y: 90 });
  expect(weights(app, "c")[0]!).toBeGreaterThan(0.55);
  expect(weights(app, "r")).toEqual([0.5, 0.5]);
  // Far past the end: the lower pane keeps its 120-point floor of the column's height.
  await app.drag("id:wb-sash-c-1", { y: 900 });
  const [top, bottom] = weights(app, "c");
  expect(top!).toBeGreaterThan(0.5);
  expect(bottom!).toBeGreaterThan(0.1);
  expect(bottom!).toBeLessThan(0.3);
});

test("the crossing where a divider ends on another moves both at once", async () => {
  const app = await open();
  await app.waitFor("id:wb-junction-r-1-0");
  await app.drag("id:wb-junction-r-1-0", { x: 90, y: 70 });
  expect(weights(app, "r")[0]!).toBeGreaterThan(0.55);
  expect(weights(app, "c")[0]!).toBeGreaterThan(0.55);
});

test("⌘\\ splits the current pane across, ⇧⌘\\ down; the new pane takes the focus and starts empty", async () => {
  const app = await open();
  await app.keyboard.press("mod+\\");
  expect(state(app)).toMatch(/r:row\[[0-9./]+\]\(a\[\*t1,t2,t3\] wb-[a-z0-9-]+\[\] c:col/);
  await app.waitFor("id:wb-empty");
  expect(state(app)).toMatch(/focus=wb-/);
  await app.keyboard.press("mod+shift+\\");
  expect(state(app)).toMatch(/:col\[0.50\/0.50\]\(wb-[a-z0-9-]+\[\] wb-[a-z0-9-]+\[\]\)/);
});

test("⌘⌥ arrows move the current pane's focus to the one beside, with Shift they move its edge, ⌘⌥0 evens a division out", async () => {
  const app = await open();
  expect(state(app)).toContain("focus=a");
  await app.keyboard.press("mod+alt+right");
  expect(state(app)).toContain("focus=b");
  await app.keyboard.press("mod+alt+down");
  expect(state(app)).toContain("focus=d");
  await app.keyboard.press("mod+alt+left");
  expect(state(app)).toContain("focus=a");
  // The edge of the first pane, pushed outward.
  await app.keyboard.press("mod+alt+shift+right");
  expect(weights(app, "r")[0]!).toBeGreaterThan(0.5);
  await app.keyboard.press("mod+alt+0");
  expect(weights(app, "r")).toEqual([0.5, 0.5]);
});

test("Ctrl+Tab walks the current pane's tabs round", async () => {
  const app = await open();
  await app.keyboard.press("ctrl+tab");
  expect(state(app)).toContain("a[t1,*t2,t3]");
  await app.keyboard.press("ctrl+tab");
  await app.keyboard.press("ctrl+tab");
  expect(state(app)).toContain("a[*t1,t2,t3]");
  await app.keyboard.press("ctrl+shift+tab");
  expect(state(app)).toContain("a[t1,t2,*t3]");
});
