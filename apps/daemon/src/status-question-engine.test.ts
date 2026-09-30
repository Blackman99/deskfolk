import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER, type ClientEvent, type Locale } from "@real-bot/protocol";
import type { ChatMessage, CompletionOk, JudgeResult } from "./completions";
import { JUDGEMENT_SYSTEM } from "./prompts/judgement";
import { ORGANIZER_SYSTEM, type OrganizerPayload } from "./prompts/organizer";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

function textOf(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

async function until<T>(check: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

/** What the organizer answers for a payload; `mode: "message"` on a fresh session always gets this. */
type Answer = (payload: OrganizerPayload) => string;

/** A turn's own completion; omitted, it hangs (respecting the abort signal) so a turn stays "running". */
type Script = () => CompletionOk | Promise<CompletionOk>;

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

async function harness(answer: Answer, script?: Script, locale: Locale = "zh") {
  const root = mkdtempSync(join(tmpdir(), "status-question-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: ChatMessage[][] = [];
  const organized: OrganizerPayload[] = [];
  let organizeCalls = 0;
  let judgeCalls = 0;
  const events: ClientEvent[] = [];
  const engine = createTurnEngine({
    store,
    settleQuietMs: 20,
    publish(event) {
      events.push(event);
    },
    completions: {
      async complete(request) {
        seen.push(request.messages);
        if (script) return script();
        // No script: hang until the turn is aborted (by a redirect, or by the engine tearing down),
        // the way a real endpoint's request would once its signal fires. This is what keeps a turn
        // "running" so a status question can be sent while it is mid-turn.
        return new Promise<CompletionOk>((resolve) => {
          const finish = () => resolve(say("好的"));
          if (request.signal.aborted) finish();
          else request.signal.addEventListener("abort", finish, { once: true });
        });
      },
      async judge(request) {
        if (request.messages[0]?.content === ORGANIZER_SYSTEM) {
          organizeCalls += 1;
          const payload = JSON.parse(String(request.messages[1]!.content)) as OrganizerPayload;
          organized.push(payload);
          return judged(answer(payload));
        }
        if (request.messages[0]?.content === JUDGEMENT_SYSTEM) judgeCalls += 1;
        return judged('{"decision":"join","reason":"fixture"}');
      },
    },
  });
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "http://127.0.0.1:1/v1",
    endpoint_api_key: "fixture",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
    locale,
  });
  closes.push(async () => {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    engine,
    seen,
    organized,
    events,
    organizeCalls: () => organizeCalls,
    judgeCalls: () => judgeCalls,
  };
}

/** A "new" plan, one ticket handed to `worker`, filed the moment there is no current plan yet. */
function newPlanAnswer(worker: string, ticketStatus = "doing"): Answer {
  return (payload) => {
    if (payload.mode === "message" && !payload.current_plan) {
      return JSON.stringify({
        decision: "new",
        plan: { kind: "视频", goal: "剪出预告片", acceptance: ["交出成片"] },
        tickets: [{ id: "new-1", title: "剪辑初稿", spec: "", status: ticketStatus, worker }],
        message_ticket: "new-1",
      });
    }
    return JSON.stringify({ decision: "continue", plan: payload.current_plan?.spec ?? {}, tickets: [] });
  };
}

describe("进度询问", () => {
  test("group: a status question posts one status line, calls no organizer, no judgement, and does not redirect the live turn", async () => {
    const h = await harness(newPlanAnswer("视频导演"));
    const director = h.store.createBot({ name: "视频导演", duties: "剪辑", boundaries: "" }).bot;
    const storyboard = h.store.createBot({ name: "分镜师", duties: "分镜", boundaries: "" }).bot;
    const group = h.store.createGroup({ name: "视频组", members: [director.id, storyboard.id] });

    const trigger = h.store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "@视频导演 做一个预告片" });
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    const live = await until(() => h.store.listLiveTurns({ sessionId: group.id })[0]);
    expect(live.bot_id).toBe(director.id);
    expect(live.status).toBe("running");
    const organizeBefore = h.organizeCalls();
    const judgeBefore = h.judgeCalls();
    const messagesBefore = h.store.listMessages(group.id).items.length;

    const status = h.store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "怎么样了" });
    await h.engine.handleInboundMessage(status, { fromUser: true });

    // No organizer call, no judgement, and the live turn is untouched — same id, still running.
    expect(h.organizeCalls()).toBe(organizeBefore);
    expect(h.judgeCalls()).toBe(judgeBefore);
    const liveAfter = h.store.getTurn(live.id);
    expect(liveAfter.status).toBe("running");
    expect(h.store.listLiveTurns({ sessionId: group.id }).map((t) => t.id)).toEqual([live.id]);

    // Exactly one new message besides the status question itself: the status line, posted as a
    // `system` line.
    const after = h.store.listMessages(group.id).items;
    expect(after.length).toBe(messagesBefore + 2);
    const note = after.find((m) => m.id !== status.id && m.created_at >= status.created_at)!;
    expect(note.kind).toBe("system");
    expect(note.body).toContain("这件事：剪出预告片");
    expect(note.body).toContain("正在做");
    expect(note.body).toContain("视频导演");
    expect(note.body).toContain("任务 01《剪辑初稿》");
  });

  test("direct: a status question does not fork a second turn beside the busy one", async () => {
    const h = await harness(newPlanAnswer("视频导演"));
    const director = h.store.createBot({ name: "视频导演", duties: "剪辑", boundaries: "" });
    const session = director.direct_session.id;

    const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "做一个预告片" });
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    const live = await until(() => h.store.listLiveTurns({ sessionId: session })[0]);
    const organizeBefore = h.organizeCalls();

    const status = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "how's it going" });
    await h.engine.handleInboundMessage(status, { fromUser: true });

    expect(h.organizeCalls()).toBe(organizeBefore);
    expect(h.store.listLiveTurns({ sessionId: session }).map((t) => t.id)).toEqual([live.id]);
    expect(h.store.getTurn(live.id).status).toBe("running");
  });

  test("nothing running and a ticket still to do: the question answers and calls nobody back", async () => {
    // It used to call the plan back here, so asking about a job you had stopped set it going again.
    const h = await harness(newPlanAnswer("文案"));
    const writer = h.store.createBot({ name: "文案", duties: "写", boundaries: "" });
    const session = writer.direct_session.id;
    const plan = h.store.openTask({ sessionId: session, title: "写一份周报" });
    h.store.createTicket({ taskId: plan.id, title: "初稿", status: "todo", worker: writer.bot.id });

    const status = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "进度呢" });
    await h.engine.handleInboundMessage(status, { fromUser: true });

    const note = h.store.listMessages(session).items.find((m) => m.kind === "system")!;
    expect(note.body).toContain("现在没有人在做。");
    expect(note.body).toContain("- 01《初稿》待做");
    expect(note.body).not.toContain("已叫");
    expect(h.store.lastPlanNudge(plan.id)).toBeNull();
    expect(h.store.db.query(`SELECT id FROM turns`).all()).toEqual([]);
    expect(h.seen).toEqual([]);
  });

  test("a turn held up on you and a booked check-back are named, not counted as working", async () => {
    const h = await harness(newPlanAnswer("研究员"));
    const researcher = h.store.createBot({ name: "研究员", duties: "查资料", boundaries: "" });
    const session = researcher.direct_session.id;
    const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "调研三个分发渠道" });
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    const turn = await until(() => h.store.listLiveTurns({ sessionId: session })[0]);
    h.store.scheduleCheckBack({ botId: researcher.bot.id, sessionId: session, turnId: turn.id, note: "核对 Writer 有没有交初稿", afterMinutes: 30 });
    h.store.insertApproval({ turnId: turn.id, messageId: null, kind_key: "outside-read", summary: "读取 ~/Downloads/渠道报价.pdf", target: "/Users/x/Downloads/渠道报价.pdf" });
    h.store.db.run(`UPDATE turns SET status = 'waiting_approval' WHERE id = ?`, [turn.id]);

    const status = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "怎么样了" });
    await h.engine.handleInboundMessage(status, { fromUser: true });
    const note = await until(() => h.store.listMessages(session).items.find((m) => m.kind === "system" && m.body.includes("等你处理")));
    expect(note.body).toContain("- 研究员 · 批准：读取 ~/Downloads/渠道报价.pdf");
    expect(note.body).not.toContain("正在做");
    expect(note.body).not.toContain("现在没有人在做");
    expect(note.body).toContain("约好回来看");
    expect(note.body).toMatch(/- 研究员 · (29|30) 分钟后 · 核对 Writer 有没有交初稿/);
  });

  test("a non-status line takes the normal path: an unmentioned continuation calls the organizer", async () => {
    const h = await harness(newPlanAnswer("视频导演"));
    const director = h.store.createBot({ name: "视频导演", duties: "剪辑", boundaries: "" }).bot;
    const storyboard = h.store.createBot({ name: "分镜师", duties: "分镜", boundaries: "" }).bot;
    const group = h.store.createGroup({ name: "视频组", members: [director.id, storyboard.id] });

    const trigger = h.store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "@视频导演 做一个预告片" });
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    await until(() => h.store.listLiveTurns({ sessionId: group.id })[0]);
    const organizeBefore = h.organizeCalls();

    const follow = h.store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "继续做" });
    await h.engine.handleInboundMessage(follow, { fromUser: true });
    await until(() => h.organizeCalls() > organizeBefore);
    expect(h.organizeCalls()).toBeGreaterThan(organizeBefore);

    const mentioned = h.store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "@视频导演 怎么样了" });
    const before2 = h.organizeCalls();
    await h.engine.handleInboundMessage(mentioned, { fromUser: true });
    await until(() => h.organizeCalls() > before2);
    expect(h.organizeCalls()).toBeGreaterThan(before2);
  });

  test("the status line never enters the next turn's context window", async () => {
    const h = await harness(newPlanAnswer("视频导演"));
    const director = h.store.createBot({ name: "视频导演", duties: "剪辑", boundaries: "" }).bot;
    const storyboard = h.store.createBot({ name: "分镜师", duties: "分镜", boundaries: "" }).bot;
    const group = h.store.createGroup({ name: "视频组", members: [director.id, storyboard.id] });

    const trigger = h.store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "@视频导演 做一个预告片" });
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    await until(() => h.store.listLiveTurns({ sessionId: group.id })[0]);

    const status = h.store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "怎么样了" });
    await h.engine.handleInboundMessage(status, { fromUser: true });
    const note = await until(() =>
      h.store.listMessages(group.id).items.find((m) => m.kind === "system" && m.body.includes("这件事：")),
    );

    // A fresh turn for the other Bot reads the transcript window; the status line is not in it.
    const seenBefore = h.seen.length;
    const mentioned = h.store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "@分镜师 出个分镜" });
    await h.engine.handleInboundMessage(mentioned, { fromUser: true });
    await until(() => h.seen.length > seenBefore);
    const transcript = h.seen[h.seen.length - 1]!;
    expect(transcript.some((m) => textOf(m).includes(note.body))).toBe(false);
    expect(transcript.some((m) => textOf(m).includes("这件事：剪出预告片"))).toBe(false);

    // Not hidden from the plain listing (search/UI/unread) though — only from Bot context.
    expect(h.store.listMessages(group.id).items.map((m) => m.id)).toContain(note.id);
    expect(h.store.taskMessagesSince(h.store.sessionCurrentTask(group.id)!.id, "1970-01-01T00:00:00.000Z").map((m) => m.id)).not.toContain(
      note.id,
    );
  });

  test("locale en: the status line reads in English", async () => {
    const h = await harness(newPlanAnswer("Director"), undefined, "en");
    const director = h.store.createBot({ name: "Director", duties: "edit", boundaries: "" });
    const session = director.direct_session.id;

    const trigger = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "cut a trailer" });
    await h.engine.handleInboundMessage(trigger, { fromUser: true });
    await until(() => h.store.listLiveTurns({ sessionId: session })[0]);

    const status = h.store.insertMessage({ sessionId: session, kind: "user", author: USER_MEMBER, body: "status" });
    await h.engine.handleInboundMessage(status, { fromUser: true });
    const note = await until(() => h.store.listMessages(session).items.find((m) => m.kind === "system"));
    expect(note.body).toContain("Plan: 剪出预告片 (active)");
    expect(note.body).toContain("Working now");
    expect(note.body).toContain("Director");
  });
});
