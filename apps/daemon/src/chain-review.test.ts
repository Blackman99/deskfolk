import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEvent } from "@real-bot/protocol";
import type { ChatMessage, CompletionOk, CompletionsClient, JudgeResult } from "./completions";
import { ROUTE_LEARN_SYSTEM, ROUTE_REVIEW_SYSTEM } from "./prompts/routing";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function call(name: string, args: Record<string, unknown>): CompletionOk {
  return { ok: true, content: "", toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }], finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null };
}

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function answer(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

function textOf(message: ChatMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

async function until<T>(read: () => T | undefined | null | false, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = read();
    if (value) return value;
    await Bun.sleep(5);
  }
  throw new Error("timed out");
}

const REVIEW = '{"fault":"model","direction":"stronger","rounds":1,"confidence":0.9,"reason":"没找到文件就交了"}';

/**
 * A Writer in its direct with you, on a quiet window of `quietMs`. The first turn fails a
 * read_file and then answers, but only once `release()` is called; later turns answer at once.
 * Every judge call is kept with its system prompt and payload.
 */
function harness(quietMs: number) {
  const root = mkdtempSync(join(tmpdir(), "bot-chain-review-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const shown: ClientEvent[] = [];
  const judged: { system: string; payload: Record<string, unknown> }[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completions: CompletionsClient = {
    async complete(request) {
      const trigger = textOf(request.messages.find((m) => m.role === "user" && textOf(m).includes("（本轮触发）")));
      if (!trigger.includes("写一份周报")) return say("好，我改。");
      if (!request.messages.some((m) => m.role === "tool")) return call("read_file", { path: "missing-notes.md" });
      await released;
      return say("周报写好了。");
    },
    async judge(request) {
      const system = textOf(request.messages[0]);
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(textOf(request.messages[1])) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      judged.push({ system, payload });
      return answer(system === ROUTE_REVIEW_SYSTEM ? REVIEW : "{}");
    },
  };
  const engineWith = (chainQuietMs: number) =>
    createTurnEngine({
      store,
      chainQuietMs,
      publish(event) {
        shown.push(event);
      },
      completions,
    });
  let engine = engineWith(quietMs);
  const setup = async () => {
    await store.patchSettings({ workspace_path: root, endpoint_base_url: "http://127.0.0.1:1/v1", endpoint_api_key: "fixture", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
    return store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  };
  const send = async (sessionId: string, body: string) => {
    const message = store.insertMessage({ sessionId, kind: "user", author: "user", body });
    await engine.handleInboundMessage(message, { fromUser: true });
  };
  const completedTurns = () =>
    shown.filter((e) => e.event === "turn.upsert" && e.status === "completed").length;
  const reviews = () =>
    store.db.query<{ chain_id: string; fault: string; created_at: string }, []>(`SELECT chain_id, fault, created_at FROM route_reviews`).all();
  /** A daemon restart: this process's timers die with it, and the next one sweeps on start. */
  const restart = async (chainQuietMs: number) => {
    await engine.close();
    engine = engineWith(chainQuietMs);
    engine.sweepStaleChains();
  };
  const cleanup = async () => {
    release();
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { store, judged, release, setup, send, completedTurns, reviews, restart, cleanup };
}

/**
 * The quiet clock used to start when a turn started. A turn longer than the window was then
 * reviewed while it still ran — no outcome, no counts, so it closed as "nothing to see" — and
 * whatever you said about it afterwards landed on a chain that was already closed.
 */
test("a chain is not reviewed while its turn runs; the quiet clock starts when the turn ends", async () => {
  const h = harness(40);
  try {
    const writer = await h.setup();
    await h.send(writer.direct_session.id, "写一份周报");
    await until(() => h.store.listLiveTurns().length > 0);

    // Well past the window, and the turn is still working: nothing is reviewed yet.
    await Bun.sleep(200);
    expect(h.store.listLiveTurns()).toHaveLength(1);
    expect(h.reviews()).toEqual([]);

    h.release();
    await until(() => h.completedTurns() === 1);
    const finished = h.store.db
      .query<{ finished_at: string }, []>(`SELECT finished_at FROM turn_route_decisions`)
      .get()!.finished_at;
    const [review] = await until(() => (h.reviews().length === 1 ? h.reviews() : null));
    expect(review!.created_at > finished).toBe(true);
  } finally {
    await h.cleanup();
  }
});

test("what you say right after a long turn reaches its review, and the learning hop reads the failed call", async () => {
  const h = harness(60);
  try {
    const writer = await h.setup();
    const session = writer.direct_session.id;
    await h.send(session, "写一份周报");
    await until(() => h.store.listLiveTurns().length > 0);
    await Bun.sleep(200);
    h.release();
    await until(() => h.completedTurns() === 1);

    // The turn kept the call that failed, for whoever reads the chain later.
    const row = h.store.db
      .query<{ tool_errors: number; tool_failures: string }, []>(`SELECT tool_errors, tool_failures FROM turn_route_decisions`)
      .get()!;
    expect(row.tool_errors).toBe(1);
    const kept = JSON.parse(row.tool_failures) as { tool: string; target: string | null; error: string }[];
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ tool: "read_file", target: "missing-notes.md" });
    expect(kept[0]!.error.length).toBeGreaterThan(0);

    await h.send(session, "不对，笔记在 notes/ 下面");
    const review = await until(() => h.judged.find((row) => row.system === ROUTE_REVIEW_SYSTEM));
    expect(review.payload.follow_ups).toEqual(["不对，笔记在 notes/ 下面"]);

    const learn = await until(() => h.judged.find((row) => row.system === ROUTE_LEARN_SYSTEM));
    const chain = learn.payload.chain as { failures: unknown[]; follow_ups: string[] };
    expect(chain.follow_ups).toEqual(["不对，笔记在 notes/ 下面"]);
    expect(chain.failures).toEqual(kept);
  } finally {
    await h.cleanup();
  }
});

/**
 * A restart marks the turns it cut off as ended just then, so their chains are not quiet yet when
 * the sweep runs — and the timers that would have closed them died with the old process.
 */
test("a chain that was not quiet yet when the daemon restarted gets its clock back", async () => {
  const h = harness(60_000);
  try {
    const writer = await h.setup();
    h.release();
    await h.send(writer.direct_session.id, "写一份周报");
    await until(() => h.completedTurns() === 1);
    expect(h.reviews()).toEqual([]);

    await h.restart(40);
    await until(() => h.reviews().length === 1);
  } finally {
    await h.cleanup();
  }
});
