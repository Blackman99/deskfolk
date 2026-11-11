/** The message menu (desktop and phone), the text page and the file overlay's frame. */
import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const logged = (app: { texts(): string[] }) => app.texts().find((line) => line.includes("menu-closed") || line.includes("copy") || line.includes("react") || line.includes("tree") || line.includes("reply") || line.includes("trace") || line.includes("edit")) ?? "";

test("the message menu offers its entries; each does its work and closes the menu", async () => {
  const app = await openStory("chat-media");
  await app.waitFor("id:open-menu", { timeout: 10_000 });
  await app.press("id:open-menu");
  await app.waitFor("id:msg-context-menu");
  // Quick reactions, reply, copy, the files the message names, the flow, copy id; no edit, no select-text.
  expect(app.count("id:msg-reaction")).toBe(5);
  expect(app.shows("id:msg-context-reply")).toBe(true);
  expect(app.shows("id:msg-context-trace")).toBe(true);
  expect(app.shows("id:msg-context-edit")).toBe(false);
  expect(app.shows("id:msg-context-select-text")).toBe(false);
  expect(app.count("id:msg-context-subitem")).toBeGreaterThan(1);
  await app.press("id:msg-context-reply");
  await app.waitFor("id:msg-context-menu", { state: "gone" });
  expect(logged(app)).toContain("reply");
  await app.press("id:open-menu");
  await app.press("id:msg-context-copy");
  await app.waitFor("id:msg-context-menu", { state: "gone" });
  expect(logged(app)).toContain("copy:周报在");
  expect(app.clipboard()).toContain("notes/plan.md");
  await app.press("id:open-menu");
  await app.press("id:msg-context-copy-id");
  await app.waitFor("id:msg-context-menu", { state: "gone" });
  expect(logged(app)).toContain("copy-id");
});

test("a reaction is sent and closes the menu; a file in the list opens the tree at it", async () => {
  const app = await openStory("chat-media");
  await app.press("id:open-menu");
  await app.press("text:🚀");
  await app.waitFor("id:msg-context-menu", { state: "gone" });
  expect(logged(app)).toContain("react:🚀");
  await app.press("id:open-menu");
  await app.press("text:docs/review.md");
  await app.waitFor("id:msg-context-menu", { state: "gone" });
  expect(logged(app)).toContain("tree:docs/review.md");
});

test("a line of yours that can be changed has an Edit entry; Escape closes the menu", async () => {
  const app = await openStory("chat-media");
  await app.press("id:open-menu-edit");
  await app.waitFor("id:msg-context-edit");
  await app.press("id:msg-context-edit");
  await app.waitFor("id:msg-context-menu", { state: "gone" });
  expect(logged(app)).toContain("edit");
  await app.press("id:open-menu");
  await app.waitFor("id:msg-context-menu");
  await app.keyboard.press("escape");
  await app.waitFor("id:msg-context-menu", { state: "gone" });
});

test("opened by a touch the menu is a sheet, with select-text", async () => {
  const app = await openStory("chat-media", { width: 600 });
  await app.waitFor("id:open-menu-sheet", { timeout: 10_000 });
  await app.press("id:open-menu-sheet");
  await app.waitFor("id:msg-context-select-text");
  expect(app.count("id:msg-reaction")).toBe(5);
  await app.press("id:msg-context-select-text");
  await app.waitFor("id:msg-context-menu", { state: "gone" });
  expect(logged(app)).toContain("select-text");
});

test("the text page names itself, hints, shows the text and closes by ✕ and Escape", async () => {
  const app = await openStory("chat-media");
  await app.press("id:open-text");
  await app.waitFor("id:message-text-sheet");
  await app.waitFor("id:message-text-hint");
  expect(app.shows("id:sheet-text")).toBe(true);
  await app.press("id:modal-close");
  await app.waitFor("id:message-text-sheet", { state: "gone" });
  await app.press("id:open-text");
  await app.waitFor("id:message-text-sheet");
  await app.keyboard.press("escape");
  await app.waitFor("id:message-text-sheet", { state: "gone" });
});

test("on a phone the text page is the whole page with a back chevron", async () => {
  const app = await openStory("chat-media", { width: 600 });
  await app.press("id:open-text");
  await app.waitFor("id:modal-back");
  expect(app.texts()).toContain("Writer · 10:42");
  expect(app.shows("id:modal-close")).toBe(false);
  await app.press("id:modal-back");
  await app.waitFor("id:message-text-sheet", { state: "gone" });
});

test("a file opens in its frame, named, and closes by ✕ and Escape", async () => {
  const app = await openStory("chat-media");
  await app.press("id:open-file");
  await app.waitFor("id:msg-file-frame");
  expect(app.texts()).toContain("plan.md");
  expect(app.texts()).toContain("preview:notes/plan.md");
  await app.press("id:msg-file-close");
  await app.waitFor("id:msg-file-frame", { state: "gone" });
  await app.press("id:open-file");
  await app.waitFor("id:msg-file-frame");
  await app.keyboard.press("escape");
  await app.waitFor("id:msg-file-frame", { state: "gone" });
});

test("on a phone the file frame is the whole window without its head", async () => {
  const app = await openStory("chat-media", { width: 600 });
  await app.press("id:open-file");
  await app.waitFor("id:msg-file-frame");
  expect(app.shows("id:msg-file-close")).toBe(false);
  await app.keyboard.press("escape");
  await app.waitFor("id:msg-file-frame", { state: "gone" });
});
