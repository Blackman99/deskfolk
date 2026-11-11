import { effect, signal } from "nsh";
import { expect, test } from "nsh/test";
import { openWheelLayer, regionAt, topWheelLayer } from "./wheel";

test("the wheel goes to the innermost view under the pointer", () => {
  const board = { name: "board", rect: { x: 0, y: 0, width: 800, height: 600 } };
  const minimap = { name: "minimap", rect: { x: 600, y: 450, width: 180, height: 120 } };
  const gone = { name: "gone", rect: null };
  expect(regionAt([board, minimap, gone], 700, 500)?.name).toBe("minimap");
  expect(regionAt([minimap, board], 100, 100)?.name).toBe("board");
  expect(regionAt([board, minimap], 900, 100)).toBe(null);
});

test("a popup's scrim takes the wheel from what is under it", () => {
  const terminal = { name: "terminal", layer: 0, rect: { x: 0, y: 0, width: 800, height: 600 } };
  const lightbox = { name: "lightbox", layer: 1, rect: { x: 200, y: 100, width: 400, height: 400 } };
  // No popup open: the window's views hear it.
  expect(regionAt([terminal, lightbox], 50, 50)?.name).toBe("terminal");
  // A popup open: over its scrim nothing hears it, over its own view that view does.
  expect(regionAt([terminal, lightbox], 50, 50, 1)).toBe(null);
  expect(regionAt([terminal, lightbox], 300, 300, 1)?.name).toBe("lightbox");
  // A newer popup over that one: neither hears it.
  expect(regionAt([terminal, lightbox], 300, 300, 2)).toBe(null);
});

test("the newest open popup is the one on top, until it closes", () => {
  const settings = signal(false);
  const confirm = signal(false);
  let settingsLayer = 0;
  let confirmLayer = 0;
  effect(() => {
    if (settings()) settingsLayer = openWheelLayer();
  });
  effect(() => {
    if (confirm()) confirmLayer = openWheelLayer();
  });
  expect(topWheelLayer()).toBe(0);
  settings.set(true);
  expect(topWheelLayer()).toBe(settingsLayer);
  confirm.set(true);
  expect(confirmLayer).toBeGreaterThan(settingsLayer);
  expect(topWheelLayer()).toBe(confirmLayer);
  confirm.set(false);
  expect(topWheelLayer()).toBe(settingsLayer);
  // The first one closing while a later one is open leaves the later one on top.
  confirm.set(true);
  settings.set(false);
  expect(topWheelLayer()).toBe(confirmLayer);
  confirm.set(false);
  expect(topWheelLayer()).toBe(0);
});
