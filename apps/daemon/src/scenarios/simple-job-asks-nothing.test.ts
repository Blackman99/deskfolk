/**
 * A simple job asks you nothing (2026-10-06, live at engine level 8). In your direct with 工作区文件助手
 * you said 「根据你的职责，生成图片更新你的头像」. Its first effect opened a job and the app posted
 * 「新开：根据你的职责，生成图片更新你的头像」 with 撤销 and a greyed 并入… beside 「没有可并入的同项目规划」;
 * 31 s later the Bot handed avatar.jpg over in one go, and the app posted 「……没有审查者，也没有你确认过
 * 的检查替你把关，所以要你来定。看过之后，放行或者退回。」 under it. You pressed 放行 and said these
 * should not keep coming for something this simple: the tag under your line already names the job,
 * the avatar was already in front of you, and none of the four 新开 cards ever posted was pressed.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, fileUnder, say, tool, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const REQUEST = "根据你的职责，生成图片更新你的头像";

/** The incident: one line, one segment that opens the job, makes the avatar and ends on it. */
async function avatar() {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "工作区文件助手", duties: "管理工作区的文件" });
  const direct = h.direct(bot!);
  // Every line reads as nothing in particular, the complaint below aside.
  h.judge("read_user_line").handle(({ payload }) => ({ control: "none", control_only: false, status_only: false,
    objections: JSON.stringify(payload ?? "").includes("太暗") ? ["背景太暗了"] : [] }));
  let turns = 0;
  h.script(bot!).handle(({ hop }) => {
    if (hop === 1) turns++;
    if (turns > 1) return call(tool("end_turn", { reason: "nothing_new" }));
    // As the real one did: the picture fetched into its working folder by a command, then its closing line.
    return hop === 1 ? call({ name: "shell", args: { command: "printf jpeg > avatar.jpg" } }) : say("头像做好了：avatar.jpg");
  });
  h.postUser(direct, REQUEST);
  await h.waitIdle({ timeoutMs: 15_000 });
  return { h, bot: bot!, direct };
}

const cards = (h: Scenario, session: string) => h.messages(session).filter((message) => message.control?.kind === "plan_opened"
  || message.control?.kind === "review_item");

test("a job opened, made and handed over in one go: no 新开 card, no 放行 card, delivered at the tick", async () => {
  const { h, direct } = await avatar();
  const plan = h.store.db.query<{ id: string; title: string }, []>("SELECT id, title FROM tasks").get()!;
  expect(plan.title).toBe(REQUEST);
  // The tag under your line names the job; nothing else in the conversation repeats it.
  expect(h.store.getMessage(h.messages(direct).find((message) => message.kind === "user")!.id).filings).toMatchObject([{ task_id: plan.id }]);
  expect(cards(h, direct)).toEqual([]);
  const [submission] = h.store.listSubmissions({ taskId: plan.id });
  expect(submission).toMatchObject({ origin: "implicit", state: "submitted" });

  h.tick(new Date(Date.now() + 60_000));
  await h.waitIdle({ timeoutMs: 15_000 });
  expect(cards(h, direct)).toEqual([]);
  expect(h.store.getSubmission(submission!.id).state).toBe("approved");
  expect(h.store.listWorkEvents({ kind: "submission.approved" }).map((event) => event.payload)).toMatchObject([{ submission_id: submission!.id, by: "one_go" }]);
  expect(h.store.getTask(plan.id)).toMatchObject({ stage: "delivered", status: "done" });
  // Nothing waits on you: no notification asks.
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'ask' AND action_state = 'open'").get()).toEqual({ n: 0 });
});

test("delivered in one go, a word from you that it is wrong still sends it back", async () => {
  const { h, direct } = await avatar();
  h.tick(new Date(Date.now() + 60_000));
  await h.waitIdle({ timeoutMs: 15_000 });
  const plan = h.store.db.query<{ id: string }, []>("SELECT id FROM tasks").get()!;
  expect(h.store.getTask(plan.id)).toMatchObject({ stage: "delivered" });

  // Read as about the avatar job, the one there is (ADR 0057).
  h.judge("read_filing").handle(fileUnder());
  const line = h.postUser(direct, "背景太暗了");
  await h.waitIdle({ timeoutMs: 15_000 });
  // Read as a complaint, your line sends it back itself, with an undo; no card asks (ADR 0070).
  expect(h.store.getMessage(line.id).control).toMatchObject({ kind: "rework", offer: ["undo"] });
  expect(h.messages(direct).filter((message) => message.kind === "system" && message.control?.kind === "rework")).toEqual([]);
  expect(h.store.getTask(plan.id)).toMatchObject({ stage: "active" });
});
