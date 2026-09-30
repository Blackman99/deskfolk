/**
 * Your words (原话, ADR 0040): kept in the same write as the line, the answer or the board edit, filed
 * with the line, and outliving the transcript when a conversation is cleared or deleted — erased only
 * when you ask. The plans they are about are set aside then, not ended.
 */
import { describe, expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID } from "@real-bot/protocol";
import { Store } from ".";
import { isoNow } from "../ids";
import { codePointCount } from "../text";
import { clipQuote, QUOTE_MAX } from "./quotes";
import type { PlanSpec } from "./plan-shape";

function spec(over: Partial<PlanSpec> = {}): PlanSpec {
  return {
    kind: "视频",
    goal: "EP01 动画成片",
    acceptance: ["母带交到 deliverables/"],
    rules: ["不用冻帧补时长"],
    process: [],
    progress: { done: [], open: [], blocked: [] },
    status: "active",
    ...over,
  };
}

/** 视频导演 and 审片员 in a group, and your direct with 视频导演. */
function fixture() {
  const store = new Store();
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const reviewer = store.createBot({ name: "审片员", duties: "审片", boundaries: "none" });
  const room = store.createGroup({ name: "片场", members: [director.bot.id, reviewer.bot.id] });
  return { store, director: director.bot, reviewer: reviewer.bot, room: room.id, direct: director.direct_session.id };
}

/** A line of yours that opens a turn, which files it under the plan the turn opens. */
function lineWithPlan(store: Store, sessionId: string, botId: string, body: string) {
  const line = store.postMessage(sessionId, { body });
  const turn = store.createTurn({ sessionId, botId, triggerMessageId: line.id });
  store.setTurnStatus(turn.id, "completed");
  return { line, turn, planId: turn.task_id! };
}

const bodies = (store: Store, filter: Parameters<Store["listQuotes"]>[0]) => store.listQuotes(filter).map((quote) => quote.body);

describe("what is kept", () => {
  test("a line you send, in the same write, and it follows the plan it is filed under", () => {
    const { store, director, direct } = fixture();
    const line = store.postMessage(direct, { body: "片长两分钟左右" });
    expect(store.listQuotes({ messageId: line.id })).toMatchObject([
      { via: "message", body: "片长两分钟左右", session_id: direct, task_id: null, ticket_id: null, redacted_at: null },
    ]);

    // The turn it opens files it; the quote follows.
    const turn = store.createTurn({ sessionId: direct, botId: director.id, triggerMessageId: line.id });
    expect(store.listQuotes({ messageId: line.id })[0]!.task_id).toBe(turn.task_id!);

    // Filed again elsewhere — by the organizer, or an older build writing the row itself — it follows again.
    const other = store.openTask({ sessionId: direct, title: "另一件事" });
    const ticket = store.createTicket({ taskId: other.id, title: "Shot 01", spec: "", status: "todo" });
    store.db.run(`UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?`, [other.id, ticket.id, line.id]);
    expect(store.listQuotes({ messageId: line.id })[0]).toMatchObject({ task_id: other.id, ticket_id: ticket.id });
    store.close();
  });

  test("nothing is kept of a line that did not land, of whitespace, or of the file drop", () => {
    const { store, direct } = fixture();
    expect(() =>
      store.transaction(() => {
        store.postMessage(direct, { body: "撤回的话" });
        throw new Error("the write after it failed");
      }),
    ).toThrow("the write after it failed");
    expect(store.listMessages(direct).items).toEqual([]);
    expect(store.listQuotes()).toEqual([]);

    store.postMessage(FILE_DROP_SESSION_ID, { body: "传个文件" });
    expect(store.listQuotes()).toEqual([]);
    store.close();
  });

  test("an answer to a Bot's question, under the plan it asked in", () => {
    const { store, director, direct } = fixture();
    const { turn, planId } = lineWithPlan(store, direct, director.id, "做一版片头");
    const ask = store.insertMessage({
      sessionId: direct,
      turnId: turn.id,
      kind: "ask",
      author: director.id,
      body: "片头多长？",
      ask: { options: [{ label: "5 秒" }, { label: "10 秒" }], multi_select: false },
    });
    const answeredAt = isoNow();
    store.recordAskAnswer(ask.id, { selected: ["5 秒"], custom: "别超过 6 秒", answered_at: answeredAt });
    expect(store.listQuotes({ messageId: ask.id })).toMatchObject([
      { via: "ask_answer", body: "5 秒\n别超过 6 秒", session_id: direct, task_id: planId, created_at: answeredAt },
    ]);
    store.close();
  });

  test("what you write on the board: a changed goal, each line you bring in, a ticket's description", () => {
    const { store, room } = fixture();
    const plan = store.openTask({ sessionId: room, title: "EP01", spec: spec() });
    const shot = store.createTicket({ taskId: plan.id, title: "Shot 01", spec: "", status: "todo" });

    // The goal and the lines already there are not typed again; only what you bring in is.
    store.setPlanSpecByUser(plan.id, spec({ acceptance: ["母带交到 deliverables/", "母带 2 分钟左右"], rules: ["不用冻帧补时长", "机械臂是左手"] }));
    expect(store.listQuotes({ taskId: plan.id })).toMatchObject([
      { via: "board", body: "母带 2 分钟左右", message_id: null, session_id: null, ticket_id: null },
      { via: "board", body: "机械臂是左手" },
    ]);
    store.setPlanSpecByUser(plan.id, spec({ goal: "EP01 两分钟成片", acceptance: ["母带 2 分钟左右"], rules: ["机械臂是左手"] }));
    expect(bodies(store, { taskId: plan.id }).at(-1)).toBe("EP01 两分钟成片");

    store.patchTicketByUser(shot.id, { spec: "脚不能穿地" });
    expect(store.listQuotes({ taskId: plan.id }).at(-1)).toMatchObject({ via: "board", body: "脚不能穿地", ticket_id: shot.id });
    // Dragging it to another column writes nothing of yours.
    store.patchTicketByUser(shot.id, { status: "doing" });
    expect(store.listQuotes({ taskId: plan.id })).toHaveLength(4);
    store.close();
  });

  test("a long one keeps its head and its tail, at most QUOTE_MAX code points, never splitting a character", () => {
    expect(clipQuote("短")).toBe("短");
    const exact = "镜".repeat(QUOTE_MAX);
    expect(clipQuote(exact)).toBe(exact);

    const long = `开头要${"镜".repeat(3000)}结尾不要冻帧😀`;
    const clipped = clipQuote(long);
    expect(codePointCount(clipped)).toBeLessThanOrEqual(QUOTE_MAX);
    expect(clipped.startsWith("开头要")).toBe(true);
    expect(clipped.endsWith("结尾不要冻帧😀")).toBe(true);
    const omitted = Number(/\n\[…(\d+)…\]\n/.exec(clipped)![1]);
    const [head, tail] = clipped.split(/\n\[…\d+…\]\n/);
    expect(codePointCount(head!) + omitted + codePointCount(tail!)).toBe(codePointCount(long));

    const emoji = "😀".repeat(QUOTE_MAX + 10);
    expect(clipQuote(emoji).replace(/\n\[…\d+…\]\n/, "")).toMatch(/^(😀)+$/u);
  });
});

describe("clearing and deleting a conversation", () => {
  test("clearing keeps what you said and the requirements, losing only the lines; its plans are set aside", () => {
    const { store, director, room } = fixture();
    const { line, planId } = lineWithPlan(store, room, director.id, "片长 2 分钟左右，机械臂是左手");
    const [quote] = store.listQuotes({ messageId: line.id });
    const onPlan = store.addRequirement({ scope: "plan", scopeId: planId, quote: "片长 2 分钟左右", sourceKind: "message", sourceQuoteId: quote!.id, addedBy: "app" });
    const onProject = store.addRequirement({ scope: "project", scopeId: room, quote: "机械臂是左手", sourceKind: "message", sourceQuoteId: quote!.id, addedBy: "app" });

    store.clearSessionMessages(room);
    expect(store.listMessages(room).items).toEqual([]);
    expect(store.listQuotes({ sessionId: room })).toMatchObject([
      { id: quote!.id, body: "片长 2 分钟左右，机械臂是左手", message_id: null, session_id: room, task_id: planId, redacted_at: null },
    ]);
    expect(store.getRequirement(onPlan.id)).toEqual(onPlan);
    expect(store.getRequirement(onProject.id)).toEqual(onProject);

    // Nothing of the transcript refers to the plan any more; your words about it still do.
    const plan = store.getTask(planId);
    expect(plan.dormant_since).toBeString();
    expect(plan.closed_at).toBe(plan.dormant_since);
    expect(store.listWorkEvents({ kind: "plan.dormant" })).toMatchObject([{ task_id: planId, session_id: room, payload: { cause: "cleared" } }]);
    store.close();
  });

  test("deleting keeps what you said with no place to point at; a requirement of the whole conversation stands without one", () => {
    const { store, director, room } = fixture();
    const { line, planId } = lineWithPlan(store, room, director.id, "背景要连贯");
    const [quote] = store.listQuotes({ messageId: line.id });
    const onProject = store.addRequirement({ scope: "project", scopeId: room, quote: "背景要连贯", sourceKind: "message", sourceQuoteId: quote!.id, addedBy: "app" });

    store.deleteSession(room);
    expect(store.listQuotes()).toMatchObject([{ id: quote!.id, body: "背景要连贯", message_id: null, session_id: null, task_id: planId }]);
    expect(store.getRequirement(onProject.id)).toMatchObject({ scope: "project", scope_id: null, status: "open", quote: "背景要连贯" });
    expect(store.listWorkEvents({ kind: "requirement.rescope" })).toMatchObject([
      { actor: "user", session_id: room, payload: { requirements: [onProject.id], scope: "project", scope_id: null, cause: "session_deleted" } },
    ]);
    expect(store.getTask(planId)).toMatchObject({ session_id: null, dormant_since: expect.any(String), closed_at: expect.any(String) });
    expect(store.listWorkEvents({ kind: "plan.dormant" })).toMatchObject([{ task_id: planId, payload: { cause: "deleted" } }]);
    store.close();
  });

  test("erasing what you said there empties the words, waives what stood on them, and lets their plans go", () => {
    const { store, director, room, direct } = fixture();
    const { line, planId } = lineWithPlan(store, room, director.id, "前三镜背景严重跳跃");
    const [said] = store.listQuotes({ messageId: line.id });
    const fromLine = store.addRequirement({ scope: "project", scopeId: room, quote: "背景严重跳跃", restated: "前三镜背景要连贯", sourceKind: "message", sourceQuoteId: said!.id, addedBy: "app" });
    // Said elsewhere: not reached.
    const elsewhere = store.postMessage(direct, { body: "片头 5 秒" });
    // Typed on the board, which is no conversation: kept, and it keeps its plan.
    const boarded = store.openTask({ sessionId: room, title: "EP02", spec: spec() });
    store.setPlanSpecByUser(boarded.id, spec({ rules: ["不用冻帧补时长", "机械臂是左手"] }));

    store.clearSessionMessages(room, { eraseQuotes: true });
    expect(store.listQuotes({ sessionId: room })).toMatchObject([{ id: said!.id, body: "", redacted_at: expect.any(String) }]);
    expect(bodies(store, { messageId: elsewhere.id })).toEqual(["片头 5 秒"]);
    expect(bodies(store, { taskId: boarded.id })).toEqual(["机械臂是左手"]);
    expect(store.getRequirement(fromLine.id)).toMatchObject({ quote: "", restated: null, status: "waived" });
    expect(store.listWorkEvents({ kind: "quotes.erased" })).toMatchObject([{ actor: "user", payload: { quotes: [said!.id], waived: [fromLine.id] } }]);

    // Erased words keep nothing: the plan they were about goes as it did before words were kept.
    expect(() => store.getTask(planId)).toThrow("task not found");
    expect(store.getTask(boarded.id).dormant_since).toBeString();
    store.close();
  });

  test("a plan's requirement keeps its plan through a clear, even with your words erased", () => {
    const { store, director, room } = fixture();
    const { line, planId } = lineWithPlan(store, room, director.id, "机械臂是左手");
    const [said] = store.listQuotes({ messageId: line.id });
    const entry = store.addRequirement({ scope: "plan", scopeId: planId, quote: "机械臂是左手", sourceKind: "message", sourceQuoteId: said!.id, addedBy: "app" });

    store.clearSessionMessages(room, { eraseQuotes: true });
    expect(store.getTask(planId).dormant_since).toBeString();
    expect(store.getRequirement(entry.id)).toMatchObject({ scope_id: planId, status: "waived" });
    store.close();
  });

  test("a routine's standing plan is closed, as before, and not set aside: its routine goes on firing into it", () => {
    const { store, director, direct } = fixture();
    const routine = store.createRoutine({ bot_id: director.id, title: "日报", instruction: "写日报", schedule: { kind: "daily", time: "09:00" } });
    const standing = store.openTask({ sessionId: direct, title: "日报", routineId: routine.id, spec: spec({ goal: "每天的日报" }) });
    // A rule you typed on its board keeps it through the clear.
    store.setPlanSpecByUser(standing.id, spec({ goal: "每天的日报", rules: ["不用冻帧补时长", "九点前发"] }));
    store.clearSessionMessages(direct);
    expect(store.getTask(standing.id)).toMatchObject({ closed_at: expect.any(String), dormant_since: null });
    store.close();
  });
});

describe("a plan set aside", () => {
  test("comes back when it is put back in its conversation's slot, whoever does it", () => {
    const { store, director, room } = fixture();
    const { planId } = lineWithPlan(store, room, director.id, "EP01 开工");
    store.clearSessionMessages(room);
    expect(store.getTask(planId).dormant_since).toBeString();

    // A later turn working in it only moves its closing, so the tool-results sweep spares it: still set aside.
    const before = store.getTask(planId).closed_at;
    store.db.run(`UPDATE tasks SET closed_at = ? WHERE id = ?`, [isoNow(), planId]);
    expect(store.getTask(planId).closed_at).not.toBe(before);
    expect(store.getTask(planId).dormant_since).toBeString();

    // You set it in progress again on the board.
    store.setPlanSpecByUser(planId, spec());
    expect(store.getTask(planId)).toMatchObject({ closed_at: null, dormant_since: null });

    // An older build that knows nothing of dormancy puts it back by clearing closed_at alone.
    store.clearSessionMessages(room);
    expect(store.getTask(planId).dormant_since).toBeString();
    store.db.run(`UPDATE tasks SET closed_at = NULL WHERE id = ?`, [planId]);
    expect(store.getTask(planId).dormant_since).toBeNull();
    store.close();
  });
});
