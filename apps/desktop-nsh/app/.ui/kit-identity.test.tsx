import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const open = async () => {
  const app = await openStory("kit-identity");
  await app.waitFor("id:folk-avatar", { timeout: 10_000 });
  return app;
};

test("a folk avatar, a Bot's own picture and the brand mark render", async () => {
  const app = await open();
  await app.waitFor("id:session-folk");
  await app.waitFor("id:session-bot");
  await app.waitFor("id:brand-mark");
  // A Bot with no picture shows its letter.
  expect(app.texts()).toContain("C");
  // A group past four shows how many more.
  expect(app.texts()).toContain("+3");
});

test("the model picker opens, lists the chosen source's models and reports a choice", async () => {
  const app = await open();
  await app.press("id:model-picker");
  await app.waitFor("id:model-picker-panel");
  // Sources on the left, the first usable one's models on the right, the rows that are not models on top.
  for (const text of ["My CPA", "Codex", "OpenCode", "my-agent", "ZCode", "跟随默认", "gemini-3.8", "grok-4.7"]) expect(app.texts()).toContain(text);
  // Pointing at another source shows its models.
  await app.press("id:model-source-agent:codex");
  await app.waitFor("id:model-row-codex:gpt-5.6-terra");
  expect(app.texts()).toContain("GPT-5.6-Terra");
  await app.press("id:model-row-codex:gpt-5.6-terra");
  await app.waitFor("text:picked: codex:gpt-5.6-terra");
  await app.waitFor("id:model-picker-panel", { state: "gone" });
  // Closed, the field shows the model and where it comes from.
  expect(app.texts().some((text) => text.includes("GPT-5.6-Terra"))).toBe(true);
});

test("a search looks through every source, and a source that takes typed names offers the one typed", async () => {
  const app = await open();
  await app.press("id:model-picker");
  await app.waitFor("id:model-picker-search");
  await app.type("id:model-picker-search", "grok");
  await app.waitFor("id:model-results");
  expect(app.texts()).toContain("grok-4.7");
  expect(app.texts()).not.toContain("gemini-3.8");
  await app.type("id:model-picker-search", "zzz");
  await app.waitFor("text:没有匹配的模型");
});

test("the arrow keys walk the rows and Enter picks", async () => {
  const app = await open();
  await app.press("id:model-picker");
  await app.waitFor("id:model-picker-search");
  // The cursor starts on the first row (the follow-default one); Down moves to the source's first model.
  await app.keyboard.press("down");
  // A return typed into the search is Enter (the headless keyboard sends a bare Enter to no input).
  await app.type("id:model-picker-search", "\n");
  await app.waitFor("text:picked: gemini-3.8");
});

test("a source that lists no models takes the name typed, and Escape clears the search before it closes", async () => {
  const app = await open();
  await app.press("id:model-picker");
  await app.waitFor("id:model-picker-search");
  await app.press("id:model-source-agent:custom:ca-1");
  await app.waitFor("text:它没列出模型\n在上面输入它认的模型名");
  await app.type("id:model-picker-search", "my-model");
  await app.waitFor("id:model-row-custom:ca-1:my-model");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.value("id:model-picker-search") === "");
  expect(app.shows("id:model-picker-panel")).toBe(true);
  // A second Escape closes it.
  await app.keyboard.press("escape");
  await app.waitFor("id:model-picker-panel", { state: "gone" });
  await app.press("id:model-picker");
  await app.waitFor("id:model-picker-search");
  await app.press("id:model-source-agent:custom:ca-1");
  await app.type("id:model-picker-search", "my-model");
  await app.press("id:model-row-custom:ca-1:my-model");
  await app.waitFor("text:picked: custom:ca-1:my-model");
});

test("on a phone the picker is a sheet, one level at a time, Back going up", async () => {
  const app = await openStory("kit-identity", { width: 500, height: 800 });
  await app.waitFor("id:folk-avatar", { timeout: 10_000 });
  await app.press("id:model-picker");
  await app.waitFor("id:model-picker-sheet");
  await app.waitFor("id:model-source-nav-agent:opencode");
  expect(app.shows("id:model-picker-panel")).toBe(false);
  // OpenCode lists 40: its providers are a level of their own.
  await app.press("id:model-source-nav-agent:opencode");
  await app.waitFor("id:model-group-nav-nvidia");
  await app.press("id:model-group-nav-nvidia");
  await app.waitFor("id:model-row-nvidia/model-1");
  await app.press("id:model-sheet-back");
  await app.waitFor("id:model-group-nav-nvidia");
  await app.press("id:model-sheet-back");
  await app.waitFor("id:model-source-nav-agent:codex");
  await app.press("id:model-source-nav-agent:codex");
  await app.press("id:model-row-codex:gpt-5.6-terra");
  await app.waitFor("text:picked: codex:gpt-5.6-terra");
  await app.waitFor("id:model-picker-sheet", { state: "gone" });
});

test("the avatar editor draws a generated avatar and Randomize changes it", async () => {
  const app = await open();
  await app.waitFor("id:avatar-editor-randomize");
  const stamp = () => app.texts().find((text) => /^\d+:-?\d+$/.test(text));
  await app.waitUntil(() => stamp() !== undefined && !stamp()!.startsWith("0:"));
  const first = stamp();
  await app.press("id:avatar-editor-randomize");
  await app.waitUntil(() => stamp() !== first);
  // Another style keeps drawing a generated avatar, so the picture stays the editor's own.
  await app.press("id:avatar-variant-beam");
  await app.waitFor("id:avatar-editor-img");
});
