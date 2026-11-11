/** A conversation's body: the transcript, the welcome, paging, the scroll-to-bottom button, the composer and the message menu. */
import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { openStory } from "./fixture";

const t = copyFor("zh");
const state = (app: any): string => app.texts().find((x: string) => x.startsWith("lines:")) ?? "";
const lineCount = (app: any): number => Number(/lines:(\d+)/.exec(state(app))?.[1] ?? 0);
const numbered = (app: any): number[] =>
  app.texts().flatMap((x: string) => {
    const m = /^第 (\d+) 条/.exec(x);
    return m ? [Number(m[1])] : [];
  });

async function open() {
  const app = await openStory("chat-stage");
  await app.waitFor("id:chat-stage", { timeout: 15_000 });
  return app;
}

test("Writer's direct shows its seeded lines over the composer, Markdown drawn", async () => {
  const app = await open();
  await app.waitFor("text:好的，这是摘要：", { timeout: 15_000 });
  expect(app.texts()).toContain("第一点");
  expect(app.shows("id:transcript")).toBe(true);
  expect(app.shows("id:composer-input")).toBe(true);
  expect(app.enabled("id:scroll-bottom")).toBe(false);
});

test("an empty conversation is the welcome; a line sent from the composer replaces it", async () => {
  const app = await open();
  await app.press("id:show-empty");
  await app.waitUntil(() => app.texts().includes("session:empty"), { timeout: 20_000 });
  await app.waitFor("id:chat-welcome", { timeout: 15_000 });
  expect(app.shows("id:transcript")).toBe(false);
  try {
    const line = `stage ${Date.now()}`;
    await app.type("id:composer-input", line);
    await app.keyboard.press("enter");
    await app.waitFor(`text:${line}`, { timeout: 15_000 });
    expect(app.shows("id:chat-welcome")).toBe(false);
    expect(app.shows("id:transcript")).toBe(true);
    expect(lineCount(app)).toBe(1);
  } finally {
    await app.press("id:story-cleanup");
    await app.waitUntil(() => app.texts().includes("cleaned"), { timeout: 15_000 });
  }
});

test("a long conversation opens at its newest line, pages older ones in, and the button comes back down", async () => {
  const app = await open();
  await app.press("id:story-bulk");
  await app.waitUntil(() => app.texts().includes("session:bulk"), { timeout: 100_000 });
  try {
    // The conversation opens with its newest 100 lines; the event stream had only the last one before.
    await app.waitUntil(() => lineCount(app) >= 100, { timeout: 20_000 });
    await app.waitUntil(() => numbered(app).includes(130), { timeout: 10_000 });
    // Opened at the foot: the newest is on screen, the oldest is not, and nothing offers a jump down.
    expect(numbered(app)).not.toContain(1);
    expect(app.enabled("id:scroll-bottom")).toBe(false);
    // Scrolling back brings the button; near the oldest line the next page comes in (the host's list may
    // ask for it as soon as it opens: either way every line ends up loaded and nothing older is offered).
    await app.waitUntil(() => numbered(app).includes(130), { timeout: 10_000 });
    for (let i = 0; i < 20 && !app.enabled("id:scroll-bottom"); i++) {
      await app.scroll("id:transcript", -1500).catch(() => {});
      await app.wait(300);
    }
    expect(app.enabled("id:scroll-bottom")).toBe(true);
    for (let i = 0; i < 8 && lineCount(app) < 130; i++) {
      await app.scroll("id:transcript", -3000).catch(() => {});
      await app.wait(400);
    }
    await app.waitUntil(() => lineCount(app) === 130 && state(app).includes("older:no"), { timeout: 15_000 });
    await app.waitUntil(() => numbered(app).includes(1), { timeout: 10_000 });
    await app.press("id:scroll-bottom");
    await app.waitUntil(() => numbered(app).includes(130) && !app.enabled("id:scroll-bottom"), { timeout: 10_000 });
  } finally {
    await app.press("id:story-cleanup");
    await app.waitUntil(() => app.texts().includes("cleaned"), { timeout: 30_000 });
  }
}, 170_000);

test("a secondary press on a line opens its menu, and Escape closes it", async () => {
  const app = await open();
  await app.waitFor("text:好的，这是摘要：", { timeout: 15_000 });
  expect(app.shows("id:msg-context-menu")).toBe(false);
  await app.rightClick("id:msg-reply");
  await app.waitFor("id:msg-context-menu", { timeout: 5_000 });
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:msg-context-menu"));
});

test("nothing selected is the invitation to pick a conversation or add a Bot", async () => {
  const app = await open();
  await app.press("id:show-none");
  await app.waitFor(`text:${t.top.pickSession}`, { timeout: 5_000 });
  expect(app.texts()).toContain(t.sidebar.addBot);
  await app.press(`text:${t.sidebar.addBot}`);
  await app.waitUntil(() => app.texts().includes("create-bot"));
});
