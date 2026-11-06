import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const open = async () => {
  const app = await openStory("misc");
  await app.waitFor("id:story-show-search", { timeout: 10_000 });
  await app.press("id:story-show-search");
  await app.press("id:story-open-search");
  await app.waitFor("id:global-search-input");
  return app;
};
const picked = (app: Awaited<ReturnType<typeof open>>) => app.texts().find((text) => text.startsWith("picked:")) ?? "";

test("before a query it says what it searches; a query finds the seeded messages, grouped by kind", async () => {
  const app = await open();
  await app.waitFor("id:search-intro");
  await app.type("id:global-search-input", "摘要");
  await app.waitFor("id:search-hit-0", { timeout: 15_000 });
  await app.waitFor("id:search-count");
  expect(app.shows("id:search-intro")).toBe(false);
  // The kind chips narrow the list: files have none for this word.
  await app.press("id:search-category-file");
  await app.waitFor("id:search-hit-0", { state: "gone" });
  await app.waitFor("id:search-empty");
  await app.press("id:search-category-all");
  await app.waitFor("id:search-hit-0");
  // A query nothing matches says so.
  await app.clear("id:global-search-input");
  await app.type("id:global-search-input", "zzzqqq不存在");
  await app.waitFor("id:search-empty", { timeout: 15_000 });
  // The ✕ clears the query and the intro is back.
  await app.press("id:search-clear");
  await app.waitFor("id:search-intro");
});

test("Return opens the hit the arrows are on, and the caller gets the jump", async () => {
  const app = await open();
  await app.type("id:global-search-input", "摘要");
  await app.waitFor("id:search-hit-0", { timeout: 15_000 });
  await app.submit("id:global-search-input");
  await app.waitFor("id:global-search-input", { state: "gone" });
  expect(picked(app)).toContain("sessionId");

  // A press on a hit opens it too.
  await app.press("id:story-open-search");
  await app.waitFor("id:global-search-input");
  await app.type("id:global-search-input", "摘要");
  await app.waitFor("id:search-hit-0", { timeout: 15_000 });
  const count = app.count("id:search-results >> role:option");
  expect(count).toBeGreaterThan(0);
  await app.press("id:search-hit-0");
  await app.waitFor("id:global-search-input", { state: "gone" });
  expect(picked(app)).toContain("sessionId");
});

test("the arrows move among the hits; Escape and Cancel close without a choice", async () => {
  const app = await open();
  await app.type("id:global-search-input", "Writer");
  await app.waitFor("id:search-hit-0", { timeout: 15_000 });
  await app.keyboard.press("down");
  await app.keyboard.press("up");
  await app.keyboard.press("escape");
  await app.waitFor("id:global-search-input", { state: "gone" });
  expect(picked(app)).toContain("closed");
  expect(picked(app)).not.toContain("sessionId");
  await app.press("id:story-open-search");
  await app.waitFor("id:global-search-input");
  await app.press("id:search-cancel");
  await app.waitFor("id:global-search-input", { state: "gone" });
});

test("on a phone the search fills the window and drops the footer", async () => {
  const app = await open();
  await app.setViewport(390, 800);
  await app.waitFor("id:global-search-input");
  expect(app.shows("text:Esc")).toBe(false);
  expect(app.shows("id:search-cancel")).toBe(true);
});
