/**
 * 读句 read by your own Claude Code (ADR 0055, ADR 0061): the reader sends the same payload and
 * prompt it sends an endpoint, takes the answer from Claude's call, bills it as the reader's own
 * line with no endpoint, and falls back to the word lists with a code of its own when Claude
 * cannot read. Never a real `claude`: the call is a fake.
 */
import { afterEach, expect, test } from "bun:test";
import type { ClaudeJudge, ClaudeReadingAnswer } from "./claude-code/reading";
import type { CompletionsClient } from "./completions";
import { READ_USER_LINE_SYSTEM, type UserLinePayload } from "./prompts/reader";
import { createReader } from "./reader";
import { Store } from "./store";

const stores: Store[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

const STOP = JSON.stringify({ control: "stop", control_only: true, status_only: false, objections: [] });
const USAGE = { inputTokens: 120, outputTokens: 30, cachedTokens: 100, costUsd: 0.0004 };

function harness(answer: (input: Parameters<ClaudeJudge>[0]) => ClaudeReadingAnswer | Promise<ClaudeReadingAnswer>, opts: { judge?: boolean; timeoutMs?: number } = {}) {
  const store = new Store();
  stores.push(store);
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const direct = director.direct_session.id;
  const inputs: Array<Parameters<ClaudeJudge>[0]> = [];
  const endpointCalls: unknown[] = [];
  const claudeSpent: Array<{ sessionId: string; model: string; usage: unknown }> = [];
  const completions: CompletionsClient = {
    complete: () => Promise.reject(new Error("no turns here")),
    judge: async (request) => {
      endpointCalls.push(request);
      throw new Error("the endpoint must not be called");
    },
  };
  const reader = createReader({
    store,
    completions,
    routing: async () => ({ kind: "claude_code", model: "haiku", configDir: "/opt/claude-b" }),
    recordSpend: () => endpointCalls.push("endpoint spend"),
    ...(opts.judge === false ? {} : {
      claudeJudge: async (input) => {
        inputs.push(input);
        return answer(input);
      },
    }),
    recordClaudeSpend: (input) => void claudeSpent.push(input),
    draining: () => false,
    log: () => {},
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const answers = () => store.db.query<{ payload: string }, []>(`SELECT payload FROM work_events WHERE kind = 'reader.answer' ORDER BY seq`).all()
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  return { store, direct, reader, inputs, endpointCalls, claudeSpent, answers };
}

test("a line is read by Claude with the prompt and payload an endpoint would get, and billed with no endpoint", async () => {
  const h = harness(() => ({ content: STOP, usage: USAGE, fail: null }));
  const line = h.store.postMessage(h.direct, { body: "先别搞了，收手吧" });
  const reading = await h.reader.userLine(line);
  expect(reading).toEqual({ source: "model", control: "stop", controlOnly: true, statusOnly: false, objections: [] });
  expect(h.endpointCalls).toEqual([]);
  expect(h.inputs).toHaveLength(1);
  expect(h.inputs[0]!.target).toEqual({ kind: "claude_code", model: "haiku", configDir: "/opt/claude-b" });
  expect(h.inputs[0]!.system).toBe(READ_USER_LINE_SYSTEM);
  expect(JSON.parse(h.inputs[0]!.prompt as string) as UserLinePayload).toMatchObject({ said: line.body, where: "direct" });
  expect(h.claudeSpent).toEqual([{ sessionId: h.direct, model: "haiku", usage: USAGE }]);
  expect(h.answers()).toEqual([{ read: "user_line", message_id: line.id, source: "model", model: "haiku", fail: null, reading, raw: STOP }]);
});

test("Claude Code not installed or signed out: the word lists read, as claude_unavailable, with the model named", async () => {
  const h = harness(() => ({ content: null, usage: null, fail: "claude_unavailable" }));
  const line = h.store.postMessage(h.direct, { body: "先别搞了，收手吧" });
  expect((await h.reader.userLine(line)).source).toBe("words");
  expect(h.answers()).toMatchObject([{ source: "words", model: "haiku", fail: "claude_unavailable", raw: null }]);
  expect(h.claudeSpent).toEqual([]);

  // No way to call Claude at all reads the same.
  const none = harness(() => { throw new Error("unused"); }, { judge: false });
  await none.reader.userLine(none.store.postMessage(none.direct, { body: "停一下" }));
  expect(none.answers()).toMatchObject([{ source: "words", model: "haiku", fail: "claude_unavailable" }]);
});

test("a Claude error, an answer that is no reading and a reading past its time each fall back: claude_failed, unreadable, timeout", async () => {
  const failed = harness(() => ({ content: null, usage: USAGE, fail: "claude_failed" }));
  expect((await failed.reader.userLine(failed.store.postMessage(failed.direct, { body: "停一下" }))).source).toBe("words");
  expect(failed.answers()).toMatchObject([{ fail: "claude_failed", model: "haiku" }]);
  // What it spent before failing is still spent.
  expect(failed.claudeSpent).toHaveLength(1);

  const threw = harness(() => { throw new Error("boom"); });
  await threw.reader.userLine(threw.store.postMessage(threw.direct, { body: "停一下" }));
  expect(threw.answers()).toMatchObject([{ fail: "claude_failed" }]);

  const unreadable = harness(() => ({ content: "I think they want to stop.", usage: USAGE, fail: null }));
  await unreadable.reader.userLine(unreadable.store.postMessage(unreadable.direct, { body: "停一下" }));
  expect(unreadable.answers()).toMatchObject([{ fail: "unreadable", raw: "I think they want to stop." }]);

  const slow = harness((input) => new Promise((resolve) => input.signal.addEventListener("abort", () => resolve({ content: null, usage: null, fail: "claude_failed" }))), { timeoutMs: 30 });
  await slow.reader.userLine(slow.store.postMessage(slow.direct, { body: "停一下" }));
  expect(slow.answers()).toMatchObject([{ source: "words", fail: "timeout", model: "haiku" }]);
});
