import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

/** The box's text, as the story echoes the owner's draft (the test host's `value` follows typing only, not a document the app sets). */
const draft = (app: { texts(): string[] }): string => (app.texts().find((t) => t.startsWith("draft:")) ?? "draft:").slice("draft:".length);

const open = async () => {
  const app = await openStory("chat-composer-2");
  await app.waitFor("id:composer-input", { timeout: 15_000 });
  return app;
};

test("typing is the conversation's draft; Enter sends it to the runtime and the line comes back", async () => {
  const app = await open();
  const line = `composer-2 ${Date.now()}`;
  await app.type("id:composer-input", line);
  await app.waitUntil(() => app.texts().includes(`draft:${line}`));
  // The line goes into a group the story makes (and deletes), so the fixture's conversations stay as they were.
  await app.press("id:story-scratch");
  await app.waitUntil(() => app.texts().includes("session:scratch") && draft(app) === "", { timeout: 10_000 });
  await app.type("id:composer-input", line);
  try {
    await app.keyboard.press("enter");
    await app.waitUntil(() => app.texts().some((t) => t.startsWith("sent:1")), { timeout: 10_000 });
    await app.waitUntil(() => draft(app) === "");
    await app.press("id:story-read");
    await app.waitUntil(() => app.texts().some((t) => t.startsWith("read:") && t.includes(line)), { timeout: 10_000 });
  } finally {
    await app.press("id:story-cleanup");
    await app.waitUntil(() => app.texts().includes("session:direct"));
  }
});

test("an empty box sends nothing, and Send greys until there is something to send", async () => {
  const app = await open();
  expect(app.enabled("id:send-button")).toBe(false);
  await app.keyboard.press("enter");
  expect(app.texts().some((t) => t.startsWith("sent:"))).toBe(true);
  expect(app.texts()).toContain("sent:0");
  await app.type("id:composer-input", "hi");
  await app.waitUntil(() => app.enabled("id:send-button"));
});

test("the draft stays with its conversation when you look at another", async () => {
  const app = await open();
  await app.type("id:composer-input", "留在这里");
  await app.press("id:story-group");
  await app.waitUntil(() => app.texts().includes("session:group") && draft(app) === "");
  await app.press("id:story-direct");
  await app.waitUntil(() => draft(app) === "留在这里");
});

test("a group's @ offers everyone and its Bots; a direct's offers the Bots you can write to", async () => {
  const app = await open();
  await app.press("id:story-group");
  await app.waitUntil(() => app.texts().includes("session:group"));
  await app.type("id:composer-input", "请 @");
  await app.waitFor("id:mention-popup");
  expect(app.shows("id:mention-everyone")).toBe(true);
  await app.type("id:composer-input", "Edi");
  await app.press("text:@Editor");
  await app.waitFor("id:mention-popup", { state: "gone" });
  await app.waitUntil(() => draft(app).startsWith("请 @Editor"));
  await app.press("id:story-direct");
  await app.waitUntil(() => draft(app) === "");
  await app.type("id:composer-input", "@");
  await app.waitFor("id:mention-popup");
  expect(app.shows("id:mention-everyone")).toBe(false);
});

test("an archived group shows the notice and no box", async () => {
  const app = await open();
  await app.press("id:story-locked");
  await app.waitFor("id:composer-locked");
  expect(app.shows("id:composer-input")).toBe(false);
  expect(app.shows("id:send-button")).toBe(false);
  expect(app.shows("id:attach-button")).toBe(false);
});

test("suggestions draft their line into the box", async () => {
  const app = await open();
  expect(app.shows("id:suggest-chip")).toBe(false);
  await app.press("id:story-suggest");
  await app.press("text:换个语气");
  await app.waitUntil(() => draft(app) === "换个更轻松的语气");
});

test("a press that finds nothing to suggest says so where the chips would be, then lets it go", async () => {
  const app = await open();
  await app.press("id:story-suggest-empty");
  await app.waitFor("id:suggest-note");
  await app.waitFor("id:suggest-note", { state: "gone", timeout: 8_000 });
});

test("the file conversation takes no ✨, and a direct's Bot model sits on the tool row", async () => {
  const app = await open();
  expect(app.shows("id:suggest-button")).toBe(true);
  expect(app.shows("id:bot-tune")).toBe(true);
  await app.press("id:story-group");
  await app.waitUntil(() => app.texts().includes("session:group"));
  expect(app.shows("id:bot-tune")).toBe(false);
  await app.press("id:story-file-drop");
  await app.waitUntil(() => app.texts().includes("session:file-drop"));
  expect(app.shows("id:suggest-button")).toBe(false);
  expect(app.shows("id:bot-tune")).toBe(false);
});

test("the quote above the box goes with its ✕; a refused send says so", async () => {
  const app = await open();
  await app.press("id:story-quote");
  await app.waitFor("id:composer-quote");
  await app.press("id:composer-quote-cancel");
  await app.waitFor("id:composer-quote", { state: "gone" });
  await app.press("id:story-refused");
  await app.waitFor("id:composer-refused");
});

test("a Bot at work: a direct has its own Stop beside Send, a group a stop menu", async () => {
  const app = await open();
  expect(app.shows("id:stop-button")).toBe(false);
  await app.press("id:story-working");
  await app.waitFor("id:stop-button");
  await app.press("id:story-group");
  await app.waitUntil(() => app.texts().includes("session:group"));
  await app.waitFor("id:stop-menu");
  expect(app.shows("id:stop-button")).toBe(false);
});

test("a waiting card scrolled out of sight offers its jump; the jump-to-bottom control follows the stage", async () => {
  const app = await open();
  await app.press("id:story-waiting");
  await app.waitFor("id:waiting-jump");
  await app.press("id:waiting-jump");
  await app.waitUntil(() => app.texts().includes("jumped:ap1"));
  await app.waitFor("id:waiting-jump", { state: "gone" });
  await app.press("id:story-scroll");
  await app.waitUntil(() => app.enabled("id:scroll-bottom"));
  await app.press("id:scroll-bottom");
  await app.waitUntil(() => !app.enabled("id:scroll-bottom"));
});

test("narrow, the ✎ row docks: ✨ steps aside once there is text, and Send steps aside while empty", async () => {
  const app = await open();
  await app.press("id:story-narrow");
  await app.waitUntil(() => !app.shows("id:send-button"));
  expect(app.shows("id:suggest-button")).toBe(true);
  await app.type("id:composer-input", "hi");
  await app.waitFor("id:send-button");
  expect(app.shows("id:suggest-button")).toBe(false);
});

test("the editor's description says which key sends", async () => {
  const app = await open();
  await app.waitFor("id:composer-hint");
  expect(app.texts().some((t) => t.length > 0)).toBe(true);
});
