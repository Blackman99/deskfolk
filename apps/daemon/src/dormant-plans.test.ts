/**
 * A plan set aside (休眠, ADR 0040): its conversation was cleared or deleted, and what you said of it
 * is kept. Nothing is filed into it, nobody is called back into it and nothing pending for it fires,
 * until something of yours takes it up again: a line or an answer filed under it from any
 * conversation, or an edit of it on the board.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionOk, CompletionsClient, JudgeRequest, JudgeResult } from "./completions";
import { createPlanWatch } from "./engine/plan-watch";
import { createLocalApi } from "./local-api";
import { createOrganizer } from "./organizer";
import { ORGANIZER_SYSTEM, type OrganizerPayload } from "./prompts/organizer";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import type { PlanSpec } from "./store/plan-shape";
import { createTurnEngine } from "./turn-engine";

const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

function spec(over: Partial<PlanSpec> = {}): PlanSpec {
  return {
    kind: "视频",
    goal: "EP01 动画成片",
    acceptance: ["母带交到 deliverables/"],
    rules: ["不用冻帧补时长"],
    process: [],
    progress: { done: [], open: ["母带"], blocked: [] },
    status: "active",
    ...over,
  };
}

function setAside(store: Store, taskId: string): void {
  store.db.run(`UPDATE tasks SET dormant_since = ?1, closed_at = COALESCE(closed_at, ?1) WHERE id = ?2`, [new Date().toISOString(), taskId]);
}

/** The organizer alone over a real store, answering from `answers` in order (the same shape as organizer.test.ts). */
function bareOrganizer(answers: Array<JudgeResult | (() => JudgeResult)>, extra: { checks?: { beforeSettle: (taskId: string) => Promise<void>; afterSettle: (taskId: string) => Promise<void> }; onQuiet?: (taskId: string) => void; settleQuietMs?: number } = {}) {
  const store = new Store();
  const requests: JudgeRequest[] = [];
  const lines: string[] = [];
  const completions = {
    async complete() {
      throw new Error("the organizer never streams");
    },
    async judge(request: JudgeRequest) {
      requests.push(request);
      const next = answers.shift();
      if (!next) throw new Error("no answer scripted");
      return typeof next === "function" ? next() : next;
    },
  } as unknown as CompletionsClient;
  const organizer = createOrganizer({
    store,
    completions,
    routing: async () => ({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture", apiFormat: "openai", providerId: "p", providerName: "fixture", model: "fixture", thinkingLevel: null }),
    recordSpend: () => null,
    draining: () => false,
    log: (line) => lines.push(line),
    ...extra,
  });
  closes.push(() => {
    organizer.clearTimers();
    store.close();
  });
  return { store, organizer, requests, lines };
}

/** A plan in the Writer's direct with a ticket in progress and a handover since its last version: a settle has something to file. */
function quietPlan(store: Store) {
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = writer.direct_session.id;
  const plan = store.openTask({ sessionId: session, title: "写一份周报", spec: spec({ goal: "写一份周报" }) });
  const ticket = store.createTicket({ taskId: plan.id, title: "初稿", spec: "写出第一版", status: "doing", worker: writer.bot.id });
  const opener = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报" });
  const turn = store.createTurn({ sessionId: session, botId: writer.bot.id, triggerMessageId: opener.id, taskId: plan.id, ticketId: ticket.id });
  store.recordSpecRevision({ taskId: plan.id, spec: spec({ goal: "写一份周报" }), actor: "app" });
  store.insertMessage({ sessionId: session, turnId: turn.id, kind: "bot", author: writer.bot.id, body: "初稿在 draft.md", paths: [`${ticket.dir}/draft.md`] });
  store.setTurnStatus(turn.id, "completed");
  return { writer: writer.bot, session, plan, ticket, turn: store.getTurn(turn.id) };
}

describe("nothing is filed into a plan set aside", () => {
  test("its settle makes no organizer call; one set aside while its settle is out files nothing", async () => {
    const answers: Array<JudgeResult | (() => JudgeResult)> = [];
    const h = bareOrganizer(answers);
    const { plan } = quietPlan(h.store);
    setAside(h.store, plan.id);
    expect(await h.organizer.settlePlan(plan.id)).toBe(false);
    expect(h.requests).toHaveLength(0);

    // Awake again, the settle goes out; its conversation is cleared while the call is out.
    h.store.db.run(`UPDATE tasks SET dormant_since = NULL, closed_at = NULL WHERE id = ?`, [plan.id]);
    const revisions = h.store.listSpecRevisions(plan.id).length;
    answers.push(() => {
      setAside(h.store, plan.id);
      return judged(JSON.stringify({ decision: "continue", plan: spec({ goal: "写一份周报", progress: { done: ["初稿"], open: [], blocked: [] } }), tickets: [] }));
    });
    expect(await h.organizer.settlePlan(plan.id)).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(h.store.listSpecRevisions(plan.id)).toHaveLength(revisions);
    expect(h.lines).toEqual([`[organizer] plan ${plan.id}: set aside while it was being settled; nothing filed`]);
    expect(h.store.organizerRunsForTask(plan.id)[0]).toMatchObject({ applied: false, reject_reason: "the plan was set aside while it was being settled" });
  });

  test("its quiet stretch runs no check and no settle", async () => {
    const ran: string[] = [];
    const quiet: string[] = [];
    const h = bareOrganizer([], {
      settleQuietMs: 10,
      checks: { beforeSettle: async (id) => void ran.push(`before ${id}`), afterSettle: async (id) => void ran.push(`after ${id}`) },
      onQuiet: (id) => quiet.push(id),
    });
    const { plan, turn } = quietPlan(h.store);
    setAside(h.store, plan.id);
    h.organizer.noteTurnEnded(turn);
    await until(() => quiet.length > 0);
    expect(ran).toEqual([]);
    expect(h.requests).toHaveLength(0);
  });

  test("forgetting a plan drops the settle its last turn armed", async () => {
    const quiet: string[] = [];
    const h = bareOrganizer([], { settleQuietMs: 20, onQuiet: (id) => quiet.push(id) });
    const { plan, turn } = quietPlan(h.store);
    h.organizer.noteTurnEnded(turn);
    h.organizer.forgetPlan(plan.id);
    await Bun.sleep(120);
    expect(h.requests).toHaveLength(0);
    expect(quiet).toEqual([]);
  });

  test("nobody is called back into it, open tickets and all", () => {
    const store = new Store();
    const fired: string[] = [];
    const planWatch = createPlanWatch({
      store,
      admission: undefined,
      renderMirrors: () => {},
      fireCheckBack: (id) => {
        fired.push(id);
        store.claimCheckBack(id);
        return null;
      },
    });
    const root = mkdtempSync(join(tmpdir(), "dormant-watch-"));
    store.patchSettingsSync({ workspace_path: root });
    closes.push(() => {
      planWatch.clearTimers();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const { plan } = quietPlan(store);
    setAside(store, plan.id);
    planWatch.reconcilePlan(plan.id);
    expect(fired).toEqual([]);
    expect(store.db.query(`SELECT id FROM check_backs WHERE task_id = ?`).all(plan.id)).toEqual([]);

    // The same plan awake is called back: the reconcile had something to do.
    store.db.run(`UPDATE tasks SET dormant_since = NULL WHERE id = ?`, [plan.id]);
    planWatch.reconcilePlan(plan.id);
    expect(fired).toHaveLength(1);
  });
});

describe("clearing a conversation drops what was pending for its plans", () => {
  test("a settle pending when the conversation is cleared never fires into it", async () => {
    const root = mkdtempSync(join(tmpdir(), "dormant-engine-"));
    const store = new Store({ endpointKey: memoryKeyStore() });
    const organized: OrganizerPayload[] = [];
    const completed: string[] = [];
    const engine = createTurnEngine({
      store,
      settleQuietMs: 150,
      planLeftQuietMs: 30,
      publish(event) {
        if (event.event === "turn.upsert" && event.status === "completed") completed.push(event.id);
      },
      completions: {
        async complete() {
          return say("初稿在 draft.md");
        },
        async judge(request: JudgeRequest) {
          if (request.messages[0]?.content === ORGANIZER_SYSTEM) {
            const payload = JSON.parse(String(request.messages[1]!.content)) as OrganizerPayload;
            organized.push(payload);
            return judged(
              JSON.stringify({
                decision: payload.mode === "message" ? "new" : "continue",
                plan: spec({ goal: "写一份周报" }),
                // A ticket still in progress: once the quiet runs out, the reconcile would call its worker back.
                tickets: payload.mode === "message" ? [{ id: "new-1", title: "初稿", status: "doing", worker: "Writer" }] : [],
              }),
            );
          }
          return judged('{"none":true}');
        },
      } as unknown as CompletionsClient,
    });
    await store.patchSettings({ workspace_path: root, endpoint_base_url: "http://127.0.0.1:1/v1", endpoint_api_key: "fixture", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
    closes.push(async () => {
      await engine.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const direct = writer.direct_session.id;
    // A line of yours: kept as your words, so its plan outlives the clear.
    const line = store.postMessage(direct, { body: "写一份周报" });
    await engine.handleInboundMessage(line, { fromUser: true });
    await until(() => completed.length === 1);
    const plan = store.sessionCurrentTask(direct)!;
    expect(organized.map((payload) => payload.mode)).toEqual(["message"]);
    expect(store.listTickets(plan.id).map((ticket) => [ticket.status, ticket.worker])).toEqual([["doing", writer.bot.id]]);

    // Inside the settle's quiet, the conversation is cleared, as the clear routes do it.
    const dormant = store.clearSessionMessages(direct);
    expect(dormant).toEqual([plan.id]);
    engine.forgetPlans(dormant);
    await Bun.sleep(400);

    expect(organized.map((payload) => payload.mode)).toEqual(["message"]);
    expect(store.listMessages(direct).items).toEqual([]);
    expect(store.db.query(`SELECT id FROM check_backs WHERE task_id = ?`).all(plan.id)).toEqual([]);
    expect(store.getTask(plan.id).dormant_since).toBeString();
  });

  test("the clear and delete routes hand the plans they set aside to the engine", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const api = createLocalApi({ store, token: "t", schedule: false });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
    closes.push(async () => {
      await api.engine.close();
      store.close();
      await server.stop(true);
    });
    const forgot = spyOn(api.engine, "forgetPlans");
    const send = (method: string, path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { Authorization: "Bearer t" } });
    const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
    const reviewer = store.createBot({ name: "审片员", duties: "审片", boundaries: "none" });
    const planIn = (sessionId: string, body: string): string => {
      const said = store.postMessage(sessionId, { body });
      const turn = store.createTurn({ sessionId, botId: director.bot.id, triggerMessageId: said.id });
      store.setTurnStatus(turn.id, "completed");
      return store.getTurn(turn.id).task_id!;
    };
    const direct = director.direct_session.id;
    const first = planIn(direct, "片头 5 秒");
    expect((await send("POST", `/v1/sessions/${direct}/clear`)).status).toBe(204);
    expect(forgot).toHaveBeenLastCalledWith([first]);
    const second = planIn(direct, "片尾 3 秒");
    expect((await send("DELETE", `/v1/sessions/${direct}/messages`)).status).toBe(204);
    expect(forgot).toHaveBeenLastCalledWith([second]);
    const group = store.createGroup({ name: "片场", members: [director.bot.id, reviewer.bot.id] });
    const third = planIn(group.id, "EP01 开工");
    expect((await send("DELETE", `/v1/sessions/${group.id}`)).status).toBe(204);
    expect(forgot).toHaveBeenLastCalledWith([third]);
    expect(store.getTask(third)).toMatchObject({ session_id: null, dormant_since: expect.any(String), closed_at: expect.any(String) });
  });
});

describe("taking a plan set aside up again", () => {
  /** 视频导演 and 审片员 in a group whose plan was set aside by a clear, and your direct with 视频导演. */
  function asleep() {
    const store = new Store();
    const root = mkdtempSync(join(tmpdir(), "dormant-board-"));
    store.patchSettingsSync({ workspace_path: root });
    closes.push(() => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
    const reviewer = store.createBot({ name: "审片员", duties: "审片", boundaries: "none" });
    const room = store.createGroup({ name: "片场", members: [director.bot.id, reviewer.bot.id] });
    const said = store.postMessage(room.id, { body: "EP01 开工" });
    const turn = store.createTurn({ sessionId: room.id, botId: director.bot.id, triggerMessageId: said.id });
    store.setTurnStatus(turn.id, "completed");
    const planId = store.getTurn(turn.id).task_id!;
    store.setPlanSpecByUser(planId, spec());
    const ticket = store.createTicket({ taskId: planId, title: "母带", status: "doing", worker: director.bot.id });
    store.clearSessionMessages(room.id);
    expect(store.getTask(planId).dormant_since).toBeString();
    return { store, director: director.bot, room: room.id, direct: director.direct_session.id, planId, ticket };
  }

  test("a line of yours filed under it from another conversation wakes it, and leaves it out of its conversation's slot", () => {
    const { store, direct, planId } = asleep();
    const line = store.postMessage(direct, { body: "EP01 的母带再压一下时长" });
    expect(store.getTask(planId).dormant_since).toBeString();
    // Filed there the way the organizer files a join, or a turn named into the plan does.
    store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [planId, line.id]);
    expect(store.getTask(planId)).toMatchObject({ dormant_since: null, closed_at: expect.any(String) });
  });

  test("an answer of yours to a question asked in it wakes it", () => {
    const { store, director, direct, planId } = asleep();
    const opener = store.insertMessage({ sessionId: direct, kind: "user", author: "user", body: "继续" });
    const turn = store.createTurn({ sessionId: direct, botId: director.id, triggerMessageId: opener.id, taskId: planId });
    const ask = store.insertMessage({ sessionId: direct, turnId: turn.id, kind: "ask", author: director.id, body: "片头多长？", ask: { options: [{ label: "5 秒" }], multi_select: false } });
    // A Bot's turn working in it keeps it asleep.
    expect(store.getTask(planId).dormant_since).toBeString();
    store.recordAskAnswer(ask.id, { selected: ["5 秒"], custom: "", answered_at: new Date().toISOString() });
    expect(store.getTask(planId).dormant_since).toBeNull();
  });

  test("words that are not a line of yours, or were erased, leave it asleep", () => {
    const { store, direct, planId } = asleep();
    const bot = store.insertMessage({ sessionId: direct, kind: "user", author: "user", body: "别的事" });
    // No quote was kept for this line (written the way engine tests write lines): nothing to wake it.
    store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [planId, bot.id]);
    expect(store.getTask(planId).dormant_since).toBeString();
    const erased = store.postMessage(direct, { body: "抹掉的话" });
    store.db.run(`UPDATE user_quotes SET body = '', redacted_at = ? WHERE message_id = ?`, [new Date().toISOString(), erased.id]);
    store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [planId, erased.id]);
    expect(store.getTask(planId).dormant_since).toBeString();
  });

  test("the organizer filing a line of your direct into it (a join) wakes it", async () => {
    const answers: Array<JudgeResult | (() => JudgeResult)> = [];
    const h = bareOrganizer(answers);
    const director = h.store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
    const reviewer = h.store.createBot({ name: "审片员", duties: "审片", boundaries: "none" });
    const room = h.store.createGroup({ name: "片场", members: [director.bot.id, reviewer.bot.id] });
    const said = h.store.postMessage(room.id, { body: "EP01 开工" });
    const turn = h.store.createTurn({ sessionId: room.id, botId: director.bot.id, triggerMessageId: said.id });
    h.store.setTurnStatus(turn.id, "completed");
    const planId = h.store.getTurn(turn.id).task_id!;
    h.store.createTicket({ taskId: planId, title: "母带", status: "doing", worker: director.bot.id });
    h.store.clearSessionMessages(room.id);
    expect(h.store.getTask(planId).dormant_since).toBeString();
    // The group has taken up something else since, so filing EP01 does not put it back in the group's slot.
    const other = h.store.openTask({ sessionId: room.id, title: "EP02", spec: spec({ goal: "EP02" }) });

    const line = h.store.postMessage(director.direct_session.id, { body: "EP01 的母带再压一下时长" });
    answers.push(judged(JSON.stringify({ decision: "join", join_plan_id: planId, plan: spec(), tickets: [] })));
    expect(await h.organizer.organizeMessage(line)).toMatchObject({ taskId: planId });
    expect(h.store.getTask(planId)).toMatchObject({ dormant_since: null, closed_at: expect.any(String) });
    expect(h.store.sessionCurrentTask(room.id)?.id).toBe(other.id);
  });

  test("any edit of it on the board wakes it; a save in progress puts it back in its conversation's slot only when that is free", () => {
    const { store, room, planId, ticket } = asleep();
    // A save that changes nothing on a ticket, or a check added, is no edit of the plan.
    store.patchTicketByUser(ticket.id, { title: ticket.title });
    store.createCheckByUser(planId, { item: "母带交到 deliverables/", kind: "exists", path: "deliverables/EP01.mp4" });
    expect(store.getTask(planId).dormant_since).toBeString();
    // A ticket edit wakes it; its slot stays as it was.
    store.patchTicketByUser(ticket.id, { status: "review" });
    expect(store.getTask(planId)).toMatchObject({ dormant_since: null, closed_at: expect.any(String) });

    // Asleep again, and the conversation has a plan of its own now: a spec save wakes it but leaves the slot alone.
    store.clearSessionMessages(room);
    expect(store.getTask(planId).dormant_since).toBeString();
    const other = store.openTask({ sessionId: room, title: "EP02", spec: spec({ goal: "EP02" }) });
    store.setPlanSpecByUser(planId, spec({ rules: ["不用冻帧补时长", "机械臂是左手"] }));
    expect(store.getTask(planId)).toMatchObject({ dormant_since: null, closed_at: expect.any(String) });
    expect(store.sessionCurrentTask(room)?.id).toBe(other.id);
  });
});
