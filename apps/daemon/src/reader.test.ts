/**
 * 读句 (ADR 0055), engine side: one call per line, what it is sent, what it costs, and the work log
 * of every reading — and with no model, a failed call, a call past its time or an answer that is no
 * reading, the word lists' reading instead, said so in the log.
 */
import { afterEach, expect, test } from "bun:test";
import type { CompletionsClient, JudgeRequest, JudgeResult } from "./completions";
import type { OrganizerRouting } from "./organizer";
import { READ_BOT_LINE_SYSTEM, READ_USER_LINE_SYSTEM, type UserLinePayload } from "./prompts/reader";
import { createReader, READER_MAX_TOKENS, type ReaderDeps } from "./reader";
import { Store } from "./store";

const stores: Store[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

const ROUTING: OrganizerRouting = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", providerId: "p", providerName: "Default", model: "reader-model", thinkingLevel: null };

function judged(content: string | null, over: Partial<JudgeResult> = {}): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null, ...over };
}

const STOP = JSON.stringify({ control: "stop", control_only: true, status_only: false, objections: [] });

/** Your direct with 视频导演, and a reader whose calls `answer` answers (a model is set unless `routing` says otherwise). */
function harness(answer: (request: JudgeRequest) => JudgeResult | Promise<JudgeResult>, opts: Partial<Pick<ReaderDeps, "timeoutMs" | "ablation">> & { routing?: OrganizerRouting | null } = {}) {
  const store = new Store();
  stores.push(store);
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const direct = director.direct_session.id;
  const requests: JudgeRequest[] = [];
  const spent: Array<{ sessionId: string; responded: boolean }> = [];
  const logged: string[] = [];
  const completions: CompletionsClient = {
    complete: () => Promise.reject(new Error("no turns here")),
    judge: async (request) => {
      requests.push(request);
      return answer(request);
    },
  };
  const reader = createReader({
    store,
    completions,
    routing: async () => (opts.routing === undefined ? ROUTING : opts.routing),
    recordSpend: ({ sessionId, responded }) => void spent.push({ sessionId, responded }),
    draining: () => false,
    log: (line) => void logged.push(line),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.ablation ? { ablation: opts.ablation } : {}),
  });
  const answers = () => store.db.query<{ payload: string }, []>(`SELECT payload FROM work_events WHERE kind = 'reader.answer' ORDER BY seq`).all()
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  return { store, director, direct, reader, requests, spent, logged, answers };
}

test("a line of yours is read once, with the line it answers and the few before it, on its own lane", async () => {
  const h = harness(() => judged(STOP));
  h.store.postMessage(h.direct, { body: "先做第二集的分镜" });
  const bot = h.store.insertMessage({ sessionId: h.direct, kind: "bot", author: h.director.bot.id, body: "好的，第二集分镜在做" });
  const line = h.store.postMessage(h.direct, { body: "先别搞了，收手吧", parent_id: bot.id });
  const reading = await h.reader.userLine(line);
  expect(reading).toEqual({ source: "model", control: "stop", controlOnly: true, statusOnly: false, objections: [] });
  // Asked again, by the status answer or the rework card: no second call.
  expect(await h.reader.userLine(line)).toBe(reading);
  expect(h.requests).toHaveLength(1);
  const request = h.requests[0]!;
  expect(request.messages[0]!.content).toBe(READ_USER_LINE_SYSTEM);
  expect(request).toMatchObject({ lane: "reading", maxTokens: READER_MAX_TOKENS, model: "reader-model" });
  const payload = JSON.parse(String(request.messages[1]!.content)) as UserLinePayload;
  expect(payload).toEqual({
    said: line.body,
    where: "direct",
    replying_to: { author: "视频导演", text: "好的，第二集分镜在做" },
    recent: [{ author: "user", text: "先做第二集的分镜" }, { author: "视频导演", text: "好的，第二集分镜在做" }],
  });
  expect(h.spent).toEqual([{ sessionId: h.direct, responded: true }]);
  expect(h.answers()).toEqual([{ read: "user_line", message_id: line.id, source: "model", model: "reader-model", fail: null, reading, raw: STOP }]);
});

test("only a line shaped like a status question reads as one, whatever the model made of its words", async () => {
  const answer = JSON.stringify({ control: "none", control_only: false, status_only: true, objections: [] });
  const h = harness(() => judged(answer));
  const bare = h.store.postMessage(h.direct, { body: "第二集现在推进到哪一步了" });
  const bot = h.store.insertMessage({ sessionId: h.direct, kind: "bot", author: h.director.bot.id, body: "Shot 03 交了" });
  const quoting = h.store.postMessage(h.direct, { body: "这个推进到哪一步了", parent_id: bot.id });
  expect((await h.reader.userLine(bare)).statusOnly).toBe(true);
  // A quote-reply is about what it quotes: the status answer from the rows is not what it asks.
  expect((await h.reader.userLine(quoting)).statusOnly).toBe(false);
});

test("with no model, a failed call or an answer that is no reading, the word lists read the line and the log says why", async () => {
  const none = harness(() => judged(STOP), { routing: null });
  const line = none.store.postMessage(none.direct, { body: "C07 太假了，重做" });
  expect(await none.reader.userLine(line)).toEqual({ source: "words", control: null, controlOnly: false, statusOnly: false, objections: ["C07 太假了", "重做"] });
  expect(none.requests).toHaveLength(0);
  expect(none.answers()).toMatchObject([{ source: "words", fail: "no_model", model: null }]);

  const failed = harness(() => judged(null, { failKind: "endpoint_error" }));
  const second = failed.store.postMessage(failed.direct, { body: "C07 太假了" });
  expect((await failed.reader.userLine(second)).source).toBe("words");
  expect(failed.answers()).toMatchObject([{ source: "words", fail: "endpoint_error", model: "reader-model" }]);
  expect(failed.logged.join("\n")).toContain("endpoint_error, read by the word lists");

  const odd = harness(() => judged("I think the user wants the Bots to stop."));
  const third = odd.store.postMessage(odd.direct, { body: "C07 太假了" });
  expect((await odd.reader.userLine(third)).source).toBe("words");
  expect(odd.answers()).toMatchObject([{ source: "words", fail: "unreadable", raw: "I think the user wants the Bots to stop." }]);

  const cut = harness(() => judged('{"control": "st', { truncated: true }));
  const fourth = cut.store.postMessage(cut.direct, { body: "C07 太假了" });
  expect((await cut.reader.userLine(fourth)).source).toBe("words");
  expect(cut.answers()).toMatchObject([{ fail: "truncated" }]);
});

test("a reading that takes too long, a slot included, is read by the word lists", async () => {
  const h = harness((request) => new Promise<JudgeResult>((resolve) => {
    request.signal.addEventListener("abort", () => resolve(judged(null, { failKind: "unreachable" })), { once: true });
  }), { timeoutMs: 30 });
  const line = h.store.postMessage(h.direct, { body: "停一下吧这个" });
  const reading = await h.reader.userLine(line);
  expect(reading.source).toBe("words");
  expect(h.answers()).toMatchObject([{ fail: "timeout" }]);
});

test("switched off for a benchmark, no line is read by a model", async () => {
  const h = harness(() => judged(STOP), { ablation: new Set(["reader"]) });
  const line = h.store.postMessage(h.direct, { body: "先别搞了" });
  expect((await h.reader.userLine(line)).source).toBe("words");
  expect(h.requests).toHaveLength(0);
  expect(h.answers()).toMatchObject([{ fail: "ablated" }]);
});

test("a Bot's line is read once per text, on its own, and an empty one is not read at all", async () => {
  const answer = JSON.stringify({ later: "我这边着手整理第二集的分镜脚本", claims_verified: false, no_work: false, bare_status: false });
  const h = harness(() => judged(answer));
  const body = "收到。我这边着手整理第二集的分镜脚本，弄好发群里。";
  const first = await h.reader.botLine(body, h.direct);
  const again = await h.reader.botLine(body, h.direct);
  expect(again).toBe(first);
  expect(first).toEqual({ source: "model", later: "我这边着手整理第二集的分镜脚本", claimsVerified: false, noWork: false, bareStatus: false });
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]!.messages[0]!.content).toBe(READ_BOT_LINE_SYSTEM);
  expect(JSON.parse(String(h.requests[0]!.messages[1]!.content))).toEqual({ said: body });
  expect(await h.reader.botLine("  ", h.direct)).toMatchObject({ source: "words", noWork: true });
  expect(h.requests).toHaveLength(1);
});

test("your answer to a Bot's question is read on its own, keyed by what names it", async () => {
  const answer = JSON.stringify({ control: "none", control_only: false, status_only: false, objections: ["节奏拖沓"] });
  const h = harness(() => judged(answer));
  const reading = await h.reader.userText("quote:q1", "节奏拖沓，换一版", h.direct);
  expect(reading.objections).toEqual(["节奏拖沓"]);
  await h.reader.userText("quote:q1", "节奏拖沓，换一版", h.direct);
  expect(h.requests).toHaveLength(1);
  expect(JSON.parse(String(h.requests[0]!.messages[1]!.content))).toEqual({ said: "节奏拖沓，换一版", where: "direct", recent: [] });
});

test("stopping abandons a reading in flight, which the word lists then read", async () => {
  let started!: () => void;
  const begun = new Promise<void>((resolve) => (started = resolve));
  const h = harness((request) => new Promise<JudgeResult>((resolve) => {
    started();
    request.signal.addEventListener("abort", () => resolve(judged(null, { failKind: "unreachable" })), { once: true });
  }));
  const line = h.store.postMessage(h.direct, { body: "先别搞了" });
  const reading = h.reader.userLine(line);
  await begun;
  h.reader.stop();
  expect((await reading).source).toBe("words");
  expect(h.answers()).toMatchObject([{ fail: "stopped" }]);
});
