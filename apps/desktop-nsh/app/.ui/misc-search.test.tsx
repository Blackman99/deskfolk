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
/** The story without the search open yet: the long lists open from their own buttons. */
const story = async () => {
  const app = await openStory("misc");
  await app.waitFor("id:story-show-search", { timeout: 10_000 });
  await app.press("id:story-show-search");
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

test("a one-letter query's thousands of hits get rows a page at a time, more as the list is scrolled", async () => {
  const app = await story();
  await app.press("id:story-open-many");
  await app.waitFor("id:search-hit-0");
  // Every hit used to get a row at once, and a row asked of every hit whether it can be opened.
  expect(app.count("id:search-results >> role:option")).toBe(50);
  expect(app.texts().some((text) => text.includes("2000"))).toBe(true);
  // To the end of the rows there are: the next page comes within a screen of it.
  await app.scroll("id:search-results", 6000);
  await app.waitUntil(() => app.count("id:search-results >> role:option") > 50);
  expect(app.count("id:search-results >> role:option")).toBe(100);
});

test("the arrows go on into the next page, and up from the first stays rather than going round", async () => {
  const app = await story();
  // The first 49 hits are in a conversation that is gone, so the list starts on the 50th, its last row.
  await app.press("id:story-open-many-closed");
  await app.waitFor("id:search-hit-0");
  expect(app.count("id:search-results >> role:option")).toBe(50);
  await app.keyboard.press("down");
  expect(app.count("id:search-results >> role:option")).toBe(100);
  await app.submit("id:global-search-input");
  await app.waitFor("id:global-search-input", { state: "gone" });
  expect(picked(app)).toContain('"messageId":"many-50"');

  await app.press("id:story-open-many-closed");
  await app.waitFor("id:search-hit-0");
  await app.keyboard.press("down");
  await app.keyboard.press("up");
  // Going round would land on the 100th, which is not the last of the 2000.
  await app.keyboard.press("up");
  await app.submit("id:global-search-input");
  await app.waitFor("id:global-search-input", { state: "gone" });
  expect(picked(app)).toContain('"messageId":"many-49"');
});

test("on a phone the search fills the window and drops the footer", async () => {
  const app = await open();
  await app.setViewport(390, 800);
  await app.waitFor("id:global-search-input");
  expect(app.shows("text:Esc")).toBe(false);
  expect(app.shows("id:search-cancel")).toBe(true);
});
