/** The list and a conversation on a real runtime: titles, opening, Markdown, sending, live lines. */
import { expect, test } from "nsh/test";
import { openApp, seeded } from "./fixture";

test("the runtime's conversations are listed with the messenger's titles", async () => {
  const app = await openApp();
  await app.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  await app.waitFor("text:Writer");
  await app.waitFor("text:周报小组");
});

test("opening a conversation shows its lines, Markdown rendered", async () => {
  const app = await openApp();
  await app.press(`id:session-${seeded.writerDirect}`);
  await app.waitFor("text:帮我写个摘要", { timeout: 10_000 });
  await app.waitFor("text:第一点");
  expect(app.texts().join("\n")).toContain("const x = 1;");
});

test("sending goes through the runtime and the line comes back by the event stream", async () => {
  const app = await openApp();
  await app.press(`id:session-${seeded.writerDirect}`);
  await app.waitFor("text:帮我写个摘要", { timeout: 10_000 });
  const line = `测试一句 ${Date.now()}`;
  await app.type("id:composer-input", line);
  await app.waitUntil(() => app.enabled("id:send-button"));
  await app.press("id:send-button");
  await app.waitFor(`text:${line}`, { timeout: 10_000 });
  // The draft is cleared: with nothing to send the button goes back to disabled (the rich editor's text is not an `app.value`).
  await app.waitUntil(() => !app.enabled("id:send-button"));
});
