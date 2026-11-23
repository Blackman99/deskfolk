/** A project session's body (`ProjectChat`) and a Bot↔Bot direct in its popup (`BotDmDialog`). */
import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { openStory } from "./fixture";

const t = copyFor("zh");
const said = (app: any): string => app.texts().find((x: string) => /^(sent:|tune:|answer:|ask:|stop|profile:|artifact:|annotation:|create-bot|cleaned|—)/.test(x)) ?? "";

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

test("files from Finder, dropped anywhere on the conversation or copied and pasted, wait in the box", async () => {
  const app = await project();
  await app.dropFiles("id:project-chat", ["file:///tmp/data.csv"]);
  await app.waitFor("id:composer-attachment", { timeout: 10_000 });
  expect(app.texts()).toContain("data.csv");
  await app.paste("id:project-input", { uris: ["file:///tmp/spec.docx"] });
  await app.waitUntil(() => app.texts().includes("spec.docx"), { timeout: 10_000 });
});

test("a line typed in the box goes to the daemon's send and joins the lines", async () => {
  const app = await project();
  await app.type("id:project-input", "再跑一遍");
  await app.submit("id:project-input");
  await app.waitUntil(() => app.texts().includes("sent:再跑一遍"), { timeout: 10_000 });
  await app.waitFor("text:再跑一遍", { timeout: 5_000 });
  expect(app.value("id:project-input")).toBe("");
});

test("a / opens the agent's commands, and a command with choices goes on to them", async () => {
  const app = await project();
  // The list comes from the session's store a moment later, as it does from the daemon.
  await app.type("id:project-input", "/");
  await app.waitFor("id:command-compact", { timeout: 10_000 });
  expect(app.shows("id:command-advisor")).toBe(true);
  // A command whose hint names choices is filled in, and its choices follow.
  await app.press("id:command-advisor");
  await app.waitFor("id:command-choice-opus", { timeout: 5_000 });
  // The box reads back only what was typed; the line a pick writes is on screen.
  await app.waitUntil(() => app.texts().includes("/advisor "));
  for (const option of ["fable", "sonnet", "off"]) expect(app.shows(`id:command-choice-${option}`)).toBe(true);
  // Typing narrows them by their start; a pick takes the typed word's place and the list goes.
  await app.type("id:project-input", "o");
  await app.waitUntil(() => !app.shows("id:command-choice-fable"));
  expect(app.shows("id:command-choice-off")).toBe(true);
  await app.press("id:command-choice-off");
  await app.waitFor("id:command-choices", { state: "gone" });
  await app.waitUntil(() => app.texts().includes("/advisor off"));
  await app.submit("id:project-input");
  await app.waitUntil(() => said(app) === "sent:/advisor off", { timeout: 10_000 });
});

test("Enter on a command with choices fills it in; an argument no choice starts with goes as typed", async () => {
  const app = await project();
  await app.type("id:project-input", "/fa");
  await app.waitFor("id:command-fast", { timeout: 10_000 });
  await app.keyboard.press("enter");
  await app.waitFor("id:command-choice-on", { timeout: 5_000 });
  await app.waitUntil(() => app.texts().includes("/fast "));
  // Nothing is picked until you move or type: Enter sends the bare command.
  await app.keyboard.press("enter");
  await app.waitUntil(() => said(app).startsWith("sent:/fast"), { timeout: 10_000 });
  await app.type("id:project-input", "/review 12");
  await app.wait(400);
  expect(app.shows("id:command-choices")).toBe(false);
  expect(app.shows("id:command-menu")).toBe(false);
  await app.submit("id:project-input");
  await app.waitUntil(() => said(app) === "sent:/review 12", { timeout: 10_000 });
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

test("the working bubble's subagent card holds its subagents only, and a chip's dot goes when its subagent ends", async () => {
  const app = await project();
  await app.press("id:story-run");
  await app.waitFor("id:project-working >> id:subagent-entry", { timeout: 10_000 });
  expect(app.shows("id:project-working >> id:subagent-sub-a")).toBe(true);
  expect(app.shows("id:project-working >> id:subagent-sub-b")).toBe(true);
  // The run's own commands are not subagents: no chip opens one as a subagent with no record.
  expect(app.shows("id:subagent-cmd-a")).toBe(false);
  expect(app.shows("id:subagent-cmd-b")).toBe(false);
  expect(app.shows("id:subagent-sub-a >> id:subagent-live")).toBe(true);
  await app.press("id:story-subagent-done");
  await app.waitUntil(() => !app.shows("id:subagent-sub-a >> id:subagent-live"), { timeout: 5_000 });
  expect(app.shows("id:subagent-sub-b >> id:subagent-live")).toBe(true);
});

test("a consultant's task wears its agent's logo and model, the card says it consulted, and it opens in the subagent popup (ADR 0116)", async () => {
  const app = await project();
  await app.press("id:story-run");
  await app.waitFor("id:project-working >> id:subagent-entry", { timeout: 10_000 });
  await app.press("id:story-consult");
  await app.waitFor("id:subagent-consult_c-1", { timeout: 10_000 });
  expect(app.shows("id:subagent-consult_c-1 >> id:agent-logo-codex")).toBe(true);
  expect(app.shows("id:subagent-sub-a >> id:agent-logo-codex")).toBe(false);
  expect(app.shows("id:subagent-model-consult_c-1")).toBe(true);
  expect(app.texts()).toContain("gpt-5.6-terra");
  // A card of a consultant among ordinary subagents keeps the subagent heading.
  expect(app.texts()).toContain(t.project.subagentsOpened);
  expect(app.texts()).not.toContain(t.project.consultedOpened);
  await app.press("id:subagent-consult_c-1");
  await app.waitFor("id:subagent-facts", { timeout: 10_000 });
  await app.waitUntil(() => app.texts().includes("Codex · gpt-5.6-terra"), { timeout: 10_000 });
});

test("the plan switch in the box tunes the session's mode", async () => {
  const app = await project();
  expect(app.texts()).toContain("plan-mode:off");
  await app.press("id:project-plan");
  await app.waitUntil(() => app.texts().includes("plan-mode:on"), { timeout: 10_000 });
  await app.press("id:project-plan");
  await app.waitUntil(() => app.texts().includes("plan-mode:off"), { timeout: 10_000 });
});

test("a Grok session's box has the plan switch, and with work going its Stop ends one task alone; Codex's only all of it", async () => {
  const app = await project();
  await app.press("id:story-agent-grok");
  await app.waitFor("id:project-plan");
  await app.press("id:project-plan");
  await app.waitUntil(() => app.texts().includes("plan-mode:on"), { timeout: 10_000 });
  await app.press("id:project-plan");
  await app.waitUntil(() => app.texts().includes("plan-mode:off"), { timeout: 10_000 });
  await app.press("id:story-run");
  await app.waitFor("id:stop-menu", { timeout: 10_000 });
  await app.press("id:stop-menu");
  await app.waitFor("id:stop-item-run");
  expect(app.shows("id:stop-item-task:cmd-b")).toBe(true);
  expect(app.shows("id:stop-item-task:sub-b")).toBe(true);
  await app.keyboard.press("escape");
  // Codex cannot end one task alone: no menu, Stop is for the whole run.
  await app.press("id:story-agent-codex");
  await app.waitFor("id:stop-menu", { state: "gone", timeout: 10_000 });
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

test("a question the agent asks waits at the conversation's end, under what it said, and is answered there", async () => {
  const app = await project();
  await app.press("id:story-ask");
  await app.waitFor("id:project-asks", { timeout: 10_000 });
  // Under the run's bubble (what it said before asking, then its foot), not among the lines.
  expect(app.shows("id:project-asks >> text:要改哪一份 README？")).toBe(true);
  expect(app.shows("id:project-line-pj-ask-open")).toBe(false);
  expect(app.texts()).toContain("两份都提到了安装，先确认几件事。");
  expect(app.texts()).toContain("根目录");
  expect(app.texts()).toContain("docs 目录");
  expect(app.texts()).toContain(t.project.waitingAnswer(t.project.agentNames.claude_code));
  expect(app.shows("id:project-approval")).toBe(false);
  // One question has no steps, and its button replies.
  expect(app.shows("id:project-asks >> id:ask-step-1")).toBe(false);
  expect(app.shows(`id:project-asks >> text:${t.stream.reply}`)).toBe(true);
  await app.press("id:project-asks >> label:docs 目录");
  await app.press("id:project-asks >> id:ask-send");
  await app.waitUntil(() => said(app) === "ask:pj-ask-open:docs 目录|", { timeout: 10_000 });
  // Answered, the card goes back among the lines with the answer, and the run goes on.
  await app.waitFor("id:project-line-pj-ask-open >> id:ask-answered", { timeout: 10_000 });
  expect(app.shows("id:project-asks")).toBe(false);
  expect(app.shows("id:project-line-pj-ask-open >> id:ask-input")).toBe(false);
});

test("a question the run no longer waits on is read-only, among the lines", async () => {
  const app = await project();
  await app.press("id:story-ask");
  await app.waitFor("text:测试跑哪一组？", { timeout: 10_000 });
  expect(app.shows("id:project-line-pj-ask-ended >> id:ask-input")).toBe(false);
  await expect(app.press("id:project-line-pj-ask-ended >> label:根目录")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  expect(app.shows("id:project-asks >> id:ask-input")).toBe(true);
});

test("questions asked together are one card, a step at a time, sent together once each has its answer", async () => {
  const app = await project();
  const agent = t.project.agentNames.claude_code;
  await app.press("id:story-ask-many");
  await app.waitFor("id:project-asks", { timeout: 10_000 });
  expect(app.texts()).toContain(t.project.askingMany(agent, 3));
  expect(app.texts()).toContain("两份都提到了安装，先确认几件事。");
  // One question at a time, with a step for each.
  expect(app.shows("id:project-asks >> text:先改哪一份 README？")).toBe(true);
  expect(app.shows("text:改完要跑哪些检查？")).toBe(false);
  expect(app.shows("text:还有什么要注意的？")).toBe(false);
  expect(app.count("id:project-asks >> id:ask-input")).toBe(1);
  expect(app.shows("id:project-asks >> id:ask-step-3")).toBe(true);
  expect(app.shows("id:project-line-pj-ask-many-1")).toBe(false);
  // Its button goes on to the next while others have no answer.
  expect(app.shows(`id:project-asks >> text:${t.project.askNext}`)).toBe(true);
  await app.press("id:project-asks >> label:根目录");
  await app.press("id:project-asks >> id:ask-send");
  await app.waitFor("id:project-asks >> text:改完要跑哪些检查？", { timeout: 5_000 });
  expect(app.shows("text:先改哪一份 README？")).toBe(false);
  expect(said(app)).toBe("—");
  // Straight to the last: words of your own; the second has none yet, so the button goes there and nothing is sent.
  await app.press(`label:${t.project.askStep(3, false)}`);
  await app.waitFor("id:project-asks >> text:还有什么要注意的？", { timeout: 5_000 });
  await app.type("id:project-asks >> id:ask-input", "别动 CHANGELOG");
  expect(app.shows(`id:project-asks >> text:${t.project.askNext}`)).toBe(true);
  await app.press("id:project-asks >> id:ask-send");
  await app.waitFor("id:project-asks >> text:改完要跑哪些检查？", { timeout: 5_000 });
  expect(said(app)).toBe("—");
  // The steps say which have their answers.
  expect(app.shows(`label:${t.project.askStep(1, true)}`)).toBe(true);
  expect(app.shows(`label:${t.project.askStep(3, true)}`)).toBe(true);
  expect(app.shows(`label:${t.project.askStep(2, false)}`)).toBe(true);
  await app.press("id:project-asks >> label:单元测试");
  await app.press("id:project-asks >> label:类型检查");
  // Each has an answer now: the button sends them all, oldest first.
  expect(app.shows(`id:project-asks >> text:${t.project.askSubmit}`)).toBe(true);
  await app.press("id:project-asks >> id:ask-send");
  await app.waitUntil(() => app.texts().includes("answers:pj-ask-many-1=根目录|;pj-ask-many-2=单元测试,类型检查|;pj-ask-many-3=|别动 CHANGELOG"), { timeout: 10_000 });
  // Answered, they are one card among the lines, still a step at a time.
  await app.waitFor("id:project-asks-pj-ask-many-1", { timeout: 10_000 });
  expect(app.shows("id:project-asks")).toBe(false);
  expect(app.texts()).toContain(t.project.askedMany(agent, 3));
  expect(app.shows("id:project-asks-pj-ask-many-1 >> text:先改哪一份 README？")).toBe(true);
  expect(app.count("id:project-asks-pj-ask-many-1 >> id:ask-answered")).toBe(1);
  await app.press("id:project-asks-pj-ask-many-1 >> id:ask-step-3");
  await app.waitFor("id:project-asks-pj-ask-many-1 >> text:还有什么要注意的？", { timeout: 5_000 });
  expect(app.texts()).toContain("别动 CHANGELOG");
});

test("an answer refused on the way stops there: its question shows why, and the rest go when sent again", async () => {
  const app = await project();
  await app.press("id:story-ask-refuse");
  await app.press("id:story-ask-many");
  await app.waitFor("id:project-asks", { timeout: 10_000 });
  await app.press("id:project-asks >> label:docs 目录");
  await app.press("id:project-asks >> id:ask-send");
  await app.waitFor("id:project-asks >> text:改完要跑哪些检查？", { timeout: 5_000 });
  await app.press("id:project-asks >> label:截图对比");
  await app.press("id:project-asks >> id:ask-send");
  await app.waitFor("id:project-asks >> text:还有什么要注意的？", { timeout: 5_000 });
  await app.type("id:project-asks >> id:ask-input", "慢慢来");
  await app.press("id:project-asks >> id:ask-send");
  // The first went; the second was refused, and shows with why; the third waits.
  await app.waitFor("id:project-asks >> id:ask-error", { timeout: 10_000 });
  expect(app.texts()).toContain("暂时答不了，再试一次");
  expect(app.shows("id:project-asks >> text:改完要跑哪些检查？")).toBe(true);
  expect(app.texts()).toContain("answers:pj-ask-many-1=docs 目录|");
  // Still one card of three, the first answered in it.
  expect(app.shows("id:project-asks >> id:ask-step-3")).toBe(true);
  await app.press("id:project-asks >> id:ask-send");
  await app.waitUntil(() => app.texts().includes("answers:pj-ask-many-1=docs 目录|;pj-ask-many-2=截图对比|;pj-ask-many-3=|慢慢来"), { timeout: 10_000 });
  await app.waitFor("id:project-asks-pj-ask-many-1", { timeout: 10_000 });
});
