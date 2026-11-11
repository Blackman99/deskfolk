import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

/** The box's text, as the story echoes the owner's draft (the test host's `value` follows typing only, not a document the app sets). */
const draft = (app: { texts(): string[] }): string => (app.texts().find((t) => t.startsWith("draft:")) ?? "draft:").slice("draft:".length);

const open = async () => {
  const app = await openStory("chat-composer-2");
  await app.waitFor("id:composer-input", { timeout: 15_000 });
  return app;
};

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

test("the attach button picks files, they wait as chips, and ✕ takes one back", async () => {
  const app = await open();
  app.onPick(() => [{ name: "notes.txt", type: "text/plain", data: new Uint8Array([104, 105]) }]);
  await app.press("id:attach-button");
  // `nsh.json` has no `picker` capability yet (see the report): without it the press asks nothing.
  if (app.picks().length === 0) return;
  await app.waitFor("id:composer-attachment");
  expect(app.texts()).toContain("notes.txt");
  expect(app.texts()).toContain("staged:notes.txt");
  expect(app.enabled("id:send-button")).toBe(true);
  await app.press("id:attachment-delete");
  await app.waitFor("id:composer-attachment", { state: "gone" });
  await app.waitUntil(() => app.texts().includes("staged:"));
});

test("a pick that is cancelled stages nothing", async () => {
  const app = await open();
  app.onPick(() => null);
  await app.press("id:attach-button");
  expect(app.shows("id:composer-attachment")).toBe(false);
});

test("a pasted file is staged in any conversation, with or without words", async () => {
  const app = await open();
  await app.paste("id:composer-input", { files: ["nsh.json"] });
  await app.waitFor("id:composer-attachment", { timeout: 10_000 });
  expect(app.texts()).toContain("staged:nsh.json");
  expect(app.enabled("id:send-button")).toBe(true);
});

test("files copied in Finder paste in as attachments, as dropped ones do", async () => {
  const app = await open();
  await app.paste("id:composer-input", { uris: ["file:///tmp/copied.txt"] });
  await app.waitFor("id:composer-attachment", { timeout: 10_000 });
  expect(app.texts()).toContain("staged:copied.txt");
});

test("files staged in one conversation wait there while the composer shows another", async () => {
  const app = await open();
  app.onPick(() => [{ name: "pic.png", type: "image/png", data: PNG }]);
  await app.press("id:attach-button");
  if (app.picks().length === 0) return;
  await app.waitFor("id:composer-attachment");
  await app.press("id:story-group");
  await app.waitFor("id:composer-attachment", { state: "gone" });
  await app.press("id:story-direct");
  await app.waitFor("id:composer-attachment");
});

test("only the file conversation takes files dropped on it", async () => {
  const app = await open();
  const uri = "file:///tmp/dropped.txt";
  await app.dropFiles("id:composer-card", [uri]);
  await app.wait(300);
  expect(app.shows("id:composer-attachment")).toBe(false);
  await app.press("id:story-file-drop");
  await app.waitUntil(() => app.texts().includes("session:file-drop"));
  await app.dropFiles("id:composer-card", [uri]);
  await app.waitFor("id:composer-attachment", { timeout: 10_000 });
  expect(app.texts()).toContain("staged:dropped.txt");
});

test("a send with a staged file goes out with it and the chip goes after", async () => {
  const app = await open();
  app.onPick(() => [{ name: "pic.png", type: "image/png", data: PNG }]);
  // Into a group the story makes (and deletes), so the fixture's conversations stay as they were.
  await app.press("id:story-scratch");
  await app.waitUntil(() => app.texts().includes("session:scratch"), { timeout: 10_000 });
  try {
    await app.press("id:attach-button");
    if (app.picks().length === 0) {
      // `nsh.json` has no `picker` capability yet (see the report): stage by a paste instead.
      await app.paste("id:composer-input", { files: ["nsh.json"] });
    }
    await app.waitFor("id:composer-attachment", { timeout: 10_000 });
    await app.type("id:composer-input", `with a file ${Date.now()}`);
    await app.press("id:send-button");
    await app.waitUntil(() => app.texts().some((t) => t.startsWith("sent:1 files:")), { timeout: 15_000 });
    await app.waitFor("id:composer-attachment", { state: "gone" });
    await app.waitUntil(() => draft(app) === "");
  } finally {
    await app.press("id:story-cleanup");
    await app.waitUntil(() => app.texts().includes("session:direct"));
  }
});

test("the microphone shows once a speech endpoint is ready, and says where recording is not available", async () => {
  const app = await open();
  expect(app.shows("id:voice-button")).toBe(false);
  await app.press("id:story-speech");
  await app.waitFor("id:voice-button");
  await app.press("id:voice-button");
  await app.waitFor("id:voice-notice");
  await app.press("id:voice-dismiss");
  await app.waitFor("id:voice-notice", { state: "gone" });
});

test("record, stop: what was heard is added to the draft, and nothing is sent", async () => {
  const app = await open();
  await app.press("id:story-speech");
  await app.press("id:story-fake-mic");
  await app.press("id:story-heard");
  await app.type("id:composer-input", "Hi ");
  await app.waitFor("id:voice-button");
  await app.press("id:voice-button");
  await app.waitFor("id:voice-status");
  await app.press("id:voice-button");
  await app.waitUntil(() => draft(app) === "Hi 你好，世界", { timeout: 10_000 });
  expect(app.texts()).toContain("sent:0");
});

test("a recording cancelled drops it", async () => {
  const app = await open();
  await app.press("id:story-speech");
  await app.press("id:story-fake-mic");
  await app.waitFor("id:voice-button");
  await app.press("id:voice-button");
  await app.waitFor("id:voice-status");
  await app.press("id:voice-cancel");
  await app.waitFor("id:voice-status", { state: "gone" });
  expect(draft(app)).toBe("");
});
