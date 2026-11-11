import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;
const state = (app: App) => app.texts().find((t) => t.includes("float="))!;
const open = async () => {
  const app = await openStory("workbench");
  await app.waitFor("id:wb-state", { timeout: 15_000 });
  return app;
};
const floatId = (app: App) => /float=([^[;-][^[]*)\[/.exec(state(app))?.[1];
const frame = (app: App) => {
  const m = /@(-?\d+),(-?\d+),(\d+)x(\d+)/.exec(state(app));
  return m ? { x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]! } : null;
};

test("dragging a tab shows where it will land and a chip that follows the pointer; letting go in another pane moves it there", async () => {
  const app = await open();
  expect(app.shows("id:wb-drop")).toBe(false);
  expect(app.shows("id:wb-ghost")).toBe(false);
  // Held over the middle of the pane at the top right.
  await app.dragAndHold("id:wb-tab-button-t2", { x: 715, y: 160 });
  expect(app.shows("id:wb-drop")).toBe(true);
  expect(app.shows("id:wb-ghost")).toBe(true);
  // The chip says what is carried, in plain words, and the tab it left stays in the row, faded.
  expect(app.texts().filter((t) => t === "用量").length).toBeGreaterThan(1);
  expect(app.shows("id:wb-tab-t2")).toBe(true);
  await app.drop();
  expect(app.shows("id:wb-drop")).toBe(false);
  expect(app.shows("id:wb-ghost")).toBe(false);
  // It is now the active tab of the pane it was dropped on, which is the current one.
  expect(state(app)).toContain("a[*t1,t3]");
  expect(state(app)).toMatch(/b\[t4,\*t2\]/);
  expect(state(app)).toContain("focus=b");
  await app.waitFor("id:body-t2");
});

test("let go over a pane's edge, the drop splits it and the tab gets the new half", async () => {
  const app = await open();
  await app.dragAndHold("id:wb-tab-button-t3", { x: 880, y: 170 });
  expect(app.shows("id:wb-drop")).toBe(true);
  await app.drop();
  expect(state(app)).toContain("a[*t1,t2]");
  // Pane b is divided across, the tab in a new pane beside it.
  expect(state(app)).toMatch(/b\[\*t4\] wb-[a-z0-9-]+\[\*t3\]/);
  expect(app.count("id:wb-leaf")).toBe(4);
});

test("dragging a tab back onto its own pane's middle changes nothing", async () => {
  const app = await open();
  const before = state(app);
  await app.drag("id:wb-tab-button-t2", { x: 20, y: 180 });
  expect(state(app)).toBe(before);
  expect(app.shows("id:wb-drop")).toBe(false);
});

test("a tiled pane's bare strip is the window's title bar: dragging it carries no pane, and its right click is the pane's menu", async () => {
  const app = await open();
  // The layout, not which pane is current: a press in pane b makes it the current one, as anywhere in it.
  const panes = () => state(app).replace(/ focus=.*$/, "");
  const before = panes();
  // The window moves under a real pointer (the platform's `windowDrag`); here, nothing of the layout does.
  await app.dragAndHold("id:wb-strip-b", { x: -400, y: 160 });
  expect(app.shows("id:wb-ghost")).toBe(false);
  expect(app.shows("id:wb-drop")).toBe(false);
  await app.drop();
  expect(panes()).toBe(before);
  // A tab still carries itself, from the same strip.
  await app.dragAndHold("id:wb-tab-button-t4", { x: -400, y: 160 });
  expect(app.shows("id:wb-ghost")).toBe(true);
  await app.drop();
  expect(state(app)).toMatch(/a\[[^\]]*t4[^\]]*\]/);
  await app.rightClick("id:wb-strip-a");
  await app.waitFor("id:wb-split-down");
});

test("a tab floated from its menu leaves a floating pane; it is moved by its title bar and pulled open by its corner", async () => {
  const app = await open();
  await app.rightClick("id:wb-tab-t1");
  await app.waitFor("id:wb-float-tab");
  await app.press("id:wb-float-tab");
  expect(state(app)).toContain("a[*t2,t3]");
  const id = floatId(app)!;
  expect(id).toBeTruthy();
  expect(app.shows(`id:wb-float-${id}`)).toBe(true);
  const first = frame(app)!;
  await app.drag(`id:wb-strip-${id}`, { x: 100, y: 50 });
  const moved = frame(app)!;
  expect(moved.x - first.x).toBe(100);
  expect(moved.y - first.y).toBe(50);
  expect(moved.w).toBe(first.w);
  await app.drag("id:wb-grip-se", { x: 40, y: 30 });
  const grown = frame(app)!;
  expect(grown.w).toBeGreaterThan(moved.w);
  expect(grown.h).toBeGreaterThan(moved.h);
  expect(grown.x).toBe(moved.x);
  // The edge on the other side pulls the opposite way and moves the pane's own edge.
  await app.drag("id:wb-grip-w", { x: -30 });
  const wider = frame(app)!;
  expect(wider.w).toBe(grown.w + 30);
  expect(wider.x).toBe(grown.x - 30);
});

test("a floating pane's tab can be dragged out of it into the tiled panes", async () => {
  const app = await open();
  await app.rightClick("id:wb-tab-t3");
  await app.press("id:wb-float-tab");
  const id = floatId(app)!;
  await app.dragAndHold(`id:wb-tab-button-t3`, { x: 0, y: 380 });
  await app.drop();
  expect(state(app)).toContain("float=-");
  expect(state(app)).not.toContain(id);
});

test("double pressing a floating pane's title bar docks it; the menu's Dock does the same", async () => {
  const app = await open();
  await app.rightClick("id:wb-tab-t1");
  await app.press("id:wb-float-tab");
  const id = floatId(app)!;
  await app.press(`id:wb-strip-${id}`);
  await app.press(`id:wb-strip-${id}`);
  expect(state(app)).toContain("float=-");
  expect(state(app)).toMatch(/\[\*t1\]/);
  // And from the menu.
  await app.rightClick("id:wb-tab-t2");
  await app.press("id:wb-float-tab");
  const next = floatId(app)!;
  await app.rightClick(`id:wb-body-${next}`);
  await app.press("id:wb-dock");
  expect(state(app)).toContain("float=-");
});
