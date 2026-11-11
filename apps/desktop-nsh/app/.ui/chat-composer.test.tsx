import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

/** The box's text, as the story echoes the owner's draft (the test host's `value` follows typing only, not a document the app sets). */
const draft = (app: { texts(): string[] }): string => (app.texts().find((t) => t.startsWith("draft:")) ?? "draft:").slice("draft:".length);

const open = async () => {
  const app = await openStory("chat-composer");
  await app.waitFor("id:composer-input", { timeout: 10_000 });
  return app;
};

test("Enter sends the draft and clears the box; an empty one sends nothing", async () => {
  const app = await open();
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("sent:0");
  await app.type("id:composer-input", "你好");
  await app.waitUntil(() => app.texts().includes("draft:你好"));
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().includes("sent:1"));
  await app.waitUntil(() => draft(app) === "");
});

test("a locked box takes nothing", async () => {
  const app = await open();
  await app.press("id:toggle-editable");
  await app.type("id:composer-input", "locked").catch(() => undefined);
  await app.keyboard.press("enter");
  expect(draft(app)).toBe("");
  await app.press("id:toggle-editable");
  await app.type("id:composer-input", "open");
  await app.waitUntil(() => draft(app) === "open");
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
  await app.waitUntil(() => draft(app).startsWith("请 @Editor"));
});

const chipsOf = async (app: Awaited<ReturnType<typeof open>>): Promise<string> => {
  await app.press("id:read-chips");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("chips:") && t !== "chips:—"));
  return (app.texts().find((t) => t.startsWith("chips:")) ?? "").slice("chips:".length);
};

/** A mention picked from the list: `请 @Editor ` with Editor as one chip. */
const pickEditor = async (app: Awaited<ReturnType<typeof open>>) => {
  await app.type("id:composer-input", "请 @");
  await app.waitFor("id:mention-popup");
  await app.type("id:composer-input", "Edi");
  await app.press("id:mention-bot-editor");
  await app.waitFor("id:mention-popup", { state: "gone" });
  await app.waitUntil(() => draft(app) === "请 @Editor ");
};

test("a picked mention is one chip carrying the member's id, not the typed @Edi", async () => {
  const app = await open();
  await pickEditor(app);
  expect(await chipsOf(app)).toBe("bot-editor=Editor");
});

test("Backspace takes a chip away whole, with the space after it; text before it stays", async () => {
  const app = await open();
  await pickEditor(app);
  await app.keyboard.press("backspace");
  await app.waitUntil(() => draft(app) === "请 ");
  expect(await chipsOf(app)).toBe("none");
  // Plain text still goes one character at a time.
  await app.keyboard.press("backspace");
  await app.waitUntil(() => draft(app) === "请");
});

test("the sent text carries the mention as @Name, as the messenger sends it", async () => {
  const app = await open();
  await pickEditor(app);
  await app.type("id:composer-input", "看看");
  await app.waitUntil(() => draft(app) === "请 @Editor 看看");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().includes("sent:1"));
  expect(app.texts()).toContain("last:请 @Editor 看看");
  await app.waitUntil(() => draft(app) === "");
});

test("the @ list's keys: arrows move, Enter and Tab choose, and nothing is sent by the pick", async () => {
  const app = await open();
  await app.type("id:composer-input", "@");
  await app.waitFor("id:mention-popup");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("id:mention-popup", { state: "gone" });
  await app.waitUntil(() => draft(app) === "@Writer ");
  expect(app.texts()).toContain("sent:0");
  await app.type("id:composer-input", "a");
  await app.waitUntil(() => draft(app) === "@Writer a", { timeout: 3000 });
  await app.type("id:composer-input", " @");
  await app.waitFor("id:mention-popup");
  await app.keyboard.press("tab");
  await app.waitUntil(() => draft(app) === "@Writer a @everyone ");
  expect(app.texts()).toContain("sent:0");
});

test("a suggestion drafts its line into the box", async () => {
  const app = await open();
  await app.press("text:换个语气");
  await app.waitUntil(() => draft(app) === "换个更轻松的语气");
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
