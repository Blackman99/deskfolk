import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

async function keys() {
  const app = await openStory("job-keys", { width: 1200, height: 800 });
  await app.waitFor("id:ticket-main-tk-1", { timeout: 15_000 });
  const row = () => app.texts().find((t) => t.startsWith("row:")) ?? "";
  const card = () => app.texts().find((t) => t.startsWith("card:")) ?? "";
  return { app, row, card };
}

test("Up and Down walk the rail's rows while one has the focus, and stop at the ends", async () => {
  const { app, row } = await keys();
  // Nobody has the focus: the keys are nobody's.
  await app.keyboard.press("down");
  expect(row()).toBe("row:-");
  await app.press("id:rail-row-tk-1");
  await app.waitUntil(() => row() === "row:tk-1");
  await app.keyboard.press("down");
  await app.waitUntil(() => row() === "row:tk-2");
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.waitUntil(() => row() === "row:tk-4");
  await app.keyboard.press("down");
  await app.wait(100);
  expect(row()).toBe("row:tk-4");
  await app.keyboard.press("up");
  await app.waitUntil(() => row() === "row:tk-3");
});

test("Left and Right pass the focus to the neighbouring column's card, and stop at the edges", async () => {
  const { app, card } = await keys();
  await app.press("id:ticket-main-tk-3");
  await app.waitUntil(() => card() === "card:tk-3");
  // 排版 (#03, todo) is in the first column: Left has nowhere to go.
  await app.keyboard.press("left");
  await app.wait(100);
  expect(card()).toBe("card:tk-3");
  // The next column holds 写初稿 (#02, doing); the card at or after #03 there is none, so its first.
  await app.keyboard.press("right");
  await app.waitUntil(() => card() === "card:tk-2");
  await app.keyboard.press("right");
  await app.wait(100);
  // review is empty: the focus stays.
  expect(card()).toBe("card:tk-2");
  await app.keyboard.press("left");
  await app.waitUntil(() => card() === "card:tk-3");
});
