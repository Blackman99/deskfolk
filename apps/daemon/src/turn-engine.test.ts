import { describe, expect, test } from "bun:test";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createGroupWithBots, createWriter, jsonAuth as auth, registerLocalApiCleanup, sse, subscribe, waitFor } from "./test-kit/local-api-harness";
import { isComposerSuggestRequest, isJudgementRequest, judgementPass, startApi, startFixture, textChunks, toolCallChunks } from "./test-kit/engine-fixtures";

registerLocalApiCleanup();

describe("turn engine on the local API", () => {
  test("posting in a you↔Bot direct opens a turn and inserts the final bot message without streaming tokens", async () => {
    const fixture = await startFixture(({ body }) => {
      expect(body.stream).toBe(true);
      expect(body.model).toBe("test-model");
      expect((body.stream_options as { include_usage?: boolean }).include_usage).toBe(true);
      return sse(
        textChunks("hello from writer", {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
          cost_in_usd_ticks: 42,
        }),
      );
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);

    const posted = await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "please write" }),
    });
    expect(posted.status).toBe(201);
    const userMessage = (await posted.json()) as { id: string; kind: string };
    expect(userMessage.kind).toBe("user");

    const running = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === botId,
    );
    expect(running.session_id).toBe(sessionId);
    expect(running.trigger_message_id).toBe(userMessage.id);

    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId,
    );
    expect(botMsg.body).toBe("hello from writer");
    expect(botMsg.turn_id).toBe(running.id);
    expect(botMsg.parent_id).toBeNull();
    expect(sub.events.some((e) => e.event === "turn.token")).toBe(false);

    const done = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === running.id && e.status === "completed",
    );
    expect(done.partial_text).toBeNull();

    const spend = await waitFor(sub.events, (e) => e.event === "spend.created" && e.kind === "turn");
    expect(spend.turn_id).toBe(running.id);
    expect(spend.judgement_id).toBeNull();
    expect(spend.input_tokens).toBe(12);
    expect(spend.output_tokens).toBe(4);
    expect(spend.total_tokens).toBe(16);
    expect(spend.cost_usd_ticks).toBe(42);
    expect(spend.missing_reason).toBeNull();

    const session = await fetch(`${h.origin}/v1/sessions/${sessionId}`, { headers: auth(h) });
    const detail = (await session.json()) as {
      turns: unknown[];
      messages: { items: Array<{ kind: string; body: string }> };
    };
    expect(detail.turns).toEqual([]);
    expect(detail.messages.items.some((m) => m.kind === "bot" && m.body === "hello from writer")).toBe(
      true,
    );
    sub.close();
  });

  test("posting a png attachment sends an image_url part on the completion", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    let seen: Array<{ role: string; content?: unknown }> = [];
    const fixture = await startFixture(({ body }) => {
      seen = body.messages as Array<{ role: string; content?: unknown }>;
      return sse(textChunks("a red pixel"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    const form = new FormData();
    form.append("body", "这是什么颜色");
    form.append("files", new File([png], "pixel.png", { type: "image/png" }));
    const posted = await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.token}` },
      body: form,
    });
    expect(posted.status).toBe(201);
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === botId,
    );
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId,
    );
    expect(botMsg.body).toBe("a red pixel");
    const user = [...seen].reverse().find((m) => m.role === "user");
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = user?.content as Array<Record<string, unknown>>;
    expect(parts.some((p) => p.type === "text" && String(p.text).includes("附件：inbox/"))).toBe(true);
    expect(parts).toContainEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
    });
    sub.close();
  });

  test("an empty completion completes the turn without inserting a bot message", async () => {
    const fixture = await startFixture(() => sse(textChunks("")));
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "nothing new" }),
    });
    const running = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === botId,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === running.id && e.status === "completed",
    );
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "bot")).toBe(false);
    sub.close();
  });

  test("a no-work closer completion completes the turn without inserting a bot message", async () => {
    const fixture = await startFixture(() => sse(textChunks("介绍已发出，本轮没有新工作。")));
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "hello" }),
    });
    const running = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === botId,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === running.id && e.status === "completed",
    );
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "bot")).toBe(false);
    sub.close();
  });

  test("an explicit fork: false user message in the same direct is heard by the live turn", async () => {
    let n = 0;
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    // The turn goes `running` as soon as it is opened, before the stream reaches
    // this fixture. Posting the follow-up that early aborts the first request
    // while it is still queued, so the second request becomes n===1 and hangs
    // here until waitFor times out.
    let firstEntered = () => {};
    const firstInFlight = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const fixture = await startFixture(async () => {
      n += 1;
      if (n === 1) {
        firstEntered();
        await firstHeld;
        return sse(textChunks("first"));
      }
      return sse(textChunks("second"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);

    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "one" }),
    });
    const first = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === botId,
    );
    await firstInFlight;
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "two", fork: false }),
    });
    // A line of yours while the Bot works is heard by that turn (ADR 0040 P4a), not a redirect.
    releaseFirst();
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "first",
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === first.id && e.status === "completed",
    );
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.status === "redirected")).toBe(false);
    sub.close();
  });

  test("a second user message in the same direct automatically forks the live turn by default", async () => {
    let n = 0;
    const fixture = await startFixture(() => {
      n += 1;
      return sse(textChunks(`response-${n}`));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);

    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "one" }),
    });
    const first = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === botId,
    );
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "two" }),
    });
    const second = await waitFor(
      sub.events,
      (e) =>
        e.event === "turn.upsert" &&
        e.status === "running" &&
        e.bot_id === botId &&
        e.id !== first.id,
    );
    expect(
      sub.events.some(
        (e) => e.event === "turn.upsert" && e.id === first.id && e.status === "redirected",
      ),
    ).toBe(false);
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === first.id && e.status === "completed",
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === second.id && e.status === "completed",
    );
    sub.close();
  });

  test("assistant content on a tool hop shows as the turn's line while it works, never as a bot message", async () => {
    let hop = 0;
    const fixture = await startFixture(() => {
      hop += 1;
      if (hop === 1) {
        return sse([
          {
            id: "chatcmpl-1",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "I'll hand this off" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-1",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "send_message", arguments: '{"body":"handoff note"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-1",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          },
        ]);
      }
      throw new Error("send_message should end the turn without another completion");
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "handoff note",
    );
    expect(sub.events.some((e) => e.event === "turn.token")).toBe(false);
    expect(
      sub.events.some(
        (e) => e.event === "message.created" && e.kind === "bot" && e.body === "I'll hand this off",
      ),
    ).toBe(false);
    const running = sub.events.find(
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === botId,
    );
    expect(running?.partial_text === "" || running?.partial_text == null).toBe(true);
    // Said beside its tool calls, it is the turn's line while they run, as a Claude Agent Bot's is.
    expect(
      sub.events.some(
        (e) => e.event === "turn.upsert" && e.id === running?.id && e.status === "running" && e.partial_text === "I'll hand this off",
      ),
    ).toBe(true);
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === running?.id && e.status === "completed",
    );
    expect(hop).toBe(1);
    expect(sub.events.some((e) => e.event === "turn.token")).toBe(false);
    expect(
      sub.events.filter((e) => e.event === "message.created" && e.kind === "bot").map((e) => e.body),
    ).toEqual(["handoff note"]);
    sub.close();
  });

  test("a successful send_message completes the turn without another completion", async () => {
    let hop = 0;
    const fixture = await startFixture(() => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks("call_1", "send_message", '{"body":"你好，我是审查员，职责是代码审查，只提建议。"}'),
        );
      }
      throw new Error("send_message should end the turn without another completion");
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "你好" }),
    });
    await waitFor(
      sub.events,
      (e) =>
        e.event === "message.created" &&
        e.kind === "bot" &&
        e.body === "你好，我是审查员，职责是代码审查，只提建议。" &&
        e.author === botId,
    );
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(hop).toBe(1);
    expect(
      sub.events.filter((e) => e.event === "message.created" && e.kind === "bot").map((e) => e.body),
    ).toEqual(["你好，我是审查员，职责是代码审查，只提建议。"]);
    sub.close();
  });

  test("send_message tool posts in the current session and then the turn can complete", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse([
          {
            id: "chatcmpl-1",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "send_message", arguments: '{"body":"handoff note"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-1",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          },
        ]);
      }
      throw new Error("send_message should end the turn without another completion");
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    const toolMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "handoff note" && e.author === botId,
    );
    expect(toolMsg.session_id).toBe(sessionId);
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(hop).toBe(1);
    expect(
      sub.events.filter((e) => e.event === "message.created" && e.kind === "bot").map((e) => e.body),
    ).toEqual(["handoff note"]);
    sub.close();
  });

  test("send_message no-work closer is not posted and does not open another completion", async () => {
    let hop = 0;
    const fixture = await startFixture(() => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks(
            "call_1",
            "send_message",
            '{"body":"介绍已经发过，本轮没有新工作，到此结束。"}',
          ),
        );
      }
      throw new Error("no-work closer should end the turn without another completion");
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    const running = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === botId,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === running.id && e.status === "completed",
    );
    expect(hop).toBe(1);
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "bot")).toBe(false);
    const session = await fetch(`${h.origin}/v1/sessions/${sessionId}`, { headers: auth(h) });
    const detail = (await session.json()) as {
      messages: { items: Array<{ kind: string; body: string }> };
    };
    expect(detail.messages.items.some((m) => m.kind === "bot")).toBe(false);
    sub.close();
  });

  test("a later no-work send_message does not post after a real send_message", async () => {
    let hop = 0;
    const fixture = await startFixture(() => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_1", "send_message", '{"body":"handoff note"}'));
      }
      throw new Error("send_message should end the turn without another completion");
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "handoff note" && e.author === botId,
    );
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(hop).toBe(1);
    expect(
      sub.events.filter((e) => e.event === "message.created" && e.kind === "bot").map((e) => e.body),
    ).toEqual(["handoff note"]);
    sub.close();
  });

  test("a hop 2 assistant closer like 本次已完成自我介绍 is not inserted after send_message", async () => {
    let hop = 0;
    const fixture = await startFixture(() => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_1", "send_message", '{"body":"我是测试助手。职责是编写和审查代码。"}'));
      }
      throw new Error("send_message should end the turn without another completion");
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    await waitFor(
      sub.events,
      (e) =>
        e.event === "message.created" &&
        e.kind === "bot" &&
        typeof e.body === "string" &&
        e.body.includes("我是测试助手") &&
        e.author === botId,
    );
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(hop).toBe(1);
    expect(
      sub.events.filter((e) => e.event === "message.created" && e.kind === "bot").map((e) => e.body),
    ).toEqual(["我是测试助手。职责是编写和审查代码。"]);
    sub.close();
  });

  test("a hop 2 status sync closer like 设计已经写进 todo-design.md is not inserted after send_message", async () => {
    let hop = 0;
    const fixture = await startFixture(() => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_1", "send_message", '{"body":"v1 设计已写到工作区根目录 todo-design.md。"}'));
      }
      throw new Error("send_message should end the turn without another completion");
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    await waitFor(
      sub.events,
      (e) =>
        e.event === "message.created" &&
        e.kind === "bot" &&
        typeof e.body === "string" &&
        e.body.includes("v1 设计") &&
        e.author === botId,
    );
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(hop).toBe(1);
    expect(
      sub.events.filter((e) => e.event === "message.created" && e.kind === "bot").map((e) => e.body),
    ).toEqual(["v1 设计已写到工作区根目录 todo-design.md。"]);
    sub.close();
  });

  test("a hop 2 closer like Already answered in the session is not inserted after send_message", async () => {
    let hop = 0;
    const fixture = await startFixture(() => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_1", "send_message", '{"body":"不能。我这边没有改头像的工具。"}'));
      }
      throw new Error("send_message should end the turn without another completion");
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "你能改自己的头像吗" }),
    });
    await waitFor(
      sub.events,
      (e) =>
        e.event === "message.created" &&
        e.kind === "bot" &&
        typeof e.body === "string" &&
        e.body.includes("不能。我这边没有改头像的工具") &&
        e.author === botId,
    );
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(hop).toBe(1);
    expect(
      sub.events.filter((e) => e.event === "message.created" && e.kind === "bot").map((e) => e.body),
    ).toEqual(["不能。我这边没有改头像的工具。"]);
    sub.close();
  });

  test("update_profile can rename the bot and set a generated avatar", async () => {
    let hop = 0;
    const fixture = await startFixture(() => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks("call_1", "update_profile", '{"name":"Scribe","avatar_style":"pixel"}'),
        );
      }
      return sse(textChunks("renamed"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "改个名字和头像" }),
    });
    const upsert = await waitFor(
      sub.events,
      (e) => e.event === "bot.upsert" && e.id === botId && e.name === "Scribe",
    );
    expect(String(upsert.avatar)).toContain("<svg");
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(h.store.getBot(botId).name).toBe("Scribe");
    expect(
      sub.events.some((e) => e.event === "message.created" && e.kind === "profile_change"),
    ).toBe(false);
    expect(h.store.listMainMessages(sessionId, 40).some((m) => m.kind === "profile_change")).toBe(
      false,
    );
    sub.close();
  });

  test("create_skill is visible on the next hop and read_skill returns the body", async () => {
    let hop = 0;
    const systems: string[] = [];
    let skillId = "";
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      systems.push(system);
      if (hop === 1) {
        expect(system).not.toContain("# 技能");
        return sse(
          toolCallChunks(
            "call_1",
            "create_skill",
            '{"name":"commits","description":"when committing","body":"use conventional commits"}',
          ),
        );
      }
      if (hop === 2) {
        expect(system).toContain("# 技能");
        expect(system).toContain("## commits");
        return sse(toolCallChunks("call_2", "read_skill", '{"name":"commits"}'));
      }
      return sse(textChunks("ready"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "以后提交用 conventional commits" }),
    });
    const upsert = await waitFor(sub.events, (e) => e.event === "skill.upsert" && e.bot_id === botId);
    skillId = String(upsert.id);
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(skillId.length).toBeGreaterThan(0);
    expect(systems[0]).not.toContain("# 技能");
    expect(systems[1]).toContain("## commits");
    expect(h.store.getSkill(skillId).body).toBe("use conventional commits");
    expect(h.store.listMainMessages(sessionId, 40).some((m) => m.kind === "bot")).toBe(true);
    sub.close();
  });

  test("GET composer-suggestions returns drafts from the default endpoint", async () => {
    const fixture = await startFixture(({ body }) => {
      if (isComposerSuggestRequest(body)) {
        const messages = body.messages as Array<{ role: string; content?: string }>;
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        expect(user).toContain("请各自介绍");
        expect(user).toContain("Writer");
        expect(body.model).toBe("test-model");
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  suggestions: [
                    { label: "让 Writer 写", prompt: "@Writer 按刚才的介绍写一页大纲" },
                    { label: "全员报进度", prompt: "@everyone 请各自报当前进度" },
                    { label: "幻觉", prompt: "@Ghost 继续" },
                  ],
                }),
              },
            },
          ],
        });
      }
      if (isJudgementRequest(body)) return judgementPass();
      return sse(textChunks("ok"));
    });
    const h = await startApi();
    const { groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Reviewer", duties: "review" },
    ]);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "请各自介绍" }),
    });
    const res = await fetch(`${h.origin}/v1/sessions/${groupId}/composer-suggestions`, {
      headers: auth(h),
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: Array<{ label: string; prompt: string }> };
    expect(page.items.map((row) => row.prompt)).toEqual([
      "@Writer 按刚才的介绍写一页大纲",
      "@everyone 请各自报当前进度",
    ]);
    expect(page.items[0]!.label).toBe("让 Writer 写");
  });

  test("GET composer-suggestions is empty without an endpoint", async () => {
    const h = await startApi(new Store({ endpointKey: memoryKeyStore(null) }));
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = h.store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = h.store.createGroup({
      name: "Brief",
      members: [writer.bot.id, reviewer.bot.id],
    });
    const missing = await fetch(`${h.origin}/v1/sessions/nope/composer-suggestions`, {
      headers: auth(h),
    });
    expect(missing.status).toBe(404);
    const res = await fetch(`${h.origin}/v1/sessions/${group.id}/composer-suggestions`, {
      headers: auth(h),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });
});
