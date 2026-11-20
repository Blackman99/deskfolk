/**
 * The window's life on Windows and Linux under NSH's window model (longbridge/nsh#2307): NSH's
 * host never shows and leaves the app's window to the app, so a later launch (`reopen`) brings it
 * back here, and a login launch (`--hidden`) starts with it put away (`platform/window-life.ts`).
 */
import { expect, test } from "nsh/test";
import { openApp } from "./fixture";

const READY_MS = 20_000;

test("on Windows the close button puts the window away, and a later launch brings it back and forward", async () => {
  const app = await openApp({ platform: "windows" });
  const main = app.window("main");
  await app.waitUntil(() => main.state()?.visible === true, { timeout: READY_MS });
  await main.pressClose();
  expect(main.state()?.visible).toBe(false);
  expect(app.quit()).toBe(false);
  await app.reopen();
  await app.waitUntil(() => main.state()?.visible === true);
  expect(main.state()?.focused).toBe(true);
  expect(app.quit()).toBe(false);
});

test("a login launch starts with the window put away until a later launch shows it", async () => {
  const app = await openApp({ platform: "linux" }, { hidden: true, trayShown: true });
  const main = app.window("main");
  await app.waitUntil(() => main.state() !== null || app.windowIds().includes("main"), { timeout: READY_MS });
  await app.wait(500);
  expect(main.state()?.visible ?? false).toBe(false);
  await app.reopen();
  await app.waitUntil(() => main.state()?.visible === true);
});
