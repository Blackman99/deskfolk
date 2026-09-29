import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionOk, JudgeResult } from "./completions";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

/** Two Bots in a Bot↔Bot direct; each hop, whoever's turn it is, answers with the next scripted reply. */
async function harness(replies: string[]) {
  const root = mkdtempSync(join(tmpdir(), "bot-direct-nods-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  let hops = 0;
  let completed = 0;
  const waiters: Array<{ count: number; wake: () => void }> = [];
  const engine = createTurnEngine({
    store,
    settleQuietMs: 20,
    publish(event) {
      if (event.event !== "turn.upsert" || event.status !== "completed") return;
      completed += 1;
      for (const waiter of waiters.filter((w) => w.count <= completed)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.wake();
      }
    },
    completions: {
      async complete() {
        hops += 1;
        return say(replies[hops - 1] ?? "");
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
  const director = store.createBot({ name: "Director", duties: "make the cuts", boundaries: "stay" }).bot.id;
  const reviewer = store.createBot({ name: "Reviewer", duties: "review the cuts", boundaries: "stay" }).bot.id;
  const direct = store.createBotDirect(director, reviewer, null).id;
  return {
    store,
    engine,
    director,
    reviewer,
    direct,
    hops: () => hops,
    completions: (count: number) => new Promise<void>((wake) => waiters.push({ count, wake })),
    lines: () =>
      store.db
        .query<{ author: string; body: string }, [string]>(
          `SELECT author, body FROM messages WHERE session_id = ? AND kind = 'bot' ORDER BY message_seq`,
        )
        .all(direct),
    /** A finished turn of `botId` that posted `body`, woken by `trigger`, optionally having run a command. */
    finishedLine(botId: string, trigger: string, body: string, ran?: string) {
      const turn = store.createTurn({ sessionId: direct, botId, triggerMessageId: trigger });
      if (ran) store.recordTurnRun({ turnId: turn.id, tool: "shell", command: ran, exitCode: 0, ok: true });
      const message = store.insertMessage({ sessionId: direct, turnId: turn.id, kind: "bot", author: botId, body });
      store.setTurnStatus(turn.id, "completed");
      return message;
    },
  };
}

/** Long enough for a turn that was going to open to have opened and answered. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/**
 * 2026-09-29: after the user stopped both, 视频导演 and 审片员 traded 「停工已对齐，本轮不发消息」 in
 * their direct every 20 s, each line waking the other. A nod to a nod is posted and wakes nobody.
 */
test("a nod answering a nod wakes nobody, so two Bots stop acknowledging each other", async () => {
  const h = await harness([
    "收到。Shot 12 不开，Shot 01–11 按现有文件封存。",
    "停工已对齐，不再回复。",
    "停工已经对齐，本轮不发消息。",
  ]);
  const opener = h.store.insertMessage({ sessionId: h.direct, kind: "bot", author: h.director, body: "@Reviewer 用户叫停了，Shot 12 不开。" });
  const both = h.completions(2);
  await h.engine.handleInboundMessage(opener, { fromUser: false });
  await both;
  await settle();
  expect(h.hops()).toBe(2);
  expect(h.lines().map((line) => line.body)).toEqual([
    "@Reviewer 用户叫停了，Shot 12 不开。",
    "收到。Shot 12 不开，Shot 01–11 按现有文件封存。",
    "停工已对齐，不再回复。",
  ]);
  expect(h.store.listLiveTurns({ sessionId: h.direct })).toEqual([]);
});

test("a nod still wakes the other Bot when the line it answers came from a turn that ran something", async () => {
  const h = await harness(["好"]);
  const opener = h.store.insertMessage({ sessionId: h.direct, kind: "bot", author: h.director, body: "Shot 11 送审" });
  const checked = h.finishedLine(h.reviewer, opener.id, "收到，Shot 11 看过了。", "ffprobe shot_11.mp4");
  const nod = h.finishedLine(h.director, checked.id, "停工已对齐。");
  const woke = h.completions(1);
  await h.engine.handleInboundMessage(nod, { fromUser: false });
  await woke;
  expect(h.hops()).toBe(1);
  expect(h.lines().at(-1)).toEqual({ author: h.reviewer, body: "好" });
});

test("a short line that asks something, names someone or cites a path still wakes the other Bot", async () => {
  for (const body of ["停工已对齐，Shot 12 要删掉吗？", "@Reviewer 停工已对齐。", "停工已对齐，母带在 shots/master.mp4"]) {
    const h = await harness(["好"]);
    const opener = h.store.insertMessage({ sessionId: h.direct, kind: "bot", author: h.director, body: "Shot 11 送审" });
    const checked = h.finishedLine(h.reviewer, opener.id, "收到，Shot 11 看过了。");
    const line = h.finishedLine(h.director, checked.id, body);
    const woke = h.completions(1);
    await h.engine.handleInboundMessage(line, { fromUser: false });
    await woke;
    expect(h.hops()).toBe(1);
  }
});

test("a nod still wakes the other Bot when the line it answers says something at length", async () => {
  const h = await harness(["好"]);
  const opener = h.store.insertMessage({ sessionId: h.direct, kind: "bot", author: h.director, body: "Shot 11 送审" });
  const verdict = "驳回重跑。".repeat(40);
  const checked = h.finishedLine(h.reviewer, opener.id, verdict);
  const nod = h.finishedLine(h.director, checked.id, "收到，重跑。");
  const woke = h.completions(1);
  await h.engine.handleInboundMessage(nod, { fromUser: false });
  await woke;
  expect(h.hops()).toBe(1);
});
