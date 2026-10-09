/**
 * Lines of yours sent one after another (连发, ADR 0063): each is read, filed and routed after the one
 * before it, so the first opens the turn and the next is heard in it; a stop goes ahead of them all;
 * a line stuck on its reading holds the next one up only so long; and a line changed while it
 * waited, or after a turn read it, reaches the Bot as it now reads.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@real-bot/protocol";
import type { CompletionOk, CompletionRequest, JudgeResult, ToolCall } from "./completions";
import { memoryKeyStore } from "./secrets";
import { READ_USER_LINE_SYSTEM } from "./prompts/reader";
import { userLineAnswerByRules } from "./test-kit/reading-by-rules";
import { Store } from "./store";
import { createTurnEngine, type TurnEngine } from "./turn-engine";

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function call(...toolCalls: ToolCall[]): CompletionOk {
  return { ok: true, content: "", toolCalls, finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null };
}

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

type Gate = { wait: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

async function harness(opts: {
  intakeCapMs?: number;
  /** Called with the line each reading of a line reads (`said`): await here to hold that reading up. */
  reading?: (said: string) => Promise<void> | void;
  complete?: (request: CompletionRequest, seen: CompletionRequest[]) => Promise<CompletionOk> | CompletionOk;
  betweenCalls?: (engine: TurnEngine, store: Store) => Promise<void> | void;
  gates?: Gate[];
}) {
  const root = mkdtempSync(join(tmpdir(), "line-order-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  store.raiseEngineLevel(null);
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const session = director.direct_session.id;
  const seen: CompletionRequest[] = [];
  let engineRef: TurnEngine | null = null;
  const engine = createTurnEngine({
    store,
    settleQuietMs: 20,
    publish() {},
    intakeCapMs: opts.intakeCapMs ?? 5_000,
    readerTimeoutMs: 10_000,
    ...(opts.betweenCalls ? { betweenCalls: async () => { await opts.betweenCalls!(engineRef!, store); } } : {}),
    completions: {
      async complete(request) {
        seen.push(request);
        return opts.complete ? opts.complete(request, seen) : say("好的");
      },
      async judge(request) {
        await opts.reading?.(saidIn(request.messages));
        // A reading of your line comes back as a model's (ADR 0070: nothing is carried out on the word lists').
        const system = request.messages.find((row) => row.role === "system")?.content;
        if (system !== READ_USER_LINE_SYSTEM) return judged("");
        const payload = request.messages.filter((row) => row.role === "user").at(-1)?.content;
        return judged(userLineAnswerByRules(store, typeof payload === "string" ? JSON.parse(payload) : null));
      },
    },
  });
  engineRef = engine;
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "http://127.0.0.1:1/v1",
    endpoint_api_key: "fixture",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
  });
  closes.push(async () => {
    for (const held of opts.gates ?? []) held.open();
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const line = (body: string): Message => store.insertMessage({ sessionId: session, kind: "user", author: "user", body });
  return { store, engine, session, bot: director.bot, seen, line };
}

/** The line a reading reads: its payload's `said`, not the lines around it it also carries. */
function saidIn(messages: ReadonlyArray<{ role: string; content?: unknown }>): string {
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    try {
      const payload = JSON.parse(message.content) as { said?: unknown };
      if (typeof payload.said === "string") return payload.said;
    } catch {
      // not a reading's payload
    }
  }
  return "";
}

/** Polls until `ready` holds, for up to `ms`. */
async function until(ready: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

function turnsOf(store: Store, sessionId: string) {
  return store.db
    .query<{ id: string; trigger_message_id: string; mode: string | null }, [string]>(
      `SELECT id, trigger_message_id, mode FROM turns WHERE session_id = ? ORDER BY created_at, id`,
    )
    .all(sessionId);
}

test("a line sent while the one before it is still being read is heard by the turn that one opens", async () => {
  const readingFirst = gate();
  const working = gate();
  let heldUp = false;
  const h = await harness({
    gates: [readingFirst, working],
    async reading(said) {
      if (said === "先出第一版") {
        heldUp = true;
        await readingFirst.wait;
      }
    },
    async complete(_request, seen) {
      if (seen.length === 1) await working.wait;
      return say("好的");
    },
  });
  const first = h.line("先出第一版");
  const firstDone = h.engine.handleInboundMessage(first, { fromUser: true });
  const second = h.line("片尾加字幕");
  const secondDone = h.engine.handleInboundMessage(second, { fromUser: true });
  await until(() => heldUp);
  // The second line's own reading has nothing holding it up; it waits for the first all the same.
  await Bun.sleep(80);
  expect(turnsOf(h.store, h.session)).toEqual([]);

  readingFirst.open();
  await firstDone;
  await secondDone;
  const turns = turnsOf(h.store, h.session);
  expect(turns.map((turn) => turn.trigger_message_id)).toEqual([first.id]);
  const heard = h.store.db
    .query<{ turn_id: string | null; state: string; body_snapshot: string }, [string]>(`SELECT turn_id, state, body_snapshot FROM inbox_items WHERE message_id = ?`)
    .all(second.id);
  expect(heard).toEqual([{ turn_id: turns[0]!.id, state: "queued", body_snapshot: "片尾加字幕" }]);
});

test("a line that is only a stop goes ahead of a line still being read, and stays as you said it", async () => {
  const readingFirst = gate();
  let heldUp = false;
  const h = await harness({
    gates: [readingFirst],
    async reading(said) {
      if (said === "先出第一版") {
        heldUp = true;
        await readingFirst.wait;
      }
    },
  });
  const first = h.line("先出第一版");
  const firstDone = h.engine.handleInboundMessage(first, { fromUser: true });
  await until(() => heldUp);
  const stop = h.line("停下");
  await h.engine.handleInboundMessage(stop, { fromUser: true });
  expect(h.store.getMessage(stop.id).taken_as).toBe("app");
  expect(h.store.listHolds({ inForce: true }).length).toBeGreaterThan(0);
  readingFirst.open();
  await firstDone;
});

test("a line stuck on its reading holds the next one up only for the ceiling", async () => {
  const readingFirst = gate();
  let heldUp = false;
  const h = await harness({
    intakeCapMs: 60,
    gates: [readingFirst],
    async reading(said) {
      if (said === "先出第一版") {
        heldUp = true;
        await readingFirst.wait;
      }
    },
  });
  const first = h.line("先出第一版");
  const firstDone = h.engine.handleInboundMessage(first, { fromUser: true });
  await until(() => heldUp);
  const second = h.line("片尾加字幕");
  await h.engine.handleInboundMessage(second, { fromUser: true });
  expect(turnsOf(h.store, h.session)[0]?.trigger_message_id).toBe(second.id);
  readingFirst.open();
  await firstDone;
});

test("a line changed while it waited is read and routed as it now reads", async () => {
  const readingFirst = gate();
  const working = gate();
  let heldUp = false;
  const h = await harness({
    gates: [readingFirst, working],
    async reading(said) {
      if (said === "先出第一版") {
        heldUp = true;
        await readingFirst.wait;
      }
    },
    async complete(_request, seen) {
      if (seen.length === 1) await working.wait;
      return say("好的");
    },
  });
  const first = h.line("先出第一版");
  const firstDone = h.engine.handleInboundMessage(first, { fromUser: true });
  await until(() => heldUp);
  const second = h.store.postMessage(h.session, { body: "片尾加字幕" });
  const secondDone = h.engine.handleInboundMessage(second, { fromUser: true });
  const result = h.store.editMessage(second.id, { body: "片尾加双语字幕", userActionId: "while-waiting" });
  h.engine.noteEdited(result);
  // Nobody had it yet: nobody is told of a change.
  expect(result.told).toBe(0);
  readingFirst.open();
  await firstDone;
  await secondDone;
  const heard = h.store.db
    .query<{ body_snapshot: string; edit_id: string | null }, [string]>(`SELECT body_snapshot, edit_id FROM inbox_items WHERE message_id = ?`)
    .all(second.id);
  expect(heard).toEqual([{ body_snapshot: "片尾加双语字幕", edit_id: null }]);
});

test("a line changed after its turn read it reaches that turn at its next step, new words first", async () => {
  let edited = false;
  const h = await harness({
    async betweenCalls(engine, store) {
      if (edited) return;
      edited = true;
      const trigger = store.db.query<{ id: string }, []>(`SELECT trigger_message_id AS id FROM turns ORDER BY created_at LIMIT 1`).get()!;
      engine.noteEdited(store.editMessage(trigger.id, { body: "先写三份", userActionId: "after-read" }));
    },
    complete(_request, seen) {
      // Two calls: the change lands between them, and the second waits for the next step.
      if (seen.length === 1) {
        return call(
          { id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "first" }) },
          { id: "c2", name: "write_file", arguments: JSON.stringify({ path: "b.md", content: "second" }) },
        );
      }
      return say("好的");
    },
  });
  const first = h.store.postMessage(h.session, { body: "先写两份" });
  await h.engine.handleInboundMessage(first, { fromUser: true });
  await until(() => h.seen.length >= 2);
  const loop = JSON.stringify(h.seen[1]!.messages);
  expect(loop).toContain("你改了这句。现在是：「先写三份」（原来是：「先写两份」）");
  expect(loop).toContain("（发出后改过）");
});

test("a line changed before the working turn read it is read in its new words, with no note of the change", async () => {
  const working = gate();
  const h = await harness({
    gates: [working],
    async complete(_request, seen) {
      // The first step is still going when the line comes in, and goes on to a second one.
      if (seen.length === 1) {
        await working.wait;
        return call({ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "first" }) });
      }
      return say("好的");
    },
  });
  const first = h.store.postMessage(h.session, { body: "先出第一版" });
  await h.engine.handleInboundMessage(first, { fromUser: true });
  await until(() => h.seen.length === 1);
  // Heard while the turn works: queued in its inbox, and in the turn's own copy of it.
  const second = h.store.postMessage(h.session, { body: "片尾加字幕" });
  await h.engine.handleInboundMessage(second, { fromUser: true });
  const result = h.store.editMessage(second.id, { body: "片尾加双语字幕", userActionId: "before-read" });
  h.engine.noteEdited(result);
  expect(result.told).toBe(0);
  working.open();
  await until(() => h.seen.length >= 2);
  // What the turn was told came in, at the top of its next step: the line as it now reads.
  const notes = h.seen[1]!.messages
    .filter((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("收件"))
    .map((message) => message.content as string);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("片尾加双语字幕");
  expect(notes[0]).not.toContain("片尾加字幕");
  expect(notes[0]).not.toContain("你改了这句");
});
