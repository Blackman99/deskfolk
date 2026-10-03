/**
 * The scribe, engine side (ADR 0040 P3): one call per filed line or answer of yours, its raw answer
 * in the work log, what survives the checks in the ledger, and with no model or a failed call only
 * the fallback capture. Lines are taken one at a time, and a stop drops what is still queued.
 */
import { afterEach, expect, test } from "bun:test";
import type { CompletionsClient, JudgeRequest, JudgeResult } from "./completions";
import type { OrganizerRouting } from "./organizer";
import { parseScribeAnswer, SCRIBE_SYSTEM, type ScribePayload } from "./prompts/scribe";
import { createScribe, SCRIBE_MAX_TOKENS } from "./scribe";
import { Store } from "./store";
import { call, createScenario, say as reply, tool, type Scenario } from "./test-kit/scenario";

const stores: Store[] = [];
const scenarios: Scenario[] = [];
afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  while (scenarios.length) await scenarios.pop()!.close();
});

const ROUTING: OrganizerRouting = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", providerId: "p", providerName: "Default", model: "scribe-model", thinkingLevel: null };

function judged(content: string | null, over: Partial<JudgeResult> = {}): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null, ...over };
}

/**
 * A plan in your direct with 视频导演 that has delivered a file, and a scribe over it whose calls
 * are answered by `answer` (a model is configured unless `routing` says otherwise).
 */
function harness(answer: (request: JudgeRequest) => JudgeResult | Promise<JudgeResult>, opts: { routing?: OrganizerRouting | null } = {}) {
  const store = new Store();
  stores.push(store);
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const direct = director.direct_session.id;
  const opener = store.postMessage(direct, { body: "做 EP01 动画成片" });
  const planId = store.createTurn({ sessionId: direct, botId: director.bot.id, triggerMessageId: opener.id }).task_id!;
  const shots = store.createTicket({ taskId: planId, title: "Shot 01–03", status: "review" });
  const requests: JudgeRequest[] = [];
  const spent: string[] = [];
  const lines: string[] = [];
  const completions: CompletionsClient = {
    complete: () => Promise.reject(new Error("no turns here")),
    judge: async (request) => {
      requests.push(request);
      return answer(request);
    },
  };
  const scribe = createScribe({
    store,
    completions,
    routing: async () => (opts.routing === undefined ? ROUTING : opts.routing),
    recordSpend: ({ sessionId }) => void spent.push(sessionId),
    draining: () => false,
    log: (line) => void lines.push(line),
  });
  /** A line of yours, filed under the plan, handed to the scribe. */
  const say = (body: string) => {
    const line = store.postMessage(direct, { body });
    store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [planId, line.id]);
    return { line, noted: scribe.noteLine(line.id, scribe.handedOverAt()), quote: store.quoteOfMessage(line.id, "message")! };
  };
  const payloadOf = (request: JudgeRequest) => JSON.parse(String(request.messages[1]!.content)) as ScribePayload;
  return { store, direct, planId, shots, scribe, requests, spent, lines, say, payloadOf };
}

test("a filed line is read against the plan's open entries; what survives lands, and the answer is logged as it came", async () => {
  const h = harness((request) => {
    const payload = JSON.parse(String(request.messages[1]!.content)) as ScribePayload;
    const arm = payload.open.find((entry) => entry.category === "角色设定");
    return judged(
      JSON.stringify({
        adds: [{ quote: "C09 的脚不能穿地", restated: "C09 脚不穿地", category: "穿模", scope_hint: "plan" }],
        raises: arm ? [{ requirement_id: arm.id, quote: "机械臂还是左手" }] : [],
        supersedes: [],
      }),
    );
  });
  const { quote: first, noted: firstNoted } = h.say("机械臂必须是左手");
  await firstNoted;
  const arm = h.store.addRequirement({ scope: "project", scopeId: h.direct, quote: "机械臂必须是左手", category: "角色设定", sourceKind: "message", sourceQuoteId: first.id, addedBy: "scribe" });
  const { noted, quote } = h.say("C09 的脚不能穿地，机械臂还是左手");
  await noted;

  const [, request] = h.requests;
  expect(request).toMatchObject({ model: "scribe-model", maxTokens: SCRIBE_MAX_TOKENS });
  expect(request!.messages[0]!.content).toBe(SCRIBE_SYSTEM);
  expect(h.payloadOf(request!)).toMatchObject({
    session: { id: h.direct },
    said: { via: "message", body: "C09 的脚不能穿地，机械臂还是左手" },
    plan: { id: h.planId, tickets: [{ id: h.shots.id, seq: 1, title: "Shot 01–03", status: "review" }] },
    open: [{ id: arm.id, category: "角色设定", quote: "机械臂必须是左手", holds_for: "project", times_raised: 1 }],
  });
  expect(h.store.getRequirement(arm.id).times_raised).toBe(2);
  expect(h.store.listRequirements({ scope: "plan", scopeId: h.planId })).toMatchObject([
    { quote: "C09 的脚不能穿地", category: "穿模", status: "open", source_quote_id: quote.id, added_by: "scribe" },
  ]);
  expect(h.store.listWorkEvents({ kind: "scribe.answer" }).at(-1)).toMatchObject({
    actor: "scribe",
    task_id: h.planId,
    session_id: h.direct,
    payload: { quote: quote.id, model: "scribe-model", fail: null, raw: expect.stringContaining("C09 的脚不能穿地") },
  });
  expect(h.spent).toEqual([h.direct, h.direct]);
});

test("with no model set it makes no call and files nothing but the fallback capture", async () => {
  const h = harness(() => judged("{}"), { routing: null });
  await h.say("前三镜背景严重跳跃，太假了").noted;
  await h.say("第四镜加一个特写").noted;
  expect(h.requests).toEqual([]);
  expect(h.store.listRequirements()).toMatchObject([{ quote: "前三镜背景严重跳跃，太假了", status: "proposed", added_by: "capture" }]);
  expect(h.store.listWorkEvents({ kind: "scribe.answer" })).toEqual([]);
});

test("a failed, cut-off, unreadable or empty answer files nothing but the fallback capture, and says which it was", async () => {
  const answers: JudgeResult[] = [
    judged(null, { failKind: "unreachable" }),
    judged('{"adds": [{"quote": "太', { truncated: true }),
    judged('{"decision": "join"}'),
    judged('{"adds": [], "raises": [], "supersedes": []}'),
    judged(JSON.stringify({ adds: [{ quote: "我没说过的话", category: "x" }] })),
  ];
  const h = harness(() => answers.shift()!);
  const said = ["镜头穿帮了", "C09 太假", "节奏不对", "有问题，重做", "不行"];
  for (const body of said) await h.say(body).noted;
  expect(h.store.listWorkEvents({ kind: "scribe.answer" }).map((row) => row.payload.fail)).toEqual(["unreachable", "truncated", "unreadable", null, null]);
  expect(h.store.listRequirements().map((row) => [row.quote, row.status, row.added_by])).toEqual(said.map((body) => [body, "proposed", "capture"]));
  expect(h.lines.filter((line) => line.endsWith("nothing filed"))).toHaveLength(3);
});

test("a complaint is judged by the job as it stood when you said it, not as the scribe finds it", async () => {
  const h = harness(() => judged(null, { failKind: "unreachable" }));
  // Said while Shot 01–03 was handed over, and sent back to doing over it before the scribe got to it.
  const sentBack = h.say("前三镜背景严重跳跃，太假了");
  h.store.patchTicket(h.shots.id, { status: "doing" });
  await sentBack.noted;
  // Said while nothing was handed over, and handed over since.
  const early = h.say("第四镜节奏不对");
  h.store.patchTicket(h.shots.id, { status: "review" });
  await early.noted;
  expect(h.store.listRequirements().map((row) => [row.quote, row.added_by])).toEqual([["前三镜背景严重跳跃，太假了", "capture"]]);
});

test("lines are taken one at a time, in order; a stop drops what is queued and the call in flight", async () => {
  const release: Array<() => void> = [];
  const h = harness(
    (request) =>
      new Promise<JudgeResult>((resolve) => {
        const body = (JSON.parse(String(request.messages[1]!.content)) as ScribePayload).said.body;
        release.push(() => resolve(judged(JSON.stringify({ adds: [{ quote: body, category: "镜头" }] }))));
        request.signal.addEventListener("abort", () => resolve(judged(null, { failKind: "unreachable" })));
      }),
  );
  const first = h.say("第一镜要夜景");
  const second = h.say("第二镜要雨");
  await Bun.sleep(10);
  expect(h.requests).toHaveLength(1);
  release.shift()!();
  await first.noted;
  await Bun.sleep(10);
  expect(h.requests).toHaveLength(2);
  const third = h.say("第三镜要雪");
  h.scribe.stop();
  await Promise.all([second.noted, third.noted]);
  expect(h.requests).toHaveLength(2);
  expect(h.store.listRequirements().map((row) => row.quote)).toEqual(["第一镜要夜景"]);
  expect(h.store.listWorkEvents({ kind: "scribe.answer" })).toHaveLength(1);
  // A stop is for a shutdown that may be called off: the next line is noted as usual.
  const fourth = h.say("第四镜要雾");
  await Bun.sleep(10);
  release.pop()!();
  await fourth.noted;
  expect(h.store.listRequirements().map((row) => row.quote)).toEqual(["第一镜要夜景", "第四镜要雾"]);
});

test("words erased while the call was out are not written; an answer to a question is read with the question", async () => {
  let erase: (() => void) | null = null;
  const h = harness((request) => {
    erase?.();
    const said = (JSON.parse(String(request.messages[1]!.content)) as ScribePayload).said;
    return judged(JSON.stringify({ adds: [{ quote: said.body.split("，")[0], category: "镜头" }] }));
  });
  const { quote, noted } = h.say("第一镜要夜景");
  // Erased once the call is out (the scribe reads the line's quote only when its turn in the queue comes).
  erase = () => h.store.db.run(`UPDATE user_quotes SET body = '', redacted_at = ? WHERE id = ?`, ["2026-01-01T00:00:00.000Z", quote.id]);
  await noted;
  expect(quote.body).toBe("第一镜要夜景");
  expect(h.store.listRequirements()).toEqual([]);

  erase = null;
  const ask = h.store.insertMessage({ sessionId: h.direct, kind: "ask", author: h.store.listBots()[0]!.id, body: "片尾要不要字幕？" });
  h.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [h.planId, ask.id]);
  h.store.recordAskAnswer(ask.id, { selected: [], custom: "片尾要加字幕，白色", answered_at: new Date().toISOString() });
  await h.scribe.noteAnswer(ask.id);
  expect(h.payloadOf(h.requests.at(-1)!).said).toMatchObject({ via: "answer", body: "片尾要加字幕，白色", asked: "片尾要不要字幕？" });
  expect(h.store.listRequirements()).toMatchObject([{ quote: "片尾要加字幕", source_kind: "ask_answer" }]);
});

test("an answer reads as a patch: lists as written, none as empty, anything else as no answer at all", () => {
  expect(parseScribeAnswer("none")).toEqual({ adds: [], raises: [], supersedes: [] });
  expect(parseScribeAnswer('{"none": true}')).toEqual({ adds: [], raises: [], supersedes: [] });
  expect(parseScribeAnswer('```json\n{"adds": [{"quote": "x"}], "raises": "no"}\n```')).toEqual({ adds: [{ quote: "x" }], raises: [], supersedes: [] });
  expect(parseScribeAnswer('{"decision": "join"}')).toBeNull();
  expect(parseScribeAnswer("我不知道")).toBeNull();
});

test("in the engine, the line's turn never waits on the scribe: it opens, works and ends while the call is still out", async () => {
  const h = await createScenario();
  scenarios.push(h);
  const [director] = h.createBots({ name: "视频导演" });
  const direct = h.direct(director!);
  let release!: () => void;
  const out = new Promise<void>((resolve) => (release = resolve));
  h.judge("organizer").reply({ decision: "new", plan: { goal: "做一部短片" }, tickets: [], message_ticket: null });
  h.judge("scribe").handle(async ({ payload }) => {
    await out;
    return { adds: [{ quote: (payload as ScribePayload).said.body.slice(-8), category: "时长" }] };
  });
  h.script(director!, direct).reply(reply("好的，我先写分镜"));
  h.postUser(direct, "做一部短片，片长约 2 分钟");
  await h.waitFor(() => h.turns(director!)[0]?.status === "completed", { what: "the turn to end" });
  expect(h.judgeCalls("scribe")).toEqual([]);
  expect(h.store.listRequirements()).toEqual([]);
  release();
  await h.waitIdle();
  expect(h.store.listRequirements()).toMatchObject([{ quote: "片长约 2 分钟", dimension: "duration", scope: "plan" }]);
});

test("in the engine, your answer to a Bot's question goes to the scribe with the question", async () => {
  const h = await createScenario();
  scenarios.push(h);
  const [director] = h.createBots({ name: "视频导演" });
  const direct = h.direct(director!);
  h.judge("organizer").reply({ decision: "new", plan: { goal: "做一部短片" }, tickets: [], message_ticket: null });
  h.judge("scribe").reply({ adds: [] }, { adds: [{ quote: "要，白色", category: "字幕" }] });
  h.script(director!, direct).reply(call(tool("ask_user", { question: "片尾要不要字幕？" })), reply("好，片尾加白色字幕"));
  h.postUser(direct, "做一部短片");
  await h.waitFor(() => h.turns(director!)[0]?.status === "waiting_ask", { what: "the question" });
  const ask = h.messages(direct).find((row) => row.kind === "ask")!;
  h.engine.replyAsk(ask.id, direct, { custom: "要，白色" });
  await h.waitIdle();
  const [, answered] = h.judgeCalls("scribe");
  expect(answered).toBeDefined();
  expect(h.store.listRequirements()).toMatchObject([{ quote: "要，白色", source_kind: "ask_answer", category: "字幕" }]);
});

test("in the engine, a complaint the filing sends a ticket back over is still judged as said about a delivered job", async () => {
  const h = await createScenario();
  scenarios.push(h);
  const [director] = h.createBots({ name: "视频导演" });
  const direct = h.direct(director!);
  h.judge("organizer").reply({ decision: "new", plan: { goal: "做一部短片" }, tickets: [], message_ticket: null });
  h.judge("scribe").reply({ adds: [] });
  h.script(director!, direct).reply(reply("好的，我先出前三镜"), reply("收到，前三镜重做"));
  h.postUser(direct, "做一部短片");
  await h.waitIdle();
  const planId = h.store.sessionCurrentTask(direct)!.id;
  const shots = h.store.createTicket({ taskId: planId, title: "Shot 01–03", status: "review" });
  // The filing reads the complaint as rework and sends the ticket back; the scribe finds nothing in it.
  h.judge("organizer").reply({
    decision: "continue",
    plan: { goal: "做一部短片" },
    tickets: [{ id: shots.id, title: shots.title, status: "doing" }],
    message_ticket: shots.id,
  });
  h.judge("scribe").reply({ adds: [] });
  h.postUser(direct, "前三镜背景严重跳跃，太假了");
  await h.waitIdle();
  expect(h.store.getTicket(shots.id).status).toBe("doing");
  expect(h.store.listRequirements()).toMatchObject([
    { quote: "前三镜背景严重跳跃，太假了", status: "proposed", added_by: "capture", scope: "ticket", scope_id: shots.id },
  ]);
});
