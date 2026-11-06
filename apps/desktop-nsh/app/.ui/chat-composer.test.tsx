import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const open = async () => {
  const app = await openStory("chat-composer");
  await app.waitFor("id:composer-input", { timeout: 10_000 });
  return app;
};

test("Enter sends the draft and clears the box; an empty one sends nothing", async () => {
  const app = await open();
  await app.submit("id:composer-input");
  expect(app.texts()).toContain("sent:0");
  await app.type("id:composer-input", "你好");
  await app.waitUntil(() => app.texts().includes("draft:你好"));
  await app.submit("id:composer-input");
  await app.waitUntil(() => app.texts().includes("sent:1"));
  await app.waitUntil(() => app.value("id:composer-input") === "");
});

test("a locked box takes nothing", async () => {
  const app = await open();
  await app.press("id:toggle-editable");
  expect(app.enabled("id:composer-input")).toBe(false);
  await app.press("id:toggle-editable");
  expect(app.enabled("id:composer-input")).toBe(true);
});

test("an @ offers the Bots, a pick puts the name in the box, Esc-less typing narrows the list", async () => {
  const app = await open();
  await app.type("id:composer-input", "请 @");
  await app.waitFor("id:mention-popup");
  // A group: everyone leads, then the Bots.
  for (const id of ["mention-everyone", "mention-bot-writer", "mention-bot-editor"]) expect(app.shows(`id:${id}`)).toBe(true);
  await app.type("id:composer-input", "Edi");
  await app.waitFor("id:mention-bot-writer", { state: "gone" });
  await app.press("id:mention-bot-editor");
  await app.waitFor("id:mention-popup", { state: "gone" });
  await app.waitUntil(() => (app.value("id:composer-input") ?? "").startsWith("请 @Editor"));
});

test("a suggestion drafts its line into the box", async () => {
  const app = await open();
  await app.press("text:换个语气");
  await app.waitUntil(() => app.value("id:composer-input") === "换个更轻松的语气");
});

test("the quote names whose line it is and goes with its ✕", async () => {
  const app = await open();
  await app.waitFor("id:composer-quote");
  await app.press("id:composer-quote-cancel");
  await app.waitFor("id:composer-quote", { state: "gone" });
});

test("the send button turns into Stop and greys with nothing to send", async () => {
  const app = await open();
  await app.press("id:send-button");
  await app.waitUntil(() => app.texts().includes("sent:1"));
  await app.press("id:send-disabled");
  expect(app.enabled("id:send-button")).toBe(false);
  await app.press("id:send-as-stop");
  expect(app.enabled("id:send-button")).toBe(true);
  await app.press("id:send-button");
  await app.waitUntil(() => app.texts().includes("stopped:stop"));
});

test("the microphone shows its state above the box, and a notice goes away", async () => {
  const app = await open();
  expect(app.shows("id:voice-status")).toBe(false);
  await app.press("id:voice-set-recording");
  await app.waitFor("id:voice-status");
  expect(app.texts().some((t) => t.includes("0:05"))).toBe(true);
  await app.press("id:voice-cancel");
  await app.waitFor("id:voice-status", { state: "gone" });
  await app.press("id:voice-set-transcribing");
  await app.waitFor("id:voice-status");
  expect(app.enabled("id:voice-button")).toBe(false);
  await app.press("id:voice-set-notice");
  await app.waitFor("id:voice-notice");
  expect(app.texts()).toContain("没听清");
  await app.press("id:voice-dismiss");
  await app.waitFor("id:voice-notice", { state: "gone" });
});

test("the stop menu lists what can be stopped and hands the pick back", async () => {
  const app = await open();
  await app.press("id:stop-menu");
  await app.waitFor("id:stop-item-global");
  await app.press("id:stop-item-global");
  await app.waitUntil(() => app.texts().includes("stopped:global"));
  await app.waitFor("id:stop-item-global", { state: "gone" });
});

test("the waiting chip says what waits and jumps to the first card", async () => {
  const app = await open();
  await app.waitFor("id:waiting-jump");
  await app.press("id:waiting-jump");
  await app.waitUntil(() => app.texts().includes("jumped:ap1"));
  await app.waitFor("id:waiting-jump", { state: "gone" });
});

test("the scroll-to-bottom button is pressable only while shown", async () => {
  const app = await open();
  expect(app.enabled("id:scroll-bottom")).toBe(false);
  await app.press("id:show-scroll-bottom");
  await app.waitUntil(() => app.enabled("id:scroll-bottom"));
  await app.press("id:scroll-bottom");
  await app.waitUntil(() => !app.enabled("id:scroll-bottom"));
});

test("the command list shows each command and a press picks it", async () => {
  const app = await open();
  await app.waitFor("id:command-menu");
  expect(app.texts()).toContain("/compact");
  expect(app.texts()).toContain("<pr>");
  await app.press("id:command-review");
  await app.waitUntil(() => app.texts().includes("picked:cmd:review"));
});

test("the agent picker cascades: a model with levels opens them, a pick commits", async () => {
  const app = await open();
  await app.press("id:agent-tune");
  await app.waitFor("id:tune-panel");
  await app.press("id:tune-row-model-gpt-5.6");
  await app.waitFor("id:tune-column-effort");
  await app.press("id:tune-row-effort-high");
  await app.waitFor("id:tune-panel", { state: "gone" });
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("picked:") && t.includes("gpt-5.6") && t.includes("high")));
  // A model with no levels is a pick of its own.
  await app.press("id:agent-tune");
  await app.waitFor("id:tune-panel");
  await app.press("id:tune-row-model-gpt-5.6-mini");
  await app.waitFor("id:tune-panel", { state: "gone" });
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("picked:") && t.includes("gpt-5.6-mini")));
});

test("on a phone the picker and the stop menu open as sheets", async () => {
  const app = await openStory("chat-composer", { width: 420, height: 800 });
  await app.waitFor("id:agent-tune", { timeout: 10_000 });
  await app.press("id:agent-tune");
  await app.waitFor("id:tune-sheet");
  await app.press("id:tune-row-model-gpt-5.6-mini");
  await app.waitFor("id:tune-sheet", { state: "gone" });
  await app.press("id:stop-menu");
  await app.waitFor("id:stop-item-bot");
  await app.press("id:stop-item-bot");
  await app.waitUntil(() => app.texts().includes("stopped:bot"));
});
