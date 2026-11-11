import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const OPEN_MS = 20_000;

test("a workbook shows its tabs, column letters, row numbers and cells as strings, and switches sheets", async () => {
  const app = await openStory("office");
  await app.waitFor("id:story-open-sheet", { timeout: 10_000 });
  await app.press("id:story-open-sheet");
  await app.waitFor("id:office-grid", { timeout: OPEN_MS });
  expect(app.texts()).toContain("Excel");
  expect(app.texts()).toContain("只读预览");
  // The tabs: the visible sheets, the first showing.
  expect(app.texts()).toContain("花费");
  expect(app.texts()).toContain("第二页");
  // The grid: the messenger's column letters over the sheet's own cells.
  for (const letter of ["A", "B", "C"]) expect(app.texts()).toContain(letter);
  for (const cell of ["金额", "日期", "Bot", "2026-11-01", "Editor", "13.5"]) expect(app.texts()).toContain(cell);
  expect(app.texts()).toContain("11");
  // The sheet hint is the spreadsheet's, not the document's.
  expect(app.texts().some((t) => t.startsWith("显示单元格内容与公式的已存结果"))).toBe(true);
  expect(app.texts().some((t) => t.startsWith("字体与复杂排版"))).toBe(false);
  expect(app.shows("id:office-truncated")).toBe(false);

  await app.press("id:office-sheet-1");
  await app.waitUntil(() => !app.texts().includes("金额"));
  expect(app.texts()).toContain("a");
  expect(app.texts()).toContain("b");
  expect(app.texts()).not.toContain("Editor");
  await app.press("id:office-sheet-0");
  await app.waitUntil(() => app.texts().includes("金额"));
});

test("a sheet with more than 1000 value rows says some were left out", async () => {
  const app = await openStory("office");
  await app.waitFor("id:story-open-big", { timeout: 10_000 });
  await app.press("id:story-open-big");
  await app.waitFor("id:office-grid", { timeout: OPEN_MS });
  expect(app.texts()).toContain("Many");
  await app.waitFor("id:office-truncated");
  expect(app.texts().some((t) => t.startsWith("已限制为前 50 张可见工作表"))).toBe(true);
  expect(app.texts()).toContain("row 1");
});
