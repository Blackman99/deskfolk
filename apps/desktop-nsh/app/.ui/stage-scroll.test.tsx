/**
 * The jump to the bottom takes the reader to the foot of the conversation, whatever the newest line
 * is: a newest line taller than the window used to leave them at its head, with the rest below.
 */
import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const distanceOf = (app: any): number => Number(/distance:(-?\d+)/.exec(app.texts().find((x: string) => x.startsWith("distance:")) ?? "")?.[1] ?? NaN);

async function scrolledUp() {
  const app = await openStory("stage-scroll");
  await app.waitFor("id:transcript", { timeout: 15_000 });
  for (let i = 0; i < 12 && !(distanceOf(app) > 600); i++) {
    await app.scroll("id:transcript", -400).catch(() => {});
    await app.wait(150);
  }
  expect(distanceOf(app)).toBeGreaterThan(600);
  return app;
}

test("the animated jump lands at the foot when the newest line is taller than the window", async () => {
  const app = await scrolledUp();
  await app.press("id:story-animated");
  await app.wait(1500);
  expect(distanceOf(app)).toBeLessThanOrEqual(2);
  expect(app.texts()).toContain("button:no");
});

test("the instant jump lands at the foot too", async () => {
  const app = await scrolledUp();
  await app.press("id:story-instant");
  await app.wait(600);
  expect(distanceOf(app)).toBeLessThanOrEqual(2);
});

test("a short newest line ends at the foot as before", async () => {
  const app = await scrolledUp();
  await app.press("id:story-short");
  await app.wait(300);
  await app.press("id:story-animated");
  await app.wait(1500);
  expect(distanceOf(app)).toBeLessThanOrEqual(2);
});
