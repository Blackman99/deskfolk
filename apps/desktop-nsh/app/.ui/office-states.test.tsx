import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const OPEN_MS = 20_000;
const FAILED = "无法预览这份文件。请确认文件完整且未加密，或用系统应用打开。";
const TOO_LARGE = "文件超过预览容量限制，请用系统应用打开（文件上限 50 MiB，解压后 128 MiB）。";

test("a file that is not an Office package says it cannot be previewed, and retry asks again", async () => {
  const app = await openStory("office");
  await app.waitFor("id:story-open-broken", { timeout: 10_000 });
  await app.press("id:story-open-broken");
  await app.waitFor("id:office-error", { timeout: OPEN_MS });
  expect(app.texts()).toContain(FAILED);
  expect(app.texts()).not.toContain(TOO_LARGE);
  expect(app.shows("id:office-docpage")).toBe(false);
  expect(app.shows("id:office-retry")).toBe(true);
  await app.press("id:office-retry");
  await app.waitFor("id:office-error", { timeout: OPEN_MS });
  expect(app.texts()).toContain(FAILED);
});

test("a zip bomb is refused as too large, with no retry", async () => {
  const app = await openStory("office");
  await app.waitFor("id:story-open-bomb", { timeout: 10_000 });
  await app.press("id:story-open-bomb");
  await app.waitFor("id:office-error", { timeout: OPEN_MS });
  expect(app.texts()).toContain(TOO_LARGE);
  expect(app.texts()).not.toContain(FAILED);
  expect(app.shows("id:office-retry")).toBe(false);
});

test("a file the runtime does not have is an error", async () => {
  const app = await openStory("office");
  await app.waitFor("id:story-open-missing", { timeout: 10_000 });
  await app.press("id:story-open-missing");
  await app.waitFor("id:office-error", { timeout: OPEN_MS });
  expect(app.texts()).toContain(FAILED);
});

test("opening another file starts over, and full screen keeps the sheet it was on", async () => {
  const app = await openStory("office");
  await app.waitFor("id:story-open-sheet", { timeout: 10_000 });
  await app.press("id:story-open-sheet");
  await app.waitFor("id:office-grid", { timeout: OPEN_MS });
  await app.press("id:office-sheet-1");
  await app.waitUntil(() => app.texts().includes("a"));
  // Full screen shows the same document on the same sheet, with the file's name.
  await app.press("id:office-full");
  await app.waitFor("id:office-filename");
  expect(app.texts()).toContain("sample.xlsx");
  expect(app.texts()).toContain("b");
  expect(app.texts()).not.toContain("金额");
  expect(app.count("id:office-type")).toBe(1);
  await app.press("id:office-full");
  await app.waitFor("id:office-filename", { state: "gone" });
  expect(app.texts()).toContain("b");
  // Another file starts over: loading, then its own first sheet.
  await app.press("id:story-open-big");
  await app.waitFor("text:Many", { timeout: OPEN_MS });
  expect(app.texts()).not.toContain("b");
  await app.press("id:story-open-sheet");
  await app.waitFor("id:office-grid", { timeout: OPEN_MS });
  await app.waitUntil(() => app.texts().includes("金额"));
});
