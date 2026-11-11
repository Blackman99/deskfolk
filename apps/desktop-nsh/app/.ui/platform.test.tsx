import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const wheel = (x: number, y: number, dy: number, ctrl = false) => ({
  x, y, dx: 0, dy, ctrl, meta: false, shift: false, alt: false, pinch: false, phase: null, momentum: null,
});

test("a forwarded wheel reaches the innermost view under the pointer", async () => {
  const app = await openStory("platform");
  await app.waitFor("id:wheel-outer", { timeout: 10_000 });
  await app.host.send("shell.wheel", wheel(50, 50, 40));
  await app.waitUntil(() => app.texts().includes("outer:40"));
  await app.host.send("shell.wheel", wheel(250, 200, 40));
  // The inner box took it, with the point inside it; the outer one heard nothing more.
  await app.waitUntil(() => app.texts().includes("inner:50050"));
  expect(app.texts()).toContain("outer:40");
  await app.host.send("shell.wheel", wheel(800, 600, 40));
  expect(app.texts()).toContain("outer:40");
});

test("a pinch arrives as a ctrl wheel whose step is its zoom", async () => {
  const app = await openStory("platform");
  await app.waitFor("id:wheel-outer", { timeout: 10_000 });
  await app.host.send("shell.wheel", wheel(50, 50, -100 * Math.log(1.25), true));
  await app.waitUntil(() => app.texts().includes("zoom:1.25"));
});

test("a dialog's scrim keeps the wheel from the views under it", async () => {
  const app = await openStory("platform");
  await app.waitFor("id:wheel-outer", { timeout: 10_000 });
  await app.press("id:wheel-open-dialog");
  await app.waitFor("id:wheel-dialog");
  // On the scrim, over the outer box: it hears nothing.
  await app.host.send("shell.wheel", wheel(50, 50, 40));
  // In the middle of the window, inside the dialog's own view: that view hears it.
  await app.host.send("shell.wheel", wheel(550, 380, 40));
  await app.waitUntil(() => app.texts().includes("dialog:40"));
  expect(app.texts()).toContain("outer:0");
  // Closed, the outer box hears the wheel again.
  await app.press("id:modal-close");
  await app.waitUntil(() => !app.shows("id:wheel-dialog"));
  await app.host.send("shell.wheel", wheel(50, 50, 40));
  await app.waitUntil(() => app.texts().includes("outer:40"));
});

test("a full-window overlay's layer reaches a view its content makes through a render prop", async () => {
  const app = await openStory("platform");
  await app.waitFor("id:wheel-outer", { timeout: 10_000 });
  await app.press("id:wheel-open-overlay");
  await app.waitFor("id:wheel-overlay");
  await app.host.send("shell.wheel", wheel(50, 50, 40));
  // Inside the box the render prop filled, under the overlay's layer.
  await app.host.send("shell.wheel", wheel(550, 350, 40));
  await app.waitUntil(() => app.texts().includes("overlay:40"));
  expect(app.texts()).toContain("outer:0");
});
