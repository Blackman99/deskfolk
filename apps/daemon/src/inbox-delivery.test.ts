/**
 * A line of yours that arrives while a Bot works (ADR 0040 P4a): it is a row in the turn's inbox,
 * and when it asks for a change the calls still waiting in that hop do not run.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionOk, CompletionRequest, CompletionResult, JudgeResult, ToolCall } from "./completions";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function call(...toolCalls: ToolCall[]): CompletionOk {
  return { ok: true, content: "", toolCalls, finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null };
}

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

test("a change that arrives between tool calls defers the calls still waiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-delivery-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: CompletionRequest[] = [];
  const bot = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const session = bot.direct_session.id;
  let sent = false;
  const engine = createTurnEngine({
    store,
    settleQuietMs: 20,
    publish() {},
    // After the first call returns, one line of yours arrives before the second is looked at.
    async betweenCalls() {
      if (sent) return;
      sent = true;
      const line = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "第二份先别写" });
      await engine.handleInboundMessage(line, { fromUser: true });
    },
    completions: {
      async complete(request) {
        seen.push(request);
        if (seen.length === 1) {
          return call(
            { id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "first" }) },
            { id: "c2", name: "write_file", arguments: JSON.stringify({ path: "b.md", content: "second" }) },
          );
        }
        return call({ id: "c3", name: "end_turn", arguments: JSON.stringify({ inbox: [{ id: "U1", disposition: "adopted" }] }) });
      },
      async judge() {
        return judged("");
      },
    },
  });
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "http://127.0.0.1:1/v1",
    endpoint_api_key: "fixture",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
  });
  closes.push(async () => {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const trigger = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "先写两份" });
  await engine.handleInboundMessage(trigger, { fromUser: true });
  await Bun.sleep(100);

  expect(await Bun.file(join(root, "a.md")).text()).toBe("first");
  expect(await Bun.file(join(root, "b.md")).exists()).toBe(false);
  const note = seen[1]?.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  expect(note).toContain("第二份先别写");
  expect(note).toContain("收件 1 条");
});

/** An engine whose model is `complete`, on a fresh workspace, and a direct with one Bot. */
async function engineWith(complete: (request: CompletionRequest) => Promise<CompletionResult>) {
  const root = mkdtempSync(join(tmpdir(), "inbox-delivery-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const bot = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const session = bot.direct_session.id;
  const engine = createTurnEngine({
    store,
    settleQuietMs: 20,
    publish() {},
    completions: { complete, async judge() { return judged(""); } },
  });
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "http://127.0.0.1:1/v1",
    endpoint_api_key: "fixture",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
  });
  closes.push(async () => {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const say = async (body: string) => {
    const line = store.insertMessage({ sessionId: session, kind: "user", author: "user", body });
    await engine.handleInboundMessage(line, { fromUser: true });
    return line;
  };
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      if (store.db.query(`SELECT 1 FROM turns WHERE status IN ('running', 'waiting_ask', 'waiting_approval')`).get() === null) return;
      await Bun.sleep(10);
    }
    throw new Error("the turn never ended");
  };
  return { store, engine, root, session, say, settled };
}

/** The model's next step, held until the step is cut: what a long completion looks like from here. */
function hangUntilCut(request: CompletionRequest): Promise<CompletionResult> {
  return new Promise((resolve) => {
    // Only this call ends: the turn's own signal is the same object on every hop, and stays whole.
    expect(request.signal.aborted).toBe(false);
    request.cut!.addEventListener("abort", () => resolve({ ok: false, failKind: "unreachable", hadChoices: false, usage: null, missingReason: null } as CompletionResult), { once: true });
  });
}

function userNotes(request: CompletionRequest | undefined): string {
  return (request?.messages ?? []).filter((message) => message.role === "user").map((message) => String(message.content ?? "")).join("\n");
}

test("直接插入 on the app's own loop: the completion in flight is dropped and the next hop reads the line", async () => {
  const seen: CompletionRequest[] = [];
  let inFlight!: () => void;
  const secondHop = new Promise<void>((resolve) => { inFlight = resolve; });
  const h = await engineWith(async (request) => {
    seen.push(request);
    if (seen.length === 1) return call({ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "first" }) });
    if (seen.length === 2) {
      inFlight();
      return hangUntilCut(request);
    }
    return call({ id: "c3", name: "end_turn", arguments: JSON.stringify({ inbox: [{ id: "U1", disposition: "adopted" }] }) });
  });
  await h.say("先写一份");
  await secondHop;
  const line = await h.say("换成竖版");
  expect(h.store.getMessage(line.id).delivery?.state).toBe("queued");

  expect(h.engine.insertNow(line.id)).toBe(1);
  await h.settled();

  expect(seen).toHaveLength(3);
  expect(userNotes(seen[2])).toContain("换成竖版");
  expect(h.store.getMessage(line.id).delivery?.state).toBe("adopted");
  const turn = h.store.db.query<{ status: string }, []>(`SELECT status FROM turns`).get();
  expect(turn?.status).toBe("completed");
});

test("a line taken back while the Bot works is never read, and opens no turn when this one ends", async () => {
  const seen: CompletionRequest[] = [];
  let inFlight!: () => void;
  const secondHop = new Promise<void>((resolve) => { inFlight = resolve; });
  let finish!: (result: CompletionResult) => void;
  const h = await engineWith(async (request) => {
    seen.push(request);
    if (seen.length === 1) return call({ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "first" }) });
    if (seen.length === 2) {
      inFlight();
      return new Promise<CompletionResult>((resolve) => { finish = resolve; });
    }
    return call({ id: "c3", name: "end_turn", arguments: JSON.stringify({}) });
  });
  await h.say("先写一份");
  await secondHop;
  const line = await h.say("第二份先别写");
  expect(h.store.getMessage(line.id).delivery?.state).toBe("queued");

  const result = h.store.withdrawMessage(line.id, { userActionId: "withdraw" });
  h.engine.noteWithdrawn(line.id);
  expect(result.withdrawn).toBe(1);
  finish(call({ id: "c2", name: "write_file", arguments: JSON.stringify({ path: "b.md", content: "second" }) }));
  await h.settled();
  await Bun.sleep(50);

  expect(seen.length).toBeGreaterThanOrEqual(3);
  for (const request of seen.slice(2)) expect(JSON.stringify(request.messages)).not.toContain("第二份先别写");
  // b.md was written: nothing postponed the calls for a line that is no longer there.
  expect(await Bun.file(join(h.root, "b.md")).exists()).toBe(true);
  const turns = h.store.db.query<{ trigger_message_id: string }, []>(`SELECT trigger_message_id FROM turns`).all();
  expect(turns).toHaveLength(1);
  expect(h.store.getMessage(line.id).delivery?.state).toBe("withdrawn");
});

test("a stop that lands as the line is read now holds it for the lift: it is not left waiting for a step that never reads it", async () => {
  const seen: CompletionRequest[] = [];
  let inFlight!: () => void;
  const secondHop = new Promise<void>((resolve) => { inFlight = resolve; });
  const h = await engineWith(async (request) => {
    seen.push(request);
    if (seen.length === 1) return call({ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "first" }) });
    if (seen.length === 2) {
      inFlight();
      return hangUntilCut(request);
    }
    return call({ id: "c3", name: "end_turn", arguments: JSON.stringify({}) });
  });
  await h.say("先写一份");
  await secondHop;
  // Stops come with a later engine level: raised once the turn is at work, so it opened as the others here.
  h.store.raiseEngineLevel(null);
  const turn = h.store.db.query<{ id: string; bot_id: string }, []>(`SELECT id, bot_id FROM turns WHERE status = 'running'`).get()!;
  const line = h.store.insertMessage({ sessionId: h.session, kind: "user", author: "user", body: "换成竖版" });
  h.store.queueInboxItem({ botId: turn.bot_id, sessionId: h.session, turnId: turn.id, taskId: null, ticketId: null, messageId: line.id,
    author: "user", body: line.body, source: "user", kind: "change", priority: 1 });
  expect(h.store.getMessage(line.id).delivery?.state).toBe("queued");
  // Pressed, and a stop on the Bot made in the same moment, before the cut hop goes on.
  expect(h.engine.insertNow(line.id)).toBe(1);
  h.engine.createHold({ scope: "bot", scopeId: turn.bot_id, action: "pause" });
  await h.settled();
  // The stopped turn's end puts what it never read to the holds, once it has unwound.
  for (let i = 0; i < 100 && h.store.getMessage(line.id).delivery?.state === "queued"; i++) await Bun.sleep(10);
  expect(h.store.getMessage(line.id).delivery?.state).toBe("held");
  for (const request of seen.slice(2)) expect(JSON.stringify(request.messages)).not.toContain("换成竖版");
});
