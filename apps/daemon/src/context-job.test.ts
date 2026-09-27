import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER } from "@real-bot/protocol";
import type { ChatMessage } from "./completions";
import {
  assembleComposerSuggestUser,
  assembleJudgementUser,
  assembleTurnMessages,
  planFacts,
  SITUATION_HEADING,
} from "./context";
import { Store } from "./store";

const workspaces: string[] = [];

afterEach(() => {
  while (workspaces.length) {
    const dir = workspaces.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function situationOf(messages: ChatMessage[]): string {
  const block = messages.find(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(SITUATION_HEADING),
  );
  return String(block?.content ?? "");
}

function transcriptOf(messages: ChatMessage[]): string[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter((text) => !text.startsWith(SITUATION_HEADING));
}

/** A group where the user asks for a report, the Writer drafts it, and the Reviewer is woken to look. */
async function room() {
  const root = mkdtempSync(join(tmpdir(), "real-bot-job-"));
  workspaces.push(root);
  const store = new Store();
  await store.patchSettings({ workspace_path: root });
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" }).bot;
  const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" }).bot;
  const group = store.createGroup({ name: "Brief", members: [writer.id, reviewer.id] });
  const brief = store.insertMessage({
    sessionId: group.id,
    kind: "user",
    author: USER_MEMBER,
    body: "写一份周报，交到 report.md，先给 Reviewer 过一遍",
  });
  const drafting = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: brief.id });
  writeFileSync(join(root, "report.md"), "# 周报\n");
  const handoff = store.insertMessage({
    sessionId: group.id,
    turnId: drafting.id,
    kind: "bot",
    author: writer.id,
    body: "初稿在 report.md，@Reviewer 请看",
    paths: ["report.md"],
  });
  store.setTurnStatus(drafting.id, "completed");
  return { root, store, writer, reviewer, group, brief, drafting, handoff };
}

function assemble(store: Store, input: { sessionId: string; botId: string; turnId: string; triggerMessageId: string; locale?: "zh" | "en" }) {
  return assembleTurnMessages(store, {
    sessionId: input.sessionId,
    botId: input.botId,
    turnId: input.turnId,
    triggerMessageId: input.triggerMessageId,
    locale: input.locale ?? "zh",
    interrupt: false,
    loop: [],
  });
}

describe("the job in the situation block", () => {
  test("a later turn reads the opening request, what was handed over, and who did what — even once the request left the window", async () => {
    const { store, reviewer, group, brief, drafting, handoff } = await room();
    for (let i = 0; i < 45; i += 1) {
      store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: `闲聊 ${i}` });
    }
    const reviewing = store.createTurn({ sessionId: group.id, botId: reviewer.id, triggerMessageId: handoff.id });
    expect(reviewing.task_id).toBe(drafting.task_id!);
    const messages = assemble(store, { sessionId: group.id, botId: reviewer.id, turnId: reviewing.id, triggerMessageId: handoff.id });
    // The request itself has scrolled out of the forty-line window…
    expect(transcriptOf(messages).some((line) => line.includes(brief.body))).toBe(false);
    // …and the block still carries it, with the file the job has cited and the turns so far.
    const situation = situationOf(messages);
    expect(situation).toContain("这件事最初的要求（规划「写一份周报，交到 report.md，先给 Reviewer 过一遍」）：写一份周报，交到 report.md，先给 Reviewer 过一遍");
    expect(situation).toContain("这件事已交出：report.md");
    expect(situation).toContain("经过：\n- 【user】写一份周报，交到 report.md，先给 Reviewer 过一遍\n- 【Writer】初稿在 report.md，@Reviewer 请看");
    expect(situation).not.toContain("这是这件事的第一轮");
    // The reviewer's own, still-running turn is not part of "so far".
    expect(situation).not.toContain("【Reviewer】");
    // Group facts stay first and the work dir stays last.
    expect(situation.indexOf("在场成员")).toBeLessThan(situation.indexOf("这件事最初的要求"));
    expect(situation.trimEnd().endsWith(`本轮工作目录：${store.getTask(reviewing.task_id!).dir}/`)).toBe(true);
    store.close();
  });

  test("the first turn of a job says so instead of quoting the line that is already its trigger", async () => {
    const { store, writer, group, brief, drafting } = await room();
    const messages = assemble(store, { sessionId: group.id, botId: writer.id, turnId: drafting.id, triggerMessageId: brief.id });
    const situation = situationOf(messages);
    expect(situation).toContain("这是这件事的第一轮（规划「写一份周报，交到 report.md，先给 Reviewer 过一遍」）。");
    expect(situation).not.toContain("这件事最初的要求");
    expect(situation).not.toContain("经过：");
    store.close();
  });

  test("a file that is gone drops out of what was handed over", async () => {
    const { root, store, reviewer, group, handoff } = await room();
    unlinkSync(join(root, "report.md"));
    const reviewing = store.createTurn({ sessionId: group.id, botId: reviewer.id, triggerMessageId: handoff.id });
    const situation = situationOf(assemble(store, { sessionId: group.id, botId: reviewer.id, turnId: reviewing.id, triggerMessageId: handoff.id }));
    expect(situation).not.toContain("这件事已交出");
    expect(situation).toContain("这件事最初的要求");
    store.close();
  });

  test("a booked check-back shows on the Bot's own block until it fires, and never on a teammate's", async () => {
    const { store, writer, reviewer, group, drafting, handoff } = await room();
    const { row } = store.scheduleCheckBack({
      botId: writer.id,
      sessionId: group.id,
      turnId: drafting.id,
      note: "看 Reviewer 回了没有",
      afterMinutes: 30,
    });
    const nudge = store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "@Writer 顺便加个摘要" });
    const again = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: nudge.id });
    const mine = situationOf(assemble(store, { sessionId: group.id, botId: writer.id, turnId: again.id, triggerMessageId: nudge.id }));
    expect(mine).toMatch(/你约的回看：(29|30) 分钟后（看 Reviewer 回了没有）/);
    const reviewing = store.createTurn({ sessionId: group.id, botId: reviewer.id, triggerMessageId: handoff.id });
    const theirs = situationOf(assemble(store, { sessionId: group.id, botId: reviewer.id, turnId: reviewing.id, triggerMessageId: handoff.id }));
    expect(theirs).not.toContain("你约的回看");
    store.claimCheckBack(row.id);
    const after = situationOf(assemble(store, { sessionId: group.id, botId: writer.id, turnId: again.id, triggerMessageId: nudge.id }));
    expect(after).not.toContain("你约的回看");
    store.close();
  });

  test("the English block renders the same facts", async () => {
    const { store, reviewer, group, handoff } = await room();
    const reviewing = store.createTurn({ sessionId: group.id, botId: reviewer.id, triggerMessageId: handoff.id });
    const situation = situationOf(assemble(store, { sessionId: group.id, botId: reviewer.id, turnId: reviewing.id, triggerMessageId: handoff.id, locale: "en" }));
    expect(situation).toContain(`What this job was asked for (plan "写一份周报，交到 report.md，先给 Reviewer 过一遍"): 写一份周报，交到 report.md，先给 Reviewer 过一遍`);
    expect(situation).toContain("Handed over so far: report.md");
    expect(situation).toContain("So far:\n- 【user】");
    store.close();
  });

  test("a running or waiting turn is labelled on its trace line", async () => {
    const { store, writer, reviewer, group, handoff } = await room();
    const reviewing = store.createTurn({ sessionId: group.id, botId: reviewer.id, triggerMessageId: handoff.id });
    const facts = planFacts(store, {
      taskId: reviewing.task_id!,
      turnId: null,
      triggerMessageId: null,
      botId: writer.id,
      sessionId: group.id,
      locale: "zh",
    })!;
    expect(facts.first_turn).toBe(false);
    expect(facts.trace.at(-1)).toBe("【Reviewer】初稿在 report.md，@Reviewer 请看（进行中）");
    store.close();
  });
});

describe("the job in the judgement and composer payloads", () => {
  test("a judgement sees the plan the message lands in", async () => {
    const { store, reviewer, group } = await room();
    const ask = store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "数据要按地区分" });
    const payload = JSON.parse(
      assembleJudgementUser(store, { sessionId: group.id, botId: reviewer.id, message: ask, mentions: [], everyone: false }),
    ) as { plan: Record<string, unknown> | null };
    expect(payload.plan).toEqual({
      goal: null,
      kind: null,
      status: "active",
      brief: "写一份周报，交到 report.md，先给 Reviewer 过一遍",
      first_turn: false,
      acceptance: [],
      rules: [],
      tickets: [],
      message_ticket: null,
      artifacts: ["report.md"],
      trace: ["【user】写一份周报，交到 report.md，先给 Reviewer 过一遍", "【Writer】初稿在 report.md，@Reviewer 请看"],
      live_elsewhere: [],
      you_heard_elsewhere: false,
    });
    store.close();
  });

  test("with no open job there is nothing to report", () => {
    const store = new Store();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" }).bot;
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" }).bot;
    const group = store.createGroup({ name: "Fresh", members: [writer.id, reviewer.id] });
    const ask = store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "大家好" });
    const payload = JSON.parse(
      assembleJudgementUser(store, { sessionId: group.id, botId: reviewer.id, message: ask, mentions: [], everyone: false }),
    ) as { plan: unknown };
    expect(payload.plan).toBeNull();
    const suggest = JSON.parse(assembleComposerSuggestUser(store, group.id)) as { plan: unknown };
    expect(suggest.plan).toBeNull();
    store.close();
  });

  test("composer suggestions carry the current plan's goal, which is the request until the organizer has run", async () => {
    const { store, group } = await room();
    const payload = JSON.parse(assembleComposerSuggestUser(store, group.id)) as { plan: { goal: string | null; acceptance: string[]; open_tickets: string[] } | null };
    expect(payload.plan).toEqual({ goal: "写一份周报，交到 report.md，先给 Reviewer 过一遍", acceptance: [], open_tickets: [] });
    store.close();
  });
});

describe("which job a line is about", () => {
  test("a line from another plan or ticket says which; the turn's own ticket, an unfiled line and the Bot's own lines stay bare", async () => {
    const { store, writer, reviewer, group, drafting } = await room();
    const report = drafting.task_id!;
    // Each turn opens on a line of its own: a trigger takes the first plan and ticket that opens on it.
    const poke = (body: string) => store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body }).id;
    const draft = store.createTicket({ taskId: report, title: "初稿" });
    const review = store.createTicket({ taskId: report, title: "审稿" });
    const poster = store.openTask({ sessionId: group.id, title: "做一张海报，放在 poster.png" });
    const posterTurn = store.createTurn({ sessionId: group.id, botId: reviewer.id, triggerMessageId: poke("海报"), taskId: poster.id });
    store.insertMessage({ sessionId: group.id, turnId: posterTurn.id, kind: "bot", author: reviewer.id, body: "海报先出草图" });
    store.setTurnStatus(posterTurn.id, "completed");
    const reviewTurn = store.createTurn({ sessionId: group.id, botId: reviewer.id, triggerMessageId: poke("审一下"), taskId: report, ticketId: review.id });
    store.insertMessage({ sessionId: group.id, turnId: reviewTurn.id, kind: "bot", author: reviewer.id, body: "审稿意见在路上" });
    store.setTurnStatus(reviewTurn.id, "completed");
    const writerPoster = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: poke("标题"), taskId: poster.id });
    store.insertMessage({ sessionId: group.id, turnId: writerPoster.id, kind: "bot", author: writer.id, body: "海报标题我来想" });
    store.setTurnStatus(writerPoster.id, "completed");
    const sameTicket = store.createTurn({ sessionId: group.id, botId: reviewer.id, triggerMessageId: poke("看初稿"), taskId: report, ticketId: draft.id });
    store.insertMessage({ sessionId: group.id, turnId: sameTicket.id, kind: "bot", author: reviewer.id, body: "初稿我看过了" });
    store.setTurnStatus(sameTicket.id, "completed");
    store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "随便聊一句" });
    const next = poke("接着写");

    const drafting2 = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: next, taskId: report, ticketId: draft.id });
    const lines = transcriptOf(assemble(store, { sessionId: group.id, botId: writer.id, turnId: drafting2.id, triggerMessageId: next }));
    expect(lines).toContain("【Reviewer】〔规划「做一张海报，放在 poster.png」〕\n海报先出草图");
    expect(lines).toContain("【Reviewer】〔任务 02〕\n审稿意见在路上");
    expect(lines).toContain("【Reviewer】\n初稿我看过了");
    // The opening line is this plan's with no ticket of its own: nothing to tell apart.
    expect(lines).toContain("【user】\n写一份周报，交到 report.md，先给 Reviewer 过一遍");
    expect(lines).toContain("【user】\n随便聊一句");
    expect(lines).toContain("【user】〔任务 02〕\n审一下");
    expect(lines).toContain("【user】\n（本轮触发）\n接着写");
    // The Writer's own line from the poster stays in its own voice, untagged.
    expect(lines).toContain("海报标题我来想");

    // English names the plan the same way, in English words.
    const en = transcriptOf(assemble(store, { sessionId: group.id, botId: writer.id, turnId: drafting2.id, triggerMessageId: next, locale: "en" }));
    expect(en).toContain('【Reviewer】〔plan "做一张海报，放在 poster.png"〕\n海报先出草图');
    expect(en).toContain("【Reviewer】〔ticket 02〕\n审稿意见在路上");
    store.close();
  });

  test("a plan's long title is clipped in the tag", async () => {
    const { store, writer, reviewer, group, brief, drafting } = await room();
    const other = store.openTask({ sessionId: group.id, title: "把上个季度所有渠道的投放数据整理成一张可以筛选的表" });
    const turn = store.createTurn({ sessionId: group.id, botId: reviewer.id, triggerMessageId: brief.id, taskId: other.id });
    store.insertMessage({ sessionId: group.id, turnId: turn.id, kind: "bot", author: reviewer.id, body: "表头定了" });
    store.setTurnStatus(turn.id, "completed");
    const again = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: brief.id, taskId: drafting.task_id! });
    const lines = transcriptOf(assemble(store, { sessionId: group.id, botId: writer.id, turnId: again.id, triggerMessageId: brief.id }));
    expect(lines).toContain("【Reviewer】〔规划「把上个季度所有渠道的投放数据整理成一张可…」〕\n表头定了");
    store.close();
  });

  test("a job carried into a Bot↔Bot direct says where it was opened, who is on it elsewhere, where each step happened, and what else this Bot is doing", async () => {
    const { store, writer, reviewer, group, brief, drafting, handoff } = await room();
    // The Writer is back on the report in the group, still running.
    const writing = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: handoff.id });
    // The Reviewer has something of its own going in its direct with you.
    const mine = store.findDirectSession(USER_MEMBER, reviewer.id)!;
    const ask = store.insertMessage({ sessionId: mine.id, kind: "user", author: USER_MEMBER, body: "帮我起一个产品名" });
    const naming = store.createTurn({ sessionId: mine.id, botId: reviewer.id, triggerMessageId: ask.id });
    const namingTicket = store.createTicket({ taskId: naming.task_id!, title: "候选名" });
    store.db.run(`UPDATE turns SET ticket_id = ? WHERE id = ?`, [namingTicket.id, naming.id]);
    // The Writer took the review into a direct with the Reviewer.
    const dm = store.createBotDirect(writer.id, reviewer.id, { sessionId: group.id, messageId: handoff.id });
    const opening = store.insertMessage({ sessionId: dm.id, turnId: drafting.id, kind: "bot", author: writer.id, body: "report.md 第二段帮我看看" });
    const reviewing = store.createTurn({ sessionId: dm.id, botId: reviewer.id, triggerMessageId: opening.id });
    expect(reviewing.task_id).toBe(drafting.task_id!);

    const situation = situationOf(assemble(store, { sessionId: dm.id, botId: reviewer.id, turnId: reviewing.id, triggerMessageId: opening.id }));
    expect(situation).toContain("这件事最初的要求（规划「写一份周报，交到 report.md，先给 Reviewer 过一遍」）");
    expect(situation).toContain("这件事是在群「Brief」里开的。");
    expect(situation).toContain("这件事别处进行中的轮：Writer（群「Brief」）。");
    expect(situation).toContain("- 【user】写一份周报，交到 report.md，先给 Reviewer 过一遍（在群「Brief」）");
    expect(situation).toContain("- 【Writer】初稿在 report.md，@Reviewer 请看（进行中）（在群「Brief」）");
    expect(situation).toContain("你同时在干的别的事：你和用户的私聊里的规划「帮我起一个产品名」· 任务 01 候选名。");

    // From the Writer's seat in the group: its own direct with the Reviewer is named from its side.
    const fromGroup = situationOf(assemble(store, { sessionId: group.id, botId: writer.id, turnId: writing.id, triggerMessageId: handoff.id }));
    expect(fromGroup).toContain("这件事别处进行中的轮：Reviewer（你和Reviewer的私聊）。");
    expect(fromGroup).not.toContain("这件事是在");
    expect(fromGroup).not.toContain("你同时在干的别的事");

    const en = situationOf(assemble(store, { sessionId: dm.id, botId: reviewer.id, turnId: reviewing.id, triggerMessageId: opening.id, locale: "en" }));
    expect(en).toContain('This plan was opened in group "Brief".');
    expect(en).toContain('Also working on this plan elsewhere: Writer (group "Brief").');
    expect(en).toContain('Your other live turns: plan "帮我起一个产品名" · ticket 01 候选名 in your direct with the user.');
    store.close();
  });

  test("a judgement on your line about a job going on elsewhere knows who has it there, and whether that is itself", async () => {
    const { store, writer, reviewer, group, handoff } = await room();
    store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: handoff.id });
    const plan = store.taskOfTurn(store.listLiveTurns({ sessionId: group.id })[0]!.id)!;
    const other = store.createGroup({ name: "周会", members: [writer.id, reviewer.id] });
    const line = store.insertMessage({ sessionId: other.id, kind: "user", author: USER_MEMBER, body: "周报里别用表格" });
    store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [plan, line.id]);
    const filed = store.getMessage(line.id);
    const judge = (botId: string) =>
      (JSON.parse(assembleJudgementUser(store, { sessionId: other.id, botId, message: filed, mentions: [], everyone: false })) as {
        plan: { live_elsewhere: Array<{ bot: string; where: string }>; you_heard_elsewhere: boolean };
      }).plan;
    expect(judge(writer.id)).toMatchObject({ live_elsewhere: [{ bot: "you", where: "群「Brief」" }], you_heard_elsewhere: true });
    expect(judge(reviewer.id)).toMatchObject({ live_elsewhere: [{ bot: "Writer", where: "群「Brief」" }], you_heard_elsewhere: false });
    store.close();
  });

  test("your own turn on the same job elsewhere is named as yours", async () => {
    const { store, writer, group, handoff } = await room();
    store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: handoff.id });
    const direct = store.findDirectSession(USER_MEMBER, writer.id)!;
    const aside = store.insertMessage({ sessionId: direct.id, kind: "user", author: USER_MEMBER, body: "周报标题别太长" });
    const plan = store.taskOfTurn(store.listLiveTurns({ sessionId: group.id })[0]!.id)!;
    const turn = store.createTurn({ sessionId: direct.id, botId: writer.id, triggerMessageId: aside.id, taskId: plan });
    const situation = situationOf(assemble(store, { sessionId: direct.id, botId: writer.id, turnId: turn.id, triggerMessageId: aside.id }));
    expect(situation).toContain("这件事是在群「Brief」里开的。");
    expect(situation).toContain("这件事别处进行中的轮：你（群「Brief」）。");
    store.close();
  });
});
