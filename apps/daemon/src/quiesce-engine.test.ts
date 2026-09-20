import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEvent, Routine, Turn } from "@real-bot/protocol";
import type { CompletionOk, CompletionResult, CompletionsClient, ToolCall } from "./completions";
import type { McpHost } from "./mcp-host";
import { Quiesce, TurnAdmission } from "./quiesce";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function tool(name: string, args: Record<string, unknown>): ToolCall {
  return { id: crypto.randomUUID(), name, arguments: JSON.stringify(args) };
}

function answer(toolCalls: ToolCall[] = []): CompletionOk {
  return { ok: true, content: toolCalls.length ? "" : "Finished the captured work.", toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop", hadChoices: true, usage: null, missingReason: null };
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("engine did not settle")), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(check: () => boolean): Promise<void> {
  await bounded((async () => { while (!check()) await Bun.sleep(1); })());
}

async function harness(options: { mcp?: McpHost; complete?: CompletionsClient["complete"]; judge?: CompletionsClient["judge"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "quiesce-engine-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  await store.patchSettings({ workspace_path: root, endpoint_base_url: "https://fixture.invalid/v1",
    endpoint_api_key: "fixture", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
  const created = store.createBot({ name: "Worker", duties: "finish work", boundaries: "stay local", model: "fixture" });
  const events: ClientEvent[] = [];
  const first = deferred<CompletionResult>();
  const entered = deferred<void>();
  const requests: Parameters<CompletionsClient["complete"]>[0][] = [];
  const admission = new TurnAdmission();
  const engine = createTurnEngine({ store, admission, mcp: options.mcp, publish: event => { events.push(event); },
    completions: {
      async complete(request) {
        requests.push(request);
        entered.resolve();
        if (options.complete) return options.complete(request);
        return requests.length === 1 ? first.promise : answer();
      },
      async judge(request) { return options.judge ? options.judge(request) : { content: "{}", hadToolCalls: false, usage: null, failKind: null }; },
    },
  });
  const quiesce = new Quiesce(store, engine, admission, null);
  cleanup.push(async () => {
    first.resolve(answer());
    quiesce.force();
    await bounded(engine.close());
    quiesce.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function start() {
    const trigger = store.postMessage(created.direct_session.id, { body: "Do the captured work." });
    await engine.handleInboundMessage(trigger);
    return store.listLiveTurns({ sessionId: created.direct_session.id })[0]!;
  }
  return { root, store, events, engine, admission, quiesce, created, requests, first, entered, start };
}

test("captured turns may create disabled, future and due routines or update configuration without firing during drain", async () => {
  const h = await harness();
  const schedule: Routine["schedule"] = { kind: "daily", time: "23:59" };
  const existing = h.store.createRoutine({ bot_id: h.created.bot.id, title: "Existing", instruction: "old", schedule });
  h.store.db.run("UPDATE routines SET created_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", existing.id]);
  const turn = await h.start();
  await h.entered.promise;
  expect(h.quiesce.begin()).toEqual({ phase: "draining", remaining: [turn.id], forced: false });
  h.first.resolve(answer([
    tool("create_routine", { title: "Disabled", instruction: "never", schedule, enabled: false }),
    tool("create_routine", { title: "Future", instruction: "later", schedule }),
    tool("create_routine", { title: "Due", instruction: "not yet", schedule: { kind: "daily", time: "00:00" } }),
    tool("update_routine", { id: existing.id, title: "Updated", schedule: { kind: "daily", time: "00:00" } }),
  ]));
  expect((await bounded(h.quiesce.wait())).phase).toBe("drained");
  expect(h.store.getTurn(turn.id).status).toBe("completed");
  const routines = h.store.listRoutines();
  expect(routines).toHaveLength(4);
  expect(routines.every(row => row.last_fired_for_due_at === null)).toBe(true);
  expect(routines.find(row => row.title === "Disabled")?.enabled).toBe(false);
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1]!.messages.filter(row => row.role === "tool").map(row => JSON.parse(String(row.content)).ok)).toEqual([true, true, true, true]);
  expect(() => h.engine.fireRoutine(existing.id)).toThrow("draining");
  h.quiesce.cancel();
  const fired = h.engine.fireRoutine(existing.id);
  expect(fired).not.toBeNull();
  await until(() => h.store.getTurn(fired!.id).status === "completed");
  await bounded(h.engine.close());
  expect(h.engine.unsettledTurnIds()).toEqual([]);
});

test("draining rejects a new join or handoff before persisting business changes", async () => {
  const h = await harness();
  const other = h.store.createBot({ name: "Other", duties: "help", boundaries: "stay" });
  const sessionCount = h.store.listSessions().length;
  const turn = await h.start();
  await h.entered.promise;
  h.quiesce.begin();
  h.first.resolve(answer([
    tool("create_direct", { name: other.bot.name }),
    tool("send_message", { session_id: h.created.direct_session.id, body: "@Other please take over" }),
  ]));
  await bounded(h.quiesce.wait());
  expect(h.store.listSessions()).toHaveLength(sessionCount);
  expect(h.store.listMainMessages(h.created.direct_session.id, 20).some(row => row.body.includes("please take over"))).toBe(false);
  expect(h.store.getTurn(turn.id).status).toBe("completed");
  expect(h.requests).toHaveLength(1);
});

test("force fences post-credential create_bot and every subsequent tool in the batch", async () => {
  const h = await harness();
  const original = h.store.getProvider.bind(h.store);
  const held = deferred<void>();
  const lookup = deferred<void>();
  const mock = spyOn(h.store, "getProvider").mockImplementation(async id => {
    lookup.resolve(); await held.promise; return original(id);
  });
  cleanup.push(() => { held.resolve(); mock.mockRestore(); });
  const turn = await h.start();
  await h.entered.promise;
  const args = { duties: "help", boundaries: "stay", endpoint_id: h.created.bot.provider_id, model: "fixture" };
  h.first.resolve(answer([tool("create_bot", { ...args, name: "First" }), tool("create_bot", { ...args, name: "Second" })]));
  await bounded(lookup.promise);
  expect(h.quiesce.force()).toEqual({ phase: "draining", remaining: [turn.id], forced: true });
  expect(h.store.getTurn(turn.id).status).toBe("interrupted");
  expect(h.requests[0]!.signal.aborted).toBe(true);
  held.resolve();
  expect((await bounded(h.quiesce.wait())).phase).toBe("drained");
  expect(h.store.listBots().map(row => row.name)).toEqual(["Worker"]);
  expect(mock).toHaveBeenCalledTimes(1);
  expect(h.requests).toHaveLength(1);
  expect(h.engine.unsettledTurnIds()).toEqual([]);
  await bounded(h.engine.close());
});

test("cancelling a drain wait neither forces the turn nor resumes admission", async () => {
  const h = await harness();
  const turn = await h.start();
  await h.entered.promise;
  const abort = new AbortController();
  const waiting = h.quiesce.wait(abort.signal);
  abort.abort();
  await expect(waiting).rejects.toThrow("cancelled");
  expect(h.quiesce.state()).toEqual({ phase: "draining", remaining: [turn.id], forced: false });
  expect(h.requests[0]!.signal.aborted).toBe(false);
  h.quiesce.cancel();
  expect(h.admission.draining).toBe(false);
  h.first.resolve(answer());
  await until(() => h.store.getTurn(turn.id).status === "completed");
});

test("force ignores late completions even if the model client ignores abort", async () => {
  const h = await harness();
  const turn = await h.start();
  await h.entered.promise;
  expect(h.quiesce.force().remaining).toEqual([turn.id]);
  h.first.resolve(answer([tool("remember", { subject: "late", body: "must not persist" })]));
  await bounded(h.quiesce.wait());
  expect(h.store.listMemories(h.created.bot.id)).toHaveLength(0);
  expect(h.store.getTurn(turn.id).status).toBe("interrupted");
  expect(h.requests).toHaveLength(1);
});

for (const stage of ["credentials", "completion", "emitted"] as const) {
  test(`a ${stage} runner failure releases live state and close yields to timers`, async () => {
    const h = await harness();
    let turn: Turn;
    if (stage === "credentials") {
      const mock = spyOn(h.store, "settings").mockRejectedValue(new Error("credential lookup failed"));
      cleanup.push(() => mock.mockRestore());
      turn = await h.start();
    } else {
      turn = await h.start();
      await h.entered.promise;
      if (stage === "completion") h.first.reject(new Error("completion failed"));
      else {
        const mock = spyOn(h.store, "claimRoutineDue").mockImplementation(() => { throw new Error("routine claim failed"); });
        cleanup.push(() => mock.mockRestore());
        h.first.resolve(answer([tool("create_routine", { title: "Due", instruction: "work", schedule: { kind: "daily", time: "00:00" } })]));
      }
    }
    await until(() => h.store.getTurn(turn.id).status === "completed");
    expect(h.store.listLiveTurns()).toEqual([]);
    expect(h.store.listMainMessages(h.created.direct_session.id, 20).some(row => row.kind === "system")).toBe(true);
    if (stage !== "credentials") expect(h.store.getTurnRoute(turn.id)?.outcome).toBe("failed");
    await bounded(h.engine.close());
    await Bun.sleep(1);
    expect(h.engine.unsettledTurnIds()).toEqual([]);
    expect(h.engine.partialText(turn.id)).toBeNull();
    expect(h.quiesce.begin().phase).toBe("drained");
  });
}

test("ask replies and approvals resume captured turns during graceful drain", async () => {
  const h = await harness();
  const turn = await h.start();
  await h.entered.promise;
  h.quiesce.begin();
  h.first.resolve(answer([
    tool("ask_user", { question: "Continue?" }),
    tool("add_mcp_server", { name: "Approved", command: "fixture-unused", enabled: false }),
  ]));
  await until(() => h.store.getTurn(turn.id).status === "waiting_ask");
  expect(h.quiesce.state().remaining).toEqual([turn.id]);
  const ask = h.store.listMainMessages(h.created.direct_session.id, 20).find(row => row.kind === "ask")!;
  const reply = h.store.postMessage(h.created.direct_session.id, { body: "Yes", parent_id: ask.id });
  h.engine.replyAsk(ask.id, reply);
  await until(() => h.store.getTurn(turn.id).status === "waiting_approval");
  const approval = h.store.listApprovals("pending")[0]!;
  h.engine.resolveApproval(approval.id, "allow_once");
  expect((await bounded(h.quiesce.wait())).phase).toBe("drained");
  expect(h.store.getTurn(turn.id).status).toBe("completed");
  expect(h.store.listMcpServers().map(row => row.name)).toEqual(["Approved"]);
  expect(h.requests).toHaveLength(2);
});

test("force during an approved configuration hydration prevents its write and later batch tools", async () => {
  const h = await harness();
  const turn = await h.start();
  await h.entered.promise;
  h.first.resolve(answer([
    tool("add_endpoint", { name: "Never", base_url: "https://never.invalid", models: ["fixture"] }),
    tool("create_bot", { name: "Second", duties: "help", boundaries: "stay" }),
  ]));
  await until(() => h.store.getTurn(turn.id).status === "waiting_approval");
  const approval = h.store.listApprovals("pending")[0]!;
  const original = h.store.listProviders.bind(h.store);
  const held = deferred<void>();
  const entered = deferred<void>();
  const mock = spyOn(h.store, "listProviders").mockImplementation(async () => { entered.resolve(); await held.promise; return original(); });
  cleanup.push(() => { held.resolve(); mock.mockRestore(); });
  h.engine.resolveApproval(approval.id, "allow_once", undefined, "fixture-never");
  await bounded(entered.promise);
  expect(h.quiesce.force().remaining).toEqual([turn.id]);
  await Bun.sleep(1);
  expect(h.quiesce.state().phase).toBe("draining");
  held.resolve();
  await bounded(h.quiesce.wait());
  expect(h.store.providersCached().some(row => row.name === "Never")).toBe(false);
  expect(h.store.listBots().map(row => row.name)).toEqual(["Worker"]);
  expect(h.store.getTurn(turn.id).status).toBe("interrupted");
});

test("close settles a waiting turn with interrupted semantics and voids its approval", async () => {
  const h = await harness();
  const turn = await h.start();
  await h.entered.promise;
  h.first.resolve(answer([tool("add_mcp_server", { name: "Never", command: "fixture-unused" })]));
  await until(() => h.store.getTurn(turn.id).status === "waiting_approval");
  const approval = h.store.listApprovals("pending")[0]!;
  await bounded(h.engine.close());
  expect(h.store.getTurn(turn.id).status).toBe("interrupted");
  expect(h.store.getTurnRoute(turn.id)?.outcome).toBe("interrupted");
  expect(h.store.getApproval(approval.id).status).toBe("voided");
  expect(h.store.pendingInterrupt(h.created.bot.id)).toBe(true);
  expect(h.store.listMainMessages(h.created.direct_session.id, 20).filter(row => row.kind === "system")).toHaveLength(1);
  expect(h.engine.unsettledTurnIds()).toEqual([]);
});

test("force voids a pending approval and never runs its action", async () => {
  const h = await harness();
  const turn = await h.start();
  await h.entered.promise;
  h.first.resolve(answer([tool("add_mcp_server", { name: "Never", command: "fixture-unused" })]));
  await until(() => h.store.getTurn(turn.id).status === "waiting_approval");
  const approval = h.store.listApprovals("pending")[0]!;
  h.quiesce.force();
  await bounded(h.quiesce.wait());
  expect(h.store.getApproval(approval.id).status).toBe("voided");
  expect(() => h.engine.resolveApproval(approval.id, "allow_once")).toThrow();
  expect(h.store.listMcpServers()).toEqual([]);
});

test("a pending group join is discarded during drain before persisting its judgement or turn", async () => {
  const held = deferred<Awaited<ReturnType<CompletionsClient["judge"]>>>();
  let calls = 0;
  const h = await harness({ judge: async () => { calls++; return held.promise; } });
  cleanup.push(() => held.resolve({ content: "{}", hadToolCalls: false, usage: null, failKind: null }));
  const other = h.store.createBot({ name: "Other", duties: "help", boundaries: "stay" });
  const group = h.store.createGroup({ name: "Group", members: [h.created.bot.id, other.bot.id] });
  const trigger = h.store.postMessage(group.id, { body: "Does anyone know?" });
  const pending = h.engine.handleInboundMessage(trigger);
  await until(() => calls === 2);
  h.quiesce.begin();
  held.resolve({ content: '{"decision":"join","reason":"help"}', hadToolCalls: false, usage: null, failKind: null });
  await bounded(pending);
  expect(h.store.listLiveTurns()).toEqual([]);
  expect(h.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM judgements").get()!.n).toBe(0);
  expect(h.engine.pendingJudgements()).toEqual([]);
  expect(h.requests).toHaveLength(0);
});

test("force leaves started MCP work visible until settlement and never dispatches a second call", async () => {
  const held = deferred<void>();
  const entered = deferred<void>();
  const calls: string[] = [];
  const mcp: McpHost = {
    async listChatTools() { return []; },
    async listForTurn() { return { tools: [], guides: [] }; },
    async inspect() { return { instructions: null, tools: [] }; },
    async call(name) { calls.push(name); entered.resolve(); await held.promise; return { ok: true, data: {} }; },
    async close() {},
  };
  const h = await harness({ mcp });
  cleanup.push(() => held.resolve());
  const turn = await h.start();
  await h.entered.promise;
  h.first.resolve(answer([tool("mcp_first", {}), tool("mcp_second", {})]));
  await bounded(entered.promise);
  expect(h.quiesce.force()).toEqual({ phase: "draining", remaining: [turn.id], forced: true });
  await Bun.sleep(1);
  expect(h.quiesce.state().phase).toBe("draining");
  held.resolve();
  await bounded(h.quiesce.wait());
  expect(calls).toEqual(["mcp_first"]);
});

test("force after MCP inspection starts fences its later database persistence and completion", async () => {
  const held = deferred<void>();
  const entered = deferred<void>();
  const mcp: McpHost = {
    async listChatTools() { return []; },
    async listForTurn() { return { tools: [], guides: [] }; },
    async inspect() { entered.resolve(); await held.promise; return { instructions: "late", tools: [{ name: "late", description: "late" }] }; },
    async call() { throw new Error("unexpected MCP call"); },
    async close() {},
  };
  const h = await harness({ mcp });
  cleanup.push(() => held.resolve());
  const server = await h.store.createMcpServer({ name: "Inspect", command: "fixture-unused" });
  const turn = await h.start();
  await bounded(entered.promise);
  h.quiesce.force();
  held.resolve();
  await bounded(h.quiesce.wait());
  expect(h.store.listMcpServers().find(row => row.id === server.id)?.instructions).toBeNull();
  expect(h.requests).toHaveLength(0);
  expect(h.store.getTurn(turn.id).status).toBe("interrupted");
});
