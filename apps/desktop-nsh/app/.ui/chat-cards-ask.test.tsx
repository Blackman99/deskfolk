import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { openStory } from "./fixture";

const t = copyFor("zh");

test("a waiting question says so, and its choices toggle and send what you picked and wrote", async () => {
  const app = await openStory("chat-cards");
  await app.waitFor("id:card-ask", { timeout: 10_000 });
  await app.waitFor(`text:${t.stream.waitingAnswer}`);
  expect(app.texts()).toContain("报告要哪些部分？");
  expect(app.texts()).toContain(t.stream.askPickAny);
  expect(app.texts()).toContain("开头一段");
  // Nothing chosen or written: nothing to send.
  await expect(app.press("id:card-ask >> id:ask-send")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.press("id:card-ask >> label:风险");
  await app.press("id:card-ask >> label:摘要（推荐）");
  await app.press("id:card-ask >> label:风险");
  await app.type("id:card-ask >> id:ask-input", "尽量短");
  await app.press("id:card-ask >> id:ask-send");
  await app.waitUntil(() => app.texts().includes("reply:ask-1:摘要（推荐）|尽量短"));
});

test("a single choice swaps its one pick, and a tap on it again lets it go", async () => {
  const app = await openStory("chat-cards");
  await app.waitFor("id:card-ask-single", { timeout: 10_000 });
  expect(app.texts()).toContain(t.stream.askPickOne);
  await app.press("id:card-ask-single >> label:A 版");
  await app.press("id:card-ask-single >> label:B 版");
  await app.press("id:card-ask-single >> id:ask-send");
  await app.waitUntil(() => app.texts().includes("reply:ask-2:B 版|"));
  await app.press("id:card-ask-single >> label:B 版");
  await expect(app.press("id:card-ask-single >> id:ask-send")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
});

test("an answered question keeps what you chose and wrote; an ended one is read-only", async () => {
  const app = await openStory("chat-cards");
  await app.waitFor("id:card-ask-answered", { timeout: 10_000 });
  expect(app.texts()).toContain("先做中文，再补英文。");
  expect(app.texts().some((text) => text.startsWith(`${t.stream.askAnswered} · `))).toBe(true);
  // The chosen one stays; no form.
  expect(app.shows("id:card-ask-answered >> id:ask-input")).toBe(false);
  await expect(app.press("id:card-ask-answered >> label:不要")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  expect(app.texts()).toContain(t.notifications.askEndedReadOnly);
  expect(app.shows("id:card-ask-ended >> id:ask-input")).toBe(false);
});

test("the Bot's name opens its profile", async () => {
  const app = await openStory("chat-cards");
  await app.waitFor("id:card-ask", { timeout: 10_000 });
  await app.press("id:card-ask >> id:ask-sender");
  await app.waitUntil(() => app.texts().includes("profile:bot-writer"));
});
