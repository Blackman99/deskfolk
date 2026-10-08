import { describe, expect, test } from "bun:test";
import { createCompletionsClient } from "./completions";
import { continueNote } from "./hop-limits";
import { createTurnEngine } from "./turn-engine";
import { createWriter, jsonAuth as auth, registerLocalApiCleanup, sse, subscribe, waitFor } from "./test-kit/local-api-harness";
import type { WakeWatch } from "./wake";
import { startApi, startFixture, textChunks } from "./test-kit/engine-fixtures";

registerLocalApiCleanup();

describe("turn engine on the local API", () => {
  test("continuing an interrupted turn prefixes the next system prompt with 上次断了", async () => {
    let systems: string[] = [];
    const fixture = await startFixture(({ body }) => {
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      systems.push(system);
      return sse(textChunks("picked up"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const trigger = h.store.postMessage(sessionId, { body: "go" });
    const cut = h.store.createTurn({
      sessionId,
      botId,
      triggerMessageId: trigger.id,
    });
    h.store.interruptRunningTurns();
    const note = h.store
      .listMainMessages(sessionId, 10)
      .find((m) => m.kind === "system" && m.body === "中断");
    expect(note?.id).toBeString();
    const sub = await subscribe(h);
    const continued = await fetch(`${h.origin}/v1/turns/continue`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ message_id: note!.id }),
    });
    expect(continued.status).toBe(200);
    await waitFor(sub.events, (e) => e.event === "message.created" && e.kind === "bot");
    expect(systems.some((text) => text.startsWith("上次断了（工具没有重试）。"))).toBe(true);
    expect(h.store.getTurn(cut.id).status).toBe("interrupted");
    sub.close();
  });

  test("continuing an unreachable turn from 这一轮没写完：连不上端点 resumes and finishes", async () => {
    let callCount = 0;
    const client: import("./completions").CompletionsClient = {
      async complete() {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            failKind: "unreachable",
            hadChoices: false,
            usage: null,
            missingReason: null,
          };
        }
        return {
          ok: true,
          content: "resumed reply after reconnection",
          toolCalls: [],
          finishReason: "stop",
          hadChoices: true,
          usage: null,
          missingReason: null,
        };
      },
      async judge() {
        return {
          content: null,
          toolCalls: [],
          hadToolCalls: false,
          usage: null,
          failKind: "unreachable",
        };
      },
    };
    const h = await startApi(undefined, { completions: client });
    const { botId, sessionId } = await createWriter(h, "https://mock.invalid");
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "do task" }),
    });
    const sys = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "system" && e.author === botId,
    );
    expect(sys.body).toBe("这一轮没写完：连不上端点");
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");

    const continued = await fetch(`${h.origin}/v1/turns/continue`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ message_id: sys.id }),
    });
    expect(continued.status).toBe(200);
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId,
    );
    expect(botMsg.body).toBe("resumed reply after reconnection");
    sub.close();
  });

  test("a 400 completion inserts a locale-zh system line and completes the turn", async () => {
    const fixture = await startFixture(() => new Response("nope", { status: 400 }));
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    const sys = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "system" && e.author === botId,
    );
    expect(sys.body).toBe("这一轮没写完：端点拒绝了这次补全");
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(sub.events.some((e) => e.kind === "bot")).toBe(false);
    sub.close();
  });

  /**
   * The hop loop runs detached. A throw inside it used to vanish into a swallowed rejection and
   * leave the row at `running`: Thinking in the sidebar until the next boot, and nothing said.
   */
  test("a hop that throws closes the turn instead of leaving it running", async () => {
    const fixture = await startFixture(() => sse(textChunks("unused")));
    const h = await startApi(undefined, {
      completions: {
        complete: () => Promise.reject(new Error("boom")),
        judge: () => Promise.reject(new Error("boom")),
      },
    });
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    const sys = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "system" && e.author === botId,
    );
    expect(sys.body).toBe("这一轮没写完：运行时出错");
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(h.store.listLiveTurns({ sessionId })).toEqual([]);
    sub.close();
  });

  test("the stale sweep closes a turn that stopped making progress", async () => {
    const fixture = await startFixture(() => sse(textChunks("unused")));
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const trigger = h.store.postMessage(sessionId, { body: "go" });
    // Straight to the store: a wedged turn is exactly one with a row and no loop behind it.
    const wedged = h.store.createTurn({ sessionId, botId, triggerMessageId: trigger.id });
    const sub = await subscribe(h);

    h.engine.sweepStalledTurns(new Date(Date.now() + 60_000));
    expect(h.store.getTurn(wedged.id).status).toBe("running");

    h.engine.sweepStalledTurns(new Date(Date.now() + 21 * 60_000));
    const sys = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "system" && e.author === botId,
    );
    expect(sys.body).toBe("这一轮没写完：卡住了，很久没有任何进展");
    expect(h.store.getTurn(wedged.id).status).toBe("completed");
    sub.close();
  });

  test("the stale sweep does not count time the Mac spent asleep", async () => {
    const fixture = await startFixture(() => sse(textChunks("unused")));
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const trigger = h.store.postMessage(sessionId, { body: "go" });
    const frozen = h.store.createTurn({ sessionId, botId, triggerMessageId: trigger.id });
    let slept = 0;
    const wake: WakeWatch = {
      sleptBetween: () => slept,
      settled: () => true,
      untilSettled: async () => true,
      awakeTimeout: () => () => {},
      stop: () => {},
    };
    const engine = createTurnEngine({ store: h.store, publish: () => {}, wake });
    try {
      const later = new Date(Date.now() + 45 * 60_000);
      // The lid was shut for 40 of those 45 minutes: the turn was frozen, not stuck.
      slept = 40 * 60_000;
      engine.sweepStalledTurns(later);
      expect(h.store.getTurn(frozen.id).status).toBe("running");
      // Awake for 25 of them with nothing happening is stuck, sleep or no sleep.
      slept = 20 * 60_000;
      engine.sweepStalledTurns(later);
      expect(h.store.getTurn(frozen.id).status).toBe("completed");
    } finally {
      await engine.close();
    }
  });

  test("the stale sweep leaves a turn that is waiting on you alone", async () => {
    const fixture = await startFixture(() => sse(textChunks("unused")));
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const trigger = h.store.postMessage(sessionId, { body: "go" });
    const waiting = h.store.createTurn({ sessionId, botId, triggerMessageId: trigger.id });
    h.store.setTurnStatus(waiting.id, "waiting_approval");

    h.engine.sweepStalledTurns(new Date(Date.now() + 24 * 60 * 60_000));
    expect(h.store.getTurn(waiting.id).status).toBe("waiting_approval");
  });

  test("a mid-stream stall posts none of the half reply: the hop is asked for again", async () => {
    const encoder = new TextEncoder();
    let hang: ((reason?: unknown) => void) | null = null;
    let asked = 0;
    const fixture = await startFixture(() => {
      asked += 1;
      if (asked > 1) return sse(textChunks("the whole reply"));
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (!(controller as { sent?: boolean }).sent) {
              (controller as { sent?: boolean }).sent = true;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: "chatcmpl-1",
                    choices: [{ index: 0, delta: { role: "assistant", content: "half a" }, finish_reason: null }],
                  })}\n\n`,
                ),
              );
              return;
            }
            return new Promise((_, reject) => {
              hang = reject;
            });
          },
          cancel() {
            hang?.(new Error("cancelled"));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const h = await startApi(undefined, {
      completions: createCompletionsClient({
        clock: { firstByteMs: 80, idleMs: 40 },
      }),
    });
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId,
      4000,
    );
    expect(botMsg.body).toBe("the whole reply");
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(asked).toBe(2);
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "system")).toBe(false);
    sub.close();
  });

  test("a proxy passing Gemini's own finish reasons through: MAX_TOKENS carries on, STOP is the reply", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const ending = (finish: string, text: string) => [
      { id: "chatcmpl-1", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
      { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    ];
    const fixture = await startFixture(({ body }) => {
      asked.push(body);
      return sse(asked.length === 1 ? ending("MAX_TOKENS", "第一部分写到这里") : ending("STOP", "写完了。"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    const botMsg = await waitFor(sub.events, (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId);
    expect(botMsg.body).toBe("写完了。");
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    // One continuation hop, which read the cut part and the note; the cut part itself was never posted.
    expect(asked.length).toBe(2);
    const messages = asked[1]!.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-2)).toEqual({ role: "assistant", content: "第一部分写到这里" });
    expect([continueNote("zh", false), continueNote("en", false)]).toContain(messages.at(-1)!.content);
    expect(sub.events.some((e) => e.event === "message.created" && String(e.body).includes("第一部分"))).toBe(false);
    sub.close();
  });
});
