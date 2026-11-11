/** A live resize re-runs the breakpoints' readers only when the window crosses one (`platform/viewport.ts`). */
import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const runs = (app: Awaited<ReturnType<typeof openStory>>) => {
  const text = app.texts().find((x) => x.startsWith("narrow:")) ?? "";
  return Object.fromEntries([...text.matchAll(/(\w+):(\d+)/g)].map((m) => [m[1], Number(m[2])]));
};

test("resizing without crossing a breakpoint re-runs none of their readers; crossing one runs it once", async () => {
  const app = await openStory("viewport", { width: 1200, height: 800 });
  await app.waitFor("id:viewport-runs");
  const before = runs(app);
  expect(before.phone).toBe(0);
  for (let width = 1180; width >= 800; width -= 20) await app.setViewport(width, 800);
  expect(runs(app)).toEqual(before);

  // Below 720: the width query flips once; the phone layout and the motion query stay put.
  await app.setViewport(700, 800);
  await app.setViewport(690, 800);
  const at700 = runs(app);
  expect(at700.width).toBe(before.width! + 1);
  expect(at700.narrow).toBe(before.narrow);
  expect(at700.motion).toBe(before.motion);

  // Below 680: the phone layout.
  await app.setViewport(600, 800);
  await app.setViewport(420, 800);
  const phone = runs(app);
  expect(phone.phone).toBe(1);
  expect(phone.narrow).toBe(before.narrow! + 1);
  expect(phone.motion).toBe(before.motion);
});
