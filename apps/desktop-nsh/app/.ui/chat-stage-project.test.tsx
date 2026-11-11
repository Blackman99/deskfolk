/** A project session's body (`ProjectChat`) and a Bot↔Bot direct in its popup (`BotDmDialog`). */
import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { openStory } from "./fixture";

const t = copyFor("zh");
const said = (app: any): string => app.texts().find((x: string) => /^(sent:|tune:|answer:|stop|profile:|artifact:|annotation:|create-bot|cleaned|—)/.test(x)) ?? "";

async function project() {
  const app = await openStory("chat-stage");
  await app.waitFor("id:show-project", { timeout: 15_000 });
  await app.press("id:show-project");
  await app.waitFor("id:project-chat", { timeout: 15_000 });
  return app;
}

test("a project session shows its lines, the day, and a Bot's reply drawn as Markdown", async () => {
  const app = await project();
  await app.waitFor("text:把 README 的安装一节改短", { timeout: 10_000 });
  expect(app.texts()).toContain("再看一下测试");
  expect(app.texts()).toContain("已切到新的一天");
  expect(app.texts()).toContain("安装一节有 三段");
  expect(app.shows("id:project-input")).toBe(true);
  expect(app.shows("id:project-working")).toBe(false);
});

test("a line typed in the box goes to the daemon's send and joins the lines", async () => {
  const app = await project();
  await app.type("id:project-input", "再跑一遍");
  await app.submit("id:project-input");
  await app.waitUntil(() => app.texts().includes("sent:再跑一遍"), { timeout: 10_000 });
  await app.waitFor("text:再跑一遍", { timeout: 5_000 });
  expect(app.value("id:project-input")).toBe("");
});

test("a run in flight is a working bubble; an approval waiting is answered from its card", async () => {
  const app = await project();
  await app.press("id:story-run");
  await app.waitFor("id:project-working", { timeout: 10_000 });
  expect(app.texts()).toContain("我先跑一遍测试，看哪些用例挂了");
  await app.press("id:story-approval");
  await app.waitFor("id:project-approval", { timeout: 10_000 });
  expect(app.texts().some((x: string) => x.includes("rm -rf dist"))).toBe(true);
  await app.press("id:project-allow");
  await app.waitUntil(() => said(app) === "answer:allow", { timeout: 10_000 });
  await app.waitUntil(() => !app.shows("id:project-approval"));
});

test("the plan switch in the box tunes the session's mode", async () => {
  const app = await project();
  expect(app.texts()).toContain("plan-mode:off");
  await app.press("id:project-plan");
  await app.waitUntil(() => app.texts().includes("plan-mode:on"), { timeout: 10_000 });
  await app.press("id:project-plan");
  await app.waitUntil(() => app.texts().includes("plan-mode:off"), { timeout: 10_000 });
});

test("a batch of annotations sent in a project session shows as cards under your line: they open the file, and you mark them handled", async () => {
  const app = await project();
  await app.press("id:story-annotated");
  await app.waitFor("text:按这两条改", { timeout: 10_000 });
  await app.waitFor("id:annotation-card-pa-1", { timeout: 10_000 });
  expect(app.shows("id:annotation-card-pa-2")).toBe(true);
  expect(app.texts()).toContain("这里改成 let");
  await app.press("id:annotation-card-pa-1 >> id:annotation-toggle");
  await app.waitUntil(() => said(app) === "annotation:pa-1:resolved", { timeout: 10_000 });
  await app.press("id:annotation-card-pa-2 >> id:annotation-card-open");
  await app.waitUntil(() => said(app) === "artifact:/Users/dev/my-projects/real-bot/src/a.ts", { timeout: 10_000 });
});

test("a Bot↔Bot direct opens in a popup with its lines and delegation records, and closes", async () => {
  const app = await openStory("chat-stage");
  await app.waitFor("id:show-popup", { timeout: 15_000 });
  await app.press("id:show-popup");
  await app.waitFor("id:bot-dm-dialog", { timeout: 10_000 });
  await app.waitFor("text:Editor，帮我看一下这份周报的措辞。", { timeout: 10_000 });
  expect(app.texts()).toContain("看完了：第二段太长，建议拆成两条。");
  await app.waitFor("id:delegation-records", { timeout: 10_000 });
  expect(app.texts().some((x: string) => x.includes("审一下周报的措辞"))).toBe(true);
  // A read-only exchange: the box says so, and the line it came from is named in the strip.
  expect(app.texts()).toContain("Bot↔Bot 私聊只读：你不是参与者，只能看");
  expect(app.texts()).toContain(t.sidebar.botBotSource("Writer"));
  await app.press("id:modal-close");
  await app.waitUntil(() => !app.shows("id:bot-dm-dialog"), { timeout: 5_000 });
});
