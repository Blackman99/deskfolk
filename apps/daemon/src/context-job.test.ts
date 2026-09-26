import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER } from "@real-bot/protocol";
import type { ChatMessage } from "./completions";
import {
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
    expect(situation).toContain("这件事最初的要求：写一份周报，交到 report.md，先给 Reviewer 过一遍");
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
    expect(situation).toContain("这是这件事的第一轮。");
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
    expect(situation).toContain("What this job was asked for: 写一份周报，交到 report.md，先给 Reviewer 过一遍");
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
      brief: "写一份周报，交到 report.md，先给 Reviewer 过一遍",
      first_turn: false,
      artifacts: ["report.md"],
      trace: ["【user】写一份周报，交到 report.md，先给 Reviewer 过一遍", "【Writer】初稿在 report.md，@Reviewer 请看"],
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
    store.close();
  });
});
