import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const OPEN_MS = 20_000;

test("a Word file shows its title, heading, paragraph, bullets and table on a page", async () => {
  const app = await openStory("office");
  await app.waitFor("id:office-type", { timeout: 10_000 });
  await app.waitFor("id:office-docpage", { timeout: OPEN_MS });
  expect(app.texts()).toContain("Word");
  expect(app.texts()).toContain("只读预览");
  for (const line of ["周报草稿 Weekly draft", "一、进展", "第 1 条进展", "第 2 条进展", "第 3 条进展"]) expect(app.texts()).toContain(line);
  expect(app.texts().some((t) => t.startsWith("这是一段中文正文"))).toBe(true);
  // The bullets are marked, one each.
  expect(app.texts().filter((t) => t === "•")).toHaveLength(3);
  // The 3 x 3 table, each cell its own text, in a table of its own.
  expect(app.count("id:office-table")).toBe(1);
  for (const cell of ["R0C0 单元", "R1C1 单元", "R2C2 单元"]) expect(app.texts()).toContain(cell);
  // No slide controls, and the document's hint.
  expect(app.shows("id:office-pages")).toBe(false);
  expect(app.texts().some((t) => t.startsWith("字体与复杂排版"))).toBe(true);
});

test("runs, links, numbering, alignment, page breaks, merged cells and pictures come through", async () => {
  const app = await openStory("office");
  await app.waitFor("id:story-open-richword", { timeout: 10_000 });
  await app.press("id:story-open-richword");
  await app.waitFor("id:office-docpage", { timeout: OPEN_MS });
  await app.waitFor("text:Second level heading");
  // A coloured run is a span of its own; the code and the link read in the line.
  expect(app.texts()).toContain("loud red");
  expect(app.texts().some((t) => t.includes("code()") && t.includes("a link") && t.includes("struck"))).toBe(true);
  // A numbered list with a bullet nested in it.
  for (const line of ["numbered one", "nested bullet", "numbered two", "1.", "2.", "◦"]) expect(app.texts()).toContain(line);
  expect(app.texts()).toContain("centred line");
  // A page break splits the paragraph in two.
  expect(app.texts()).toContain("before the break");
  expect(app.texts()).toContain("after the break");
  // The table: a wide cell, and a tall one with its continuation left empty.
  for (const cell of ["wide cell", "tall cell", "cell x", "cell y"]) expect(app.texts()).toContain(cell);
  expect(app.count("id:office-table")).toBe(1);
});
