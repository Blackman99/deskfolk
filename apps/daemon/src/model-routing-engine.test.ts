import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { ROUTE_LEARN_SYSTEM, ROUTE_PICK_SYSTEM, ROUTE_REVIEW_SYSTEM } from "./prompts/routing";
import { jsonAuth as auth, registerLocalApiCleanup, sse, subscribe, waitFor } from "./test-kit/local-api-harness";
import { isJudgementRequest, judgementPass, routingAnswer, startApi, startFixture, textChunks } from "./test-kit/engine-fixtures";

registerLocalApiCleanup();

describe("turn engine on the local API", () => {
  test("a bot model overrides the default on the completion request", async () => {
    const seen: string[] = [];
    const fixture = await startFixture(({ body }) => {
      seen.push(String(body.model));
      return sse(textChunks("ok"));
    });
    const h = await startApi();
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: fixture.origin,
        endpoint_api_key: "sk-test",
        endpoint_models: ["grok-4.5", "deepseek-v4-pro"],
        endpoint_default_model: "grok-4.5",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "deepseek-v4-pro",
      }),
    });
    const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(seen[0]).toBe("deepseek-v4-pro");
    sub.close();
  });

  test("a bot model on a second provider hits that provider's base URL", async () => {
    const seen: Array<{ origin: string; model: string }> = [];
    const first = await startFixture(({ url, body }) => {
      seen.push({ origin: url.origin, model: String(body.model) });
      return sse(textChunks("from-first"));
    });
    const second = await startFixture(({ url, body }) => {
      seen.push({ origin: url.origin, model: String(body.model) });
      return sse(textChunks("from-second"));
    });
    const h = await startApi();
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: first.origin,
        endpoint_api_key: "sk-first",
        endpoint_models: ["first-model"],
        endpoint_default_model: "first-model",
      }),
    });
    const createdProvider = await fetch(`${h.origin}/v1/providers`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "Second",
        base_url: second.origin,
        api_key: "sk-second",
        models: ["second-model"],
        default_model: "second-model",
      }),
    });
    expect(createdProvider.status).toBe(201);
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "second-model",
      }),
    });
    const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(seen).toEqual([{ origin: new URL(second.origin).origin, model: "second-model" }]);
    sub.close();
  });

  test("no configured model inserts the no_model system line and completes", async () => {
    const fixture = await startFixture(() => sse(textChunks("should not run")));
    const h = await startApi();
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: fixture.origin,
        endpoint_api_key: "sk-test",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
    });
    const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    const sys = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "system" && e.author === body.bot.id,
    );
    expect(sys.body).toBe("这一轮没写完：没有可用的模型");
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    sub.close();
  });
});

describe("per-message model and thinking-level routing", () => {
  test("the routing agent picks the model, and a closed chain gets reviewed", async () => {
    const seen: Array<{ model: string; reasoning_effort: string }> = [];
    const routingCalls: Array<Record<string, unknown>> = [];
    const fixture = await startFixture(
      ({ body }) => {
        if (isJudgementRequest(body)) return judgementPass();
        seen.push({ model: String(body.model), reasoning_effort: String(body.reasoning_effort) });
        return sse(textChunks("ok"));
      },
      ({ body }) => {
        const messages = body.messages as Array<{ role?: string; content?: string }>;
        const system = messages.find((row) => row.role === "system")?.content ?? "";
        const payload = JSON.parse(messages.find((row) => row.role === "user")!.content!) as Record<
          string,
          unknown
        >;
        routingCalls.push({ system, payload });
        if (system === ROUTE_REVIEW_SYSTEM) {
          return routingAnswer(
            '{"fault": "model", "direction": "stronger", "rounds": 2, "confidence": 0.9, "reason": "反复改不对"}',
          );
        }
        // The agent takes the expensive model even though the rules would call this "simple".
        return routingAnswer('{"model": "code-pro", "thinking_level": "high", "reason": "要多步推理"}');
      },
    );
    const h = await startApi();
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: fixture.origin,
        endpoint_api_key: "sk-test",
        endpoint_models: [
          { name: "cheap-chat", price: 1, thinking_levels: ["none", "low"], strengths: ["chat"] },
          { name: "code-pro", price: 12, thinking_levels: ["medium", "high"], strengths: ["code"] },
        ],
        endpoint_default_model: "cheap-chat",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
    });
    const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "你好" }),
    });
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");

    // "你好" is a `simple` message: the rules would have taken cheap-chat at its lightest level.
    expect(seen[0]).toEqual({ model: "code-pro", reasoning_effort: "high" });
    const pickCall = routingCalls.find((row) => row.system === ROUTE_PICK_SYSTEM)!;
    const payload = pickCall.payload as { candidates: Array<{ model: string }>; message: string };
    expect(payload.message).toBe("你好");
    expect(payload.candidates.map((row) => row.model).sort()).toEqual(["cheap-chat", "code-pro"]);

    const routes = h.store.listSessionRoutes(body.direct_session.id);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ model: "code-pro", thinking_level: "high" });
    expect(h.store.getTurnRoute(routes[0]!.turn_id)).not.toBeNull();

    // The user pushes back, then moves on: the chain closes and the review lands on the Bot.
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "这里不对" }),
    });
    await waitFor(
      sub.events,
      () => sub.events.filter((e) => e.event === "turn.upsert" && e.status === "completed").length >= 2,
    );
    await waitFor(sub.events, () => h.store.recentRouteReviews(body.bot.id).length > 0, 4000).catch(
      () => undefined,
    );
    const reviews = h.store.recentRouteReviews(body.bot.id);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0]).toMatchObject({ fault: "model", direction: "stronger", reason: "反复改不对" });
    // A model verdict opens one learning hop. This answer names no tool, so nothing is written
    // and the transcript gains no line from it.
    await waitFor(sub.events, () => routingCalls.some((row) => row.system === ROUTE_LEARN_SYSTEM), 4000);
    const before = h.store.listMainMessages(body.direct_session.id, 40).length;
    expect(h.store.listMemories(body.bot.id)).toHaveLength(0);
    expect(h.store.listMainMessages(body.direct_session.id, 40)).toHaveLength(before);
    sub.close();
  });

  test("a reviewed chain's learning hop writes one memory and no transcript line", async () => {
    const fixture = await startFixture(
      ({ body }) => {
        if (isJudgementRequest(body)) return judgementPass();
        return sse(textChunks("ok"));
      },
      ({ body }) => {
        const messages = body.messages as Array<{ role?: string; content?: string }>;
        const system = messages.find((row) => row.role === "system")?.content ?? "";
        if (system === ROUTE_LEARN_SYSTEM) {
          const tools = body.tools as Array<{ function?: { name?: string } }>;
          expect(tools.map((tool) => tool.function?.name).sort()).toEqual(["forget", "remember", "update_skill"]);
          return Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_learn",
                      type: "function",
                      function: {
                        name: "remember",
                        arguments: JSON.stringify({ subject: "重构先读现有函数", body: "先读再改，不要整段重写" }),
                      },
                    },
                  ],
                },
              },
            ],
          });
        }
        if (system === ROUTE_REVIEW_SYSTEM) {
          return routingAnswer(
            '{"fault": "model", "direction": "stronger", "rounds": 1, "confidence": 0.9, "reason": "改偏了"}',
          );
        }
        return routingAnswer(
          '{"model": "code-pro", "thinking_level": "high", "reason": "要改代码", "continues_previous": false}',
        );
      },
    );
    const h = await startApi();
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: fixture.origin,
        endpoint_api_key: "sk-test",
        endpoint_models: [{ name: "code-pro", price: 12, thinking_levels: ["high"], strengths: ["code"] }],
        endpoint_default_model: "code-pro",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
    });
    const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "把这个函数重构一下" }),
    });
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "你好" }),
    });
    await waitFor(sub.events, (e) => e.event === "memory.upsert" && e.subject === "重构先读现有函数", 4000);
    const memory = h.store.listMemories(body.bot.id)[0]!;
    expect(memory.body).toBe("先读再改，不要整段重写");
    expect(memory.source_message_id).not.toBeNull();
    const chain = h.store.db
      .query<{ learned_chain_id: string | null }, [string]>(`SELECT learned_chain_id FROM memories WHERE id = ?`)
      .get(memory.id);
    expect(chain?.learned_chain_id).not.toBeNull();
    const transcript = h.store.listMainMessages(body.direct_session.id, 40);
    expect(transcript.some((row) => row.body.includes("重构先读现有函数"))).toBe(false);
    // The note is written when the learning hop ends, a model call or more after the memory it
    // announced; reading it the moment the memory arrived failed whenever that call was slow.
    let learning = h.store.listSessionLearnings(body.direct_session.id);
    for (const start = Date.now(); learning.length === 0 && Date.now() - start < 4000; ) {
      await Bun.sleep(10);
      learning = h.store.listSessionLearnings(body.direct_session.id);
    }
    expect(learning).toHaveLength(1);
    expect(learning[0]).toMatchObject({ kind: "memory", label: "重构先读现有函数" });
    sub.close();
  });

  test("a learning hop cannot create a skill from one incident", async () => {
    let learnCalls = 0;
    const fixture = await startFixture(
      ({ body }) => {
        if (isJudgementRequest(body)) return judgementPass();
        return sse(textChunks("ok"));
      },
      ({ body }) => {
        const messages = body.messages as Array<{ role?: string; content?: string }>;
        const system = messages.find((row) => row.role === "system")?.content ?? "";
        if (system === ROUTE_LEARN_SYSTEM) {
          learnCalls += 1;
          return Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_skill",
                      type: "function",
                      function: {
                        name: "create_skill",
                        arguments: JSON.stringify({ name: "重构", description: "先读", body: "先读再改" }),
                      },
                    },
                  ],
                },
              },
            ],
          });
        }
        if (system === ROUTE_REVIEW_SYSTEM) {
          return routingAnswer(
            '{"fault": "model", "direction": "stronger", "rounds": 1, "confidence": 0.9, "reason": "改偏了"}',
          );
        }
        return routingAnswer(
          '{"model": "code-pro", "thinking_level": "high", "reason": "要改代码", "continues_previous": false}',
        );
      },
    );
    const h = await startApi();
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: fixture.origin,
        endpoint_api_key: "sk-test",
        endpoint_models: [{ name: "code-pro", price: 12, thinking_levels: ["high"], strengths: ["code"] }],
        endpoint_default_model: "code-pro",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
    });
    const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "把这个函数重构一下" }),
    });
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "你好" }),
    });
    // create_skill is not in the hop's tools, so the call is dropped and the hop ends.
    await waitFor(sub.events, () => learnCalls >= 1, 4000);
    expect(h.store.listSkills(body.bot.id)).toHaveLength(0);
    sub.close();
  });

  test("turn start posts the chosen model and thinking level; two runs agree", async () => {
    async function runOnce(): Promise<{ model: string; reasoning_effort: string }> {
      const seen: Array<{ model: string; reasoning_effort: string }> = [];
      const fixture = await startFixture(({ body }) => {
        if (isJudgementRequest(body)) return judgementPass();
        seen.push({
          model: String(body.model),
          reasoning_effort: String(body.reasoning_effort),
        });
        return sse(textChunks("ok"));
      });
      const h = await startApi();
      mkdirSync("/tmp/real-bot-ws", { recursive: true });
      await fetch(`${h.origin}/v1/settings`, {
        method: "PATCH",
        headers: auth(h),
        body: JSON.stringify({
          workspace_path: "/tmp/real-bot-ws",
          endpoint_base_url: fixture.origin,
          endpoint_api_key: "sk-test",
          endpoint_models: [
            {
              name: "cheap-chat",
              price: 1,
              thinking_levels: ["none", "low"],
              strengths: ["chat"],
            },
            {
              name: "code-pro",
              price: 12,
              thinking_levels: ["medium", "high"],
              strengths: ["code", "coding"],
            },
          ],
          endpoint_default_model: "cheap-chat",
        }),
      });
      const created = await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
      });
      const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
      const sub = await subscribe(h);
      await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ body: "please implement a TypeScript function that parses the AST" }),
      });
      await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
      sub.close();
      expect(seen).toHaveLength(1);
      return seen[0]!;
    }
    const first = await runOnce();
    const second = await runOnce();
    expect(first.model).toBe("code-pro");
    expect(first.reasoning_effort).toBe("medium");
    expect(second).toEqual(first);
  });

  test("a bot pin keeps the completion model while thinking level is still chosen", async () => {
    const seen: Array<{ model: string; reasoning_effort: string }> = [];
    const fixture = await startFixture(({ body }) => {
      seen.push({
        model: String(body.model),
        reasoning_effort: String(body.reasoning_effort),
      });
      return sse(textChunks("ok"));
    });
    const h = await startApi();
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: fixture.origin,
        endpoint_api_key: "sk-test",
        endpoint_models: [
          {
            name: "cheap-chat",
            price: 1,
            thinking_levels: ["none", "low"],
            strengths: ["chat"],
          },
          {
            name: "code-pro",
            price: 12,
            thinking_levels: ["medium", "high"],
            strengths: ["code"],
          },
        ],
        endpoint_default_model: "code-pro",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "cheap-chat",
      }),
    });
    const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "please implement a TypeScript function that parses the AST" }),
    });
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(seen[0]).toEqual({ model: "cheap-chat", reasoning_effort: "low" });
    sub.close();
  });

  test("a bot thinking-level pin overrides the app's choice when the resolved model supports it", async () => {
    const seen: Array<{ model: string; reasoning_effort: string }> = [];
    const fixture = await startFixture(({ body }) => {
      seen.push({
        model: String(body.model),
        reasoning_effort: String(body.reasoning_effort),
      });
      return sse(textChunks("ok"));
    });
    const h = await startApi();
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: fixture.origin,
        endpoint_api_key: "sk-test",
        endpoint_models: [
          {
            name: "cheap-chat",
            price: 1,
            thinking_levels: ["none", "low"],
            strengths: ["chat"],
          },
          {
            name: "code-pro",
            price: 12,
            thinking_levels: ["medium", "high"],
            strengths: ["code"],
          },
        ],
        endpoint_default_model: "code-pro",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "code-pro",
        thinking_level: "high",
      }),
    });
    const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "please implement a TypeScript function that parses the AST" }),
    });
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(seen[0]).toEqual({ model: "code-pro", reasoning_effort: "high" });

    // Unpinning the model unpins the level with it, so the app picks both again.
    await fetch(`${h.origin}/v1/bots/${body.bot.id}`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({ model: null }),
    });
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "please implement a TypeScript function that parses the AST" }),
    });
    await waitFor(sub.events, () => seen.length >= 2);
    await waitFor(
      sub.events,
      () => sub.events.filter((e) => e.event === "turn.upsert" && e.status === "completed").length >= 2,
    );
    expect(seen[1]).toEqual({ model: "code-pro", reasoning_effort: "medium" });
    sub.close();
  });

  test("a follow-up is kept against the decision it answers, and the routes endpoint shows it", async () => {
    const seen: Array<{ model: string; reasoning_effort: string }> = [];
    const fixture = await startFixture(({ body }) => {
      seen.push({
        model: String(body.model),
        reasoning_effort: String(body.reasoning_effort),
      });
      return sse(
        textChunks("done", {
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
          cost_in_usd_ticks: 11,
        }),
      );
    });
    const h = await startApi();
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: fixture.origin,
        endpoint_api_key: "sk-test",
        endpoint_models: [
          {
            name: "cheap-chat",
            price: 1,
            thinking_levels: ["none", "low"],
            strengths: ["chat"],
          },
          {
            name: "code-pro",
            price: 12,
            thinking_levels: ["medium", "high"],
            strengths: ["code", "coding"],
          },
        ],
        endpoint_default_model: "cheap-chat",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
    });
    const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
    const task = "please implement a TypeScript function that parses the AST";
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: task }),
    });
    const running = await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "running");
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(seen[0]).toEqual({ model: "code-pro", reasoning_effort: "medium" });
    const spend = await waitFor(sub.events, (e) => e.event === "spend.created" && e.kind === "turn");
    expect(spend.cost_usd_ticks).toBe(11);
    expect(spend.total_tokens).toBe(7);
    const firstRoute = h.store.getTurnRoute(String(running.id));
    expect(firstRoute?.model).toBe("code-pro");

    const critiquePosted = await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "这里有 bug，选的模型不对" }),
    });
    expect(critiquePosted.status).toBe(201);
    const critiqueTurn = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.id !== running.id,
    );
    const feedback = h.store.listRouteFeedback();
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({
      model: "code-pro",
      thinking_level: "medium",
      body: "这里有 bug，选的模型不对",
    });
    // The follow-up is kept for the review; nothing is scored here any more.

    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: task }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.id !== running.id && e.id !== critiqueTurn.id,
    );
    expect(seen).toHaveLength(3);
    // The follow-up alone no longer re-routes anything: nothing has reviewed this chain yet, so the
    // fallback rules still pick the same pair for the same message.
    expect(`${seen[2]!.model}:${seen[2]!.reasoning_effort}`).toBe("code-pro:medium");
    const routesRes = await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/routes`, { headers: auth(h) });
    expect(routesRes.status).toBe(200);
    const routes = (await routesRes.json()) as { items: Array<Record<string, unknown>> };
    expect(routes.items).toHaveLength(3);
    expect(routes.items[0]).toMatchObject({
      turn_id: running.id,
      bot_id: body.bot.id,
      model: "code-pro",
      thinking_level: "medium",
      signature: "coding",
      outcome: "completed",
      fail_kind: null,
      hops: 1,
      tool_calls: 0,
      tool_errors: 0,
      repeated_failures: 0,
      files_written: 0,
      feedback: [{ body: "这里有 bug，选的模型不对" }],
    });
    // The third message lands on the turn before it: whether re-asking means the model failed is
    // the review's call, not a keyword's.
    expect(routes.items[1]).toMatchObject({
      turn_id: critiqueTurn.id,
      outcome: "completed",
      feedback: [{ body: task }],
    });
    expect(routes.items.every((row) => typeof row.provider_id === "string")).toBe(true);
    // The flow board carries the same record on the card of the turn it ran on.
    const taskId = h.store.taskOfTurn(String(running.id))!;
    const traceRes = await fetch(`${h.origin}/v1/tasks/${taskId}/trace`, { headers: auth(h) });
    expect(traceRes.status).toBe(200);
    const trace = (await traceRes.json()) as { nodes: Array<{ turn_id: string; actor: string; route: Record<string, unknown> | null }> };
    expect(trace.nodes.find((node) => node.turn_id === running.id)!.route).toMatchObject({
      record: { model: "code-pro", thinking_level: "medium", feedback: [{ body: "这里有 bug，选的模型不对" }] },
      review: null,
      learning: null,
    });
    // Your own card ran on no model.
    expect(trace.nodes.find((node) => node.actor === "user")!.route).toBeNull();
    sub.close();
  });
});
