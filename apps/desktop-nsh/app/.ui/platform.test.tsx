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
