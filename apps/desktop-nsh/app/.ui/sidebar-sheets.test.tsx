import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;
type Read = { bots: { name: string; runner: string; duties: string }[]; groups: (string | null)[]; projects: { dir: string; agent: string }[] };

async function open(): Promise<App> {
  const app = await openStory("sidebar-sheets");
  await app.waitFor("id:story-read", { timeout: 15_000 });
  return app;
}

/** What the runtime itself says exists (a fresh GET of the snapshot). */
async function read(app: App): Promise<Read> {
  await app.press("id:story-read");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith('{"bots"')));
  return JSON.parse(app.texts().find((t) => t.startsWith('{"bots"'))!) as Read;
}

test("the new-Bot form asks for what is missing, then makes the Bot", async () => {
  const app = await open();
  await app.press("id:story-open-bot");
  await app.waitFor("id:create-bot-sheet");
  for (const text of ["新建 Bot", "从模板", "头像"]) expect(app.texts()).toContain(text);
  // Nothing filled in: every required field says so, and nothing is made.
  await app.press("id:bot-save");
  await app.waitFor("id:bot-name-error");
  expect(app.shows("id:bot-duties-error")).toBe(true);
  expect(app.shows("id:bot-boundaries-error")).toBe(true);
  expect(app.texts()).toContain("填写职责。");
  // Typing clears the errors.
  await app.type("id:bot-name", "Sheeter");
  await app.waitFor("id:bot-name-error", { state: "gone" });
  await app.type("id:bot-duties", "整理表格");
  await app.type("id:bot-boundaries", "不删文件");
  await app.press("id:bot-save");
  await app.waitFor("id:create-bot-sheet", { state: "gone" });
  const made = (await read(app)).bots.find((bot) => bot.name === "Sheeter");
  expect(made?.duties).toBe("整理表格");
});

test("a template fills the fields and marks itself; Close leaves without making anything", async () => {
  const app = await open();
  const before = (await read(app)).bots.length;
  await app.press("id:story-open-bot");
  await app.waitFor("id:bot-templates");
  expect(app.count("id:bot-template-writer") + app.count("id:bot-template-coder")).toBeGreaterThan(0);
  const template = ["writer", "coder", "researcher"].find((id) => app.shows(`id:bot-template-${id}`));
  expect(template).toBeDefined();
  await app.press(`id:bot-template-${template}`);
  await app.waitUntil(() => (app.value("id:bot-name") ?? "") !== "");
  expect(app.value("id:bot-duties")).not.toBe("");
  await app.press("id:bot-cancel");
  await app.waitFor("id:create-bot-sheet", { state: "gone" });
  expect((await read(app)).bots.length).toBe(before);
});

test("the runner picker offers Claude Agent and shows its hint; the model field follows the runner", async () => {
  const app = await open();
  await app.press("id:story-open-bot");
  await app.waitFor("id:bot-runner");
  // The fixture has an endpoint, so a new Bot starts on the app's own loop: a model picker (automatic) and the hint that says so.
  await app.waitFor("id:bot-model");
  expect(app.shows("id:bot-agent-model")).toBe(false);
  await app.waitFor("id:bot-model-hint");
  await app.press("id:bot-runner");
  await app.waitFor("text:Claude Agent（你本机的 Claude Code）");
  await app.press("text:Claude Agent（你本机的 Claude Code）");
  await app.waitFor("id:bot-agent-model");
  expect(app.shows("id:bot-model")).toBe(false);
  expect(app.texts()).toContain("建好后每一轮由你本机安装并登录的 Claude Code 来跑；思考强度多少，在 Bot 面板里选。");
});

test("the new-group form wants a name and two Bots, then makes the group", async () => {
  const app = await open();
  await app.press("id:story-open-group");
  await app.waitFor("id:create-group-sheet");
  expect(app.texts()).toContain("新建群");
  await app.press("id:group-save");
  await app.waitFor("id:group-name-error");
  expect(app.shows("id:group-members-error")).toBe(true);
  expect(app.texts()).toContain("至少挑两个 Bot。");
  await app.type("id:group-name", "表格小组");
  await app.waitFor("id:group-name-error", { state: "gone" });
  // One member is too few.
  await app.press("id:group-members-trigger");
  await app.waitFor("text:Writer");
  await app.press("text:Writer");
  await app.press("id:group-save");
  await app.waitFor("id:group-members-error");
  await app.press("id:group-members-trigger");
  await app.waitFor("text:Editor");
  await app.press("text:Editor");
  await app.waitFor("id:group-members-error", { state: "gone" });
  await app.press("id:group-save");
  await app.waitFor("id:create-group-sheet", { state: "gone" });
  expect((await read(app)).groups).toContain("表格小组");
});

test("on a phone each sheet is a page with a way back", async () => {
  const app = await open();
  await app.setViewport(600, 900);
  await app.press("id:story-open-group");
  await app.waitFor("id:modal-back");
  expect(app.shows("id:modal-close")).toBe(false);
  await app.press("id:modal-back");
  await app.waitFor("id:create-group-sheet", { state: "gone" });
  await app.press("id:story-open-bot");
  await app.waitFor("id:modal-back");
  await app.press("id:modal-back");
  await app.waitFor("id:create-bot-sheet", { state: "gone" });
});

test("Escape closes an open sheet", async () => {
  const app = await open();
  await app.press("id:story-open-group");
  await app.waitFor("id:create-group-sheet");
  await app.keyboard.press("escape");
  await app.waitFor("id:create-group-sheet", { state: "gone" });
  await app.waitUntil(() => app.texts().includes("open:"));
});
