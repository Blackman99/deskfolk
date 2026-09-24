import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompletionsClient } from "./completions";
import { ROUTE_LEARN_SYSTEM, ROUTE_PICK_SYSTEM, ROUTE_REVIEW_SYSTEM } from "./prompts/routing";
import { createLocalApi } from "./local-api";
import { runCollabTool } from "./collab-tools";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

type Harness = {
  origin: string;
  token: string;
  store: Store;
  engine: import("./turn-engine").TurnEngine;
  close: () => Promise<void>;
};

const harnesses: Harness[] = [];
const fixtures: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close();
  while (fixtures.length) await fixtures.pop()?.close();
});

async function startApi(
  store?: Store,
  extra?: { completions?: import("./completions").CompletionsClient },
): Promise<Harness> {
  const token = "test-token";
  const nextStore = store ?? new Store({ endpointKey: memoryKeyStore("sk-test") });
  const api = createLocalApi({
    store: nextStore,
    token,
    schedule: false,
    completions: extra?.completions,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: api.fetch,
    websocket: api.websocket,
  });
  const harness: Harness = {
    origin: `http://${server.hostname}:${server.port}`,
    token,
    store: nextStore,
    engine: api.engine,
    close: async () => {
      api.scheduler?.stop();
      await api.engine.close();
      nextStore.close();
      await server.stop(true);
    },
  };
  harnesses.push(harness);
  return harness;
}

function auth(h: Harness): Record<string, string> {
  return { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" };
}

type FixtureHandler = (request: {
  url: URL;
  body: Record<string, unknown>;
}) => Response | Promise<Response>;

/** The routing calls are plain completions, not streams, so they answer like the judgement does. */
function routingAnswer(content: string): Response {
  return Response.json({ choices: [{ message: { role: "assistant", content } }] });
}

/** True for the routing agent's own calls: picking a model, reviewing a chain, learning from it. */
function isRoutingCall(body: Record<string, unknown>): boolean {
  const messages = body.messages as Array<{ role?: string; content?: string }> | undefined;
  const system = messages?.find((row) => row.role === "system")?.content ?? "";
  return system === ROUTE_PICK_SYSTEM || system === ROUTE_REVIEW_SYSTEM || system === ROUTE_LEARN_SYSTEM;
}

/**
 * Every turn now asks a model what to run on, so each test's scripted queue would be eaten by a
 * call it never wrote. Unless a test answers routing itself, those calls get an answer that names
 * nothing — which is exactly the case the engine handles by falling back to the rules, so a test
 * written before agent routing keeps testing what it always did.
 */
async function startFixture(
  handler: FixtureHandler,
  routing?: FixtureHandler,
): Promise<{ origin: string }> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as Record<string, unknown>;
      if (isRoutingCall(body)) {
        return routing ? routing({ url, body }) : routingAnswer("{}");
      }
      return handler({ url, body });
    },
  });
  const origin = `http://${server.hostname}:${server.port}/v1`;
  fixtures.push({ close: () => server.stop(true) });
  return { origin };
}

function sse(chunks: unknown[]): Response {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(lines, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function textChunks(text: string, usage?: Record<string, number>): unknown[] {
  const chunks: unknown[] = [
    {
      id: "chatcmpl-1",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-1",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  if (usage) {
    chunks.push({ id: "chatcmpl-1", choices: [], usage });
  }
  return chunks;
}

async function subscribe(h: Harness): Promise<{ events: Array<Record<string, unknown>>; close: () => void }> {
  const events: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  ws.addEventListener("message", (ev) => {
    events.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
  });
  ws.send(JSON.stringify({ type: "auth", token: h.token }));
  await Bun.sleep(20);
  return {
    events,
    close: () => ws.close(),
  };
}

async function waitFor(
  events: Array<Record<string, unknown>>,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await Bun.sleep(10);
  }
  throw new Error(`timeout waiting for event; saw ${JSON.stringify(events)}`);
}

async function createWriter(
  h: Harness,
  fixtureOrigin: string,
): Promise<{ botId: string; sessionId: string }> {
  mkdirSync("/tmp/real-bot-ws", { recursive: true });
  await fetch(`${h.origin}/v1/settings`, {
    method: "PATCH",
    headers: auth(h),
    body: JSON.stringify({
      workspace_path: "/tmp/real-bot-ws",
      endpoint_base_url: fixtureOrigin,
      endpoint_api_key: "sk-test",
      endpoint_models: ["test-model"],
      endpoint_default_model: "test-model",
    }),
  });
  const created = await fetch(`${h.origin}/v1/bots`, {
    method: "POST",
    headers: auth(h),
    body: JSON.stringify({
      name: "Writer",
      duties: "write the report",
      boundaries: "stay in the workspace",
    }),
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as {
    bot: { id: string };
    direct_session: { id: string };
  };
  return { botId: body.bot.id, sessionId: body.direct_session.id };
}

async function createGroupWithBots(
  h: Harness,
  fixtureOrigin: string,
  names: Array<{ name: string; duties: string }>,
): Promise<{ bots: Array<{ id: string; name: string }>; groupId: string }> {
  mkdirSync("/tmp/real-bot-ws", { recursive: true });
  await fetch(`${h.origin}/v1/settings`, {
    method: "PATCH",
    headers: auth(h),
    body: JSON.stringify({
      workspace_path: "/tmp/real-bot-ws",
      endpoint_base_url: fixtureOrigin,
      endpoint_api_key: "sk-test",
      endpoint_models: ["test-model"],
      endpoint_default_model: "test-model",
    }),
  });
  const bots: Array<{ id: string; name: string }> = [];
  for (const row of names) {
    const created = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: row.name, duties: row.duties, boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string; name: string } };
    bots.push(created.bot);
  }
  const group = (await (
    await fetch(`${h.origin}/v1/sessions`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Brief", members: bots.map((b) => b.id) }),
    })
  ).json()) as { id: string };
  return { bots, groupId: group.id };
}

function isJudgementRequest(body: Record<string, unknown>): boolean {
  const messages = body.messages as Array<{ role: string; content?: string }>;
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  return system.includes("你正在做一次判断");
}

function isComposerSuggestRequest(body: Record<string, unknown>): boolean {
  const messages = body.messages as Array<{ role: string; content?: string }>;
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  return system.includes("你在给用户写下一步要发进输入框的草稿");
}

function judgementPass(): Response {
  return Response.json({
    choices: [{ message: { role: "assistant", content: JSON.stringify({ decision: "pass", reason: "no" }) } }],
  });
}

function judgementJoin(): Response {
  return Response.json({
    choices: [{ message: { role: "assistant", content: JSON.stringify({ decision: "join", reason: "duties" }) } }],
  });
}

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

  test("an explicit fork: false user message in the same direct redirects the live turn", async () => {
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
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === first.id && e.status === "redirected",
    );
    const second = await waitFor(
      sub.events,
      (e) =>
        e.event === "turn.upsert" &&
        e.status === "running" &&
        e.bot_id === botId &&
        e.id !== first.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "second",
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === second.id && e.status === "completed",
    );
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "bot" && e.body === "first")).toBe(
      false,
    );
    releaseFirst();
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

  test("assistant content on a tool hop is not streamed and is not inserted as a bot message", async () => {
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

  test("unmentioned group members are judged and a join opens a forked turn", async () => {
    const judgements: Array<Record<string, unknown>> = [];
    let releaseJudgements: (() => void) | undefined;
    const holdJudgements = new Promise<void>((resolve) => {
      releaseJudgements = resolve;
    });
    const fixture = await startFixture(async ({ body }) => {
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("你正在做一次判断")) {
        judgements.push(body);
        expect(body.stream).toBe(false);
        expect(body.tools).toBeUndefined();
        expect(body.response_format).toBeUndefined();
        expect(system.includes("{")).toBe(false);
        expect(system).toContain("触发条与最近转录是同一件事的重复或转述");
        await holdJudgements;
        const decision = judgements.length <= 2 ? "join" : "pass";
        return Response.json({
          choices: [
            { message: { role: "assistant", content: JSON.stringify({ decision, reason: "duties" }) } },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        });
      }
      return sse(textChunks("joined"));
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
        endpoint_models: ["test-model"],
        endpoint_default_model: "test-model",
      }),
    });
    const writer = await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
      })
    ).json() as { bot: { id: string } };
    const researcher = await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Researcher", duties: "read", boundaries: "stay" }),
      })
    ).json() as { bot: { id: string } };
    const group = await (
      await fetch(`${h.origin}/v1/sessions`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Brief", members: [writer.bot.id, researcher.bot.id] }),
      })
    ).json() as { id: string };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${group.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "please begin" }),
    });
    const started = await waitFor(
      sub.events,
      (e) => e.event === "judgement.started" && e.session_id === group.id,
    );
    expect(started.bot_id).toBeTruthy();
    expect(started.message_id).toBeTruthy();
    const listed = await fetch(`${h.origin}/v1/sessions`, { headers: auth(h) });
    const listedBody = (await listed.json()) as {
      items: Array<{ id: string; pending_judgements?: Array<{ bot_id: string }> }>;
    };
    const listedGroup = listedBody.items.find((s) => s.id === group.id);
    expect((listedGroup?.pending_judgements ?? []).length).toBeGreaterThan(0);
    releaseJudgements?.();
    await waitFor(sub.events, (e) => e.event === "judgement.created" && e.decision === "join");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.session_id === group.id,
    );
    await waitFor(sub.events, (e) => e.event === "message.created" && e.kind === "bot" && e.body === "joined");
    expect(judgements.length).toBeGreaterThanOrEqual(2);
    const after = await fetch(`${h.origin}/v1/sessions/${group.id}`, { headers: auth(h) });
    const afterBody = (await after.json()) as { pending_judgements?: unknown[] };
    expect(afterBody.pending_judgements ?? []).toEqual([]);
    sub.close();
  });

  test("a user @ in a group only opens the named bot and does not judge the others", async () => {
    const judgements: unknown[] = [];
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) {
        judgements.push(body);
        return judgementJoin();
      }
      return sse(textChunks("only writer"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const researcher = bots.find((b) => b.name === "Researcher")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer please write" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "only writer" && e.author === writer.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === writer.id,
    );
    await Bun.sleep(40);
    expect(judgements).toEqual([]);
    expect(sub.events.some((e) => e.event === "judgement.started")).toBe(false);
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.bot_id === researcher.id)).toBe(false);
    sub.close();
  });

  test("a bot group message with no @ does not judge or open other turns", async () => {
    const judgements: unknown[] = [];
    let writerHops = 0;
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) {
        judgements.push(body);
        return judgementJoin();
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("## 名字\n\nWriter")) {
        writerHops += 1;
        if (writerHops === 1) {
          return sse(toolCallChunks("call_1", "send_message", '{"body":"handoff note"}'));
        }
        throw new Error("send_message should end the turn without another completion");
      }
      return sse(textChunks("should not speak"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const researcher = bots.find((b) => b.name === "Researcher")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer go" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "handoff note" && e.author === writer.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === writer.id,
    );
    await Bun.sleep(40);
    expect(judgements).toEqual([]);
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.bot_id === researcher.id)).toBe(false);
    expect(
      sub.events.filter((e) => e.event === "message.created" && e.kind === "bot").map((e) => e.body),
    ).toEqual(["handoff note"]);
    sub.close();
  });

  test("a bot @ in a group only opens the named bot and does not judge bystanders", async () => {
    const judgements: unknown[] = [];
    let writerHops = 0;
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) {
        judgements.push(body);
        return judgementJoin();
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("## 名字\n\nWriter")) {
        writerHops += 1;
        if (writerHops === 1) {
          return sse(toolCallChunks("call_1", "send_message", '{"body":"@Researcher take this"}'));
        }
        throw new Error("send_message should end the turn without another completion");
      }
      if (system.includes("## 名字\n\nResearcher")) {
        return sse(textChunks("took it"));
      }
      return sse(textChunks("reviewer should not speak"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
      { name: "Reviewer", duties: "review" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const researcher = bots.find((b) => b.name === "Researcher")!;
    const reviewer = bots.find((b) => b.name === "Reviewer")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer go" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "@Researcher take this" && e.author === writer.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "took it" && e.author === researcher.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === researcher.id,
    );
    await Bun.sleep(40);
    expect(judgements).toEqual([]);
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.bot_id === reviewer.id)).toBe(false);
    sub.close();
  });

  test("a bot @ in a group redirects the named bot's live turn instead of cloning", async () => {
    let writerHops = 0;
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sawFirstWriter = () => {};
    const firstWriterArrived = new Promise<void>((resolve) => {
      sawFirstWriter = resolve;
    });
    const fixture = await startFixture(async ({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("## 名字\n\nWriter")) {
        writerHops += 1;
        if (writerHops === 1) {
          sawFirstWriter();
          await firstHeld;
          return sse(textChunks("first should not land"));
        }
        const situation = messages.find(
          (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("# 局面"),
        );
        expect(situation?.content).toContain("本轮由【Researcher】叫醒。");
        return sse(textChunks("heard the handoff"));
      }
      if (system.includes("## 名字\n\nResearcher")) {
        return sse(toolCallChunks("call_1", "send_message", '{"body":"@Writer take this"}'));
      }
      return sse(textChunks("should not speak"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const researcher = bots.find((b) => b.name === "Researcher")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer go" }),
    });
    const first = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === writer.id,
    );
    await firstWriterArrived;
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Researcher hand off" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "@Writer take this" && e.author === researcher.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === first.id && e.status === "redirected",
    );
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "heard the handoff" && e.author === writer.id,
    );
    const writerRunning = sub.events.filter(
      (e) => e.event === "turn.upsert" && e.bot_id === writer.id && e.status === "running",
    );
    expect(writerRunning.length).toBeGreaterThanOrEqual(2);
    const liveAfterHandoff = h.store.listLiveTurns({ sessionId: groupId, botId: writer.id });
    expect(liveAfterHandoff).toHaveLength(0);
    expect(
      sub.events.some((e) => e.event === "message.created" && e.kind === "bot" && e.body === "first should not land"),
    ).toBe(false);
    releaseFirst();
    sub.close();
  });

  test("quoting a bot group message auto-@s them and opens their turn", async () => {
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("## 名字\n\nWriter")) {
        return sse(textChunks("first draft"));
      }
      if (system.includes("## 名字\n\nResearcher")) {
        return sse(textChunks("revised"));
      }
      return sse(textChunks("should not speak"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const researcher = bots.find((b) => b.name === "Researcher")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer go" }),
    });
    const draft = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "first draft" && e.author === writer.id,
    );
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "please revise", parent_id: draft.id }),
    });
    const quote = await waitFor(
      sub.events,
      (e) =>
        e.event === "message.created" &&
        e.kind === "user" &&
        e.parent_id === draft.id &&
        typeof e.body === "string" &&
        String(e.body).startsWith("@Writer "),
    );
    expect(quote.body).toBe("@Writer please revise");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === writer.id && e.trigger_message_id === quote.id,
    );
    await Bun.sleep(40);
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.bot_id === researcher.id && e.trigger_message_id === quote.id)).toBe(
      false,
    );
    sub.close();
  });

  test("send_message status notes like 介绍已发出 are not posted in a group", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks("call_1", "send_message", '{"body":"介绍已经发出，并 @ 了同组的架构师和审查员，等他们各自发言。"}'),
        );
      }
      throw new Error("status closer should end the turn without another completion");
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer go" }),
    });
    const running = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === writer.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === running.id && e.status === "completed",
    );
    expect(hop).toBe(1);
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "bot")).toBe(false);
    sub.close();
  });

  test("ask_user parks the turn and a reply continues the same turn", async () => {
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
                      id: "call_ask",
                      function: { name: "ask_user", arguments: '{"question":"which tone?"}' },
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
      const messages = body.messages as Array<{ role: string; content?: string }>;
      expect(messages.some((m) => m.role === "tool" && String(m.content).includes("formal"))).toBe(true);
      return sse(textChunks("got it"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "ask me" }),
    });
    const ask = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "ask" && e.author === botId,
    );
    expect(ask.body).toBe("which tone?");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "waiting_ask" && e.id === ask.turn_id,
    );
    const reply = await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "formal", ask_id: ask.id }),
    });
    expect(reply.status).toBe(201);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "got it" && e.turn_id === ask.turn_id,
    );
    sub.close();
  });

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

  test("@everyone opens every present bot and each one finishes a reply", async () => {
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const name = system.match(/## 名字\n\n(.+)/)?.[1] ?? "bot";
      return sse(textChunks(`${name} ready`));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
      { name: "Reviewer", duties: "review" },
    ]);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@everyone start together" }),
    });
    for (const bot of bots) {
      await waitFor(
        sub.events,
        (e) => e.event === "message.created" && e.kind === "bot" && e.author === bot.id,
        4000,
      );
      await waitFor(
        sub.events,
        (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === bot.id,
        4000,
      );
    }
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "system")).toBe(false);
    sub.close();
  });

  test("a mid-stream stall with usable text still inserts the bot reply", async () => {
    const encoder = new TextEncoder();
    let hang: ((reason?: unknown) => void) | null = null;
    const fixture = await startFixture(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (!(controller as { sent?: boolean }).sent) {
                (controller as { sent?: boolean }).sent = true;
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id: "chatcmpl-1",
                      choices: [{ index: 0, delta: { role: "assistant", content: "partial but usable" }, finish_reason: null }],
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
        ),
    );
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
    );
    expect(botMsg.body).toBe("partial but usable");
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "completed");
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "system")).toBe(false);
    sub.close();
  });

  test("dialing the clock to due forks a you↔Bot turn and leaves the live turn running", async () => {
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered = () => {};
    const firstInFlight = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseRoutine = () => {};
    const routineHeld = new Promise<void>((resolve) => {
      releaseRoutine = resolve;
    });
    const fixture = await startFixture(async ({ body }) => {
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (lastUser.includes("write the daily")) {
        await routineHeld;
        return sse(textChunks("routine reply"));
      }
      firstEntered();
      await firstHeld;
      return sse(textChunks("still going"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);

    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "keep going" }),
    });
    const first = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === botId,
    );
    await firstInFlight;

    const created = await fetch(`${h.origin}/v1/routines`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        bot_id: botId,
        title: "日报",
        instruction: "write the daily",
        schedule: { kind: "daily", time: "09:00" },
        enabled: false,
      }),
    });
    expect(created.status).toBe(201);
    const routine = (await created.json()) as { id: string };
    h.store.db.run(
      `UPDATE routines SET created_at = ?, last_fired_for_due_at = NULL, enabled = 1 WHERE id = ?`,
      [new Date(2026, 8, 10, 8, 0, 0).toISOString(), routine.id],
    );

    const dueNow = new Date(2026, 8, 14, 9, 0, 0);
    const opened = h.engine.fireRoutine(routine.id, dueNow);
    expect(opened).not.toBeNull();
    expect(opened!.session_id).toBe(sessionId);
    expect(opened!.bot_id).toBe(botId);
    expect(opened!.id).not.toBe(first.id);

    const trigger = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "user" && e.body === "write the daily",
    );
    expect(trigger.session_id).toBe(sessionId);
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === opened!.id && e.status === "running",
    );
    expect(h.store.getTurn(String(first.id)).status).toBe("running");
    expect(h.store.listLiveTurns({ sessionId, botId }).map((t) => t.id).sort()).toEqual(
      [String(first.id), opened!.id].sort(),
    );

    releaseRoutine();
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "routine reply",
    );
    expect(botMsg.turn_id).toBe(opened!.id);
    expect(botMsg.session_id).toBe(sessionId);
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === opened!.id && e.status === "completed",
    );
    expect(h.store.getTurn(String(first.id)).status).toBe("running");

    expect(h.store.getRoutine(routine.id).last_fired_for_due_at).toBe(dueNow.toISOString());
    expect(h.engine.fireRoutine(routine.id, dueNow)).toBeNull();

    releaseFirst();
    sub.close();
  });

  test("a due fire does not redirect a live group turn or post the instruction in the group", async () => {
    let releaseGroup = () => {};
    const groupHeld = new Promise<void>((resolve) => {
      releaseGroup = resolve;
    });
    let releaseRoutine = () => {};
    const routineHeld = new Promise<void>((resolve) => {
      releaseRoutine = resolve;
    });
    const fixture = await startFixture(async ({ body }) => {
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("你正在做一次判断")) {
        return Response.json({
          choices: [{ message: { role: "assistant", content: JSON.stringify({ decision: "pass" }) } }],
        });
      }
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (lastUser.includes("write the daily")) {
        await routineHeld;
        return sse(textChunks("routine reply"));
      }
      await groupHeld;
      return sse(textChunks("group still going"));
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
        endpoint_models: ["test-model"],
        endpoint_default_model: "test-model",
      }),
    });
    const writer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string }; direct_session: { id: string } };
    const researcher = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Researcher", duties: "read", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const group = (await (
      await fetch(`${h.origin}/v1/sessions`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Brief", members: [writer.bot.id, researcher.bot.id] }),
      })
    ).json()) as { id: string };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${group.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer keep going" }),
    });
    const groupTurn = await waitFor(
      sub.events,
      (e) =>
        e.event === "turn.upsert" &&
        e.status === "running" &&
        e.session_id === group.id &&
        e.bot_id === writer.bot.id,
    );

    const created = await fetch(`${h.origin}/v1/routines`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        bot_id: writer.bot.id,
        title: "日报",
        instruction: "write the daily",
        schedule: { kind: "daily", time: "09:00" },
        enabled: false,
      }),
    });
    const routine = (await created.json()) as { id: string };
    h.store.db.run(
      `UPDATE routines SET created_at = ?, last_fired_for_due_at = NULL, enabled = 1 WHERE id = ?`,
      [new Date(2026, 8, 10, 8, 0, 0).toISOString(), routine.id],
    );

    const opened = h.engine.fireRoutine(routine.id, new Date(2026, 8, 14, 9, 0, 0));
    expect(opened).not.toBeNull();
    expect(opened!.session_id).toBe(writer.direct_session.id);
    expect(h.store.getTurn(String(groupTurn.id)).status).toBe("running");
    expect(h.store.listMainMessages(group.id, 40).some((m) => m.body === "write the daily")).toBe(false);
    releaseRoutine();
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "routine reply",
    );

    releaseGroup();
    sub.close();
  });

  test("catch-up after a missed stretch only fires the latest due", async () => {
    const fixture = await startFixture(() => sse(textChunks("caught up")));
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);

    const created = await fetch(`${h.origin}/v1/routines`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        bot_id: botId,
        title: "日报",
        instruction: "write the daily",
        schedule: { kind: "daily", time: "09:00" },
        enabled: false,
      }),
    });
    const routine = (await created.json()) as { id: string };
    h.store.db.run(
      `UPDATE routines SET created_at = ?, last_fired_for_due_at = NULL, enabled = 1 WHERE id = ?`,
      [new Date(2026, 8, 10, 8, 0, 0).toISOString(), routine.id],
    );

    const now = new Date(2026, 8, 14, 10, 0, 0);
    const opened = h.engine.fireRoutine(routine.id, now);
    expect(opened).not.toBeNull();
    expect(opened!.session_id).toBe(sessionId);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "user" && e.body === "write the daily",
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === opened!.id && e.status === "completed",
    );

    const due = new Date(2026, 8, 14, 9, 0, 0).toISOString();
    expect(h.store.getRoutine(routine.id).last_fired_for_due_at).toBe(due);
    expect(h.engine.fireRoutine(routine.id, now)).toBeNull();

    const transcript = h.store.listMainMessages(sessionId, 40);
    expect(transcript.filter((m) => m.body === "write the daily")).toHaveLength(1);

    sub.close();
  });
});

function toolCallChunks(id: string, name: string, args: string): unknown[] {
  return [
    {
      id: "chatcmpl-1",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{ index: 0, id, function: { name, arguments: args } }],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-1",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

describe("file tools and workspace shell on the local API", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    while (workspaces.length) {
      const dir = workspaces.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createWriterIn(h: Harness, fixtureOrigin: string): Promise<{
    botId: string;
    sessionId: string;
    workspace: string;
  }> {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-file-")));
    workspaces.push(workspace);
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: workspace,
        endpoint_base_url: fixtureOrigin,
        endpoint_api_key: "sk-test",
        endpoint_models: ["test-model"],
        endpoint_default_model: "test-model",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "Writer",
        duties: "write the report",
        boundaries: "stay in the workspace",
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      bot: { id: string };
      direct_session: { id: string };
    };
    return { botId: body.bot.id, sessionId: body.direct_session.id, workspace };
  }

  test("write_file inside the workspace lands the full text and the turn finishes with a bot message", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        const tools = body.tools as Array<{ function?: { name?: string } }>;
        expect(tools.some((t) => t.function?.name === "write_file")).toBe(true);
        expect(tools.some((t) => t.function?.name === "shell")).toBe(true);
        return sse(toolCallChunks("call_w", "write_file", '{"path":"report.md","content":"full report"}'));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      expect(messages.some((m) => m.role === "tool" && String(m.content).includes('"ok":true'))).toBe(true);
      return sse(textChunks("wrote it"));
    });
    const h = await startApi();
    const { botId, sessionId, workspace } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "write the report" }),
    });
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId,
    );
    expect(botMsg.body).toBe("wrote it");
    expect(botMsg.attachments).toEqual([expect.objectContaining({ workspace_relpath: "report.md" })]);
    expect(readFileSync(join(workspace, "report.md"), "utf8")).toBe("full report");
    const route = h.store.getTurnRoute(String(botMsg.turn_id));
    expect(route).toMatchObject({
      outcome: "completed",
      hops: 2,
      tool_calls: 1,
      tool_errors: 0,
      repeated_failures: 0,
      files_written: 1,
    });
    sub.close();
  });

  test("read_file paths are inputs and do not become message attachments", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_r", "read_file", '{"path":"brief.md"}'));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      expect(messages.some((m) => m.role === "tool" && String(m.content).includes("brief text"))).toBe(true);
      return sse(textChunks("I reviewed the brief."));
    });
    const h = await startApi();
    const { botId, sessionId, workspace } = await createWriterIn(h, fixture.origin);
    writeFileSync(join(workspace, "brief.md"), "brief text");
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "review the brief" }),
    });
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId,
    );
    expect(botMsg.body).toBe("I reviewed the brief.");
    expect(botMsg.attachments).toEqual([]);
    sub.close();
  });

  test("a silent write still posts attachments when the turn has no closer", async () => {
    let hop = 0;
    const fixture = await startFixture(() => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_w", "write_file", '{"path":"notes/a.md","content":"hi"}'));
      }
      return sse(textChunks(""));
    });
    const h = await startApi();
    const { botId, sessionId, workspace } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "write notes" }),
    });
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId,
    );
    expect(botMsg.body).toBe("");
    expect(botMsg.attachments).toEqual([expect.objectContaining({ workspace_relpath: "notes/a.md" })]);
    expect(readFileSync(join(workspace, "notes/a.md"), "utf8")).toBe("hi");
    sub.close();
  });

  test("write_file outside the workspace parks waiting_approval and does not write the file", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-out-")));
    workspaces.push(outsideDir);
    const outsidePath = join(outsideDir, "secret.md");
    const fixture = await startFixture(() =>
      sse(toolCallChunks("call_out", "write_file", JSON.stringify({ path: outsidePath, content: "leak" }))),
    );
    const h = await startApi();
    const { sessionId, workspace } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "write outside" }),
    });
    const waiting = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "waiting_approval",
    );
    const card = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "approval",
    );
    expect(card.turn_id).toBe(waiting.id);
    const approvalEvent = await waitFor(sub.events, (e) => e.event === "approval.upsert");
    expect(approvalEvent.status).toBe("pending");
    expect(approvalEvent.kind_key).toBe("outside-write");
    expect(existsSync(outsidePath)).toBe(false);
    expect(existsSync(join(workspace, "secret.md"))).toBe(false);
    const pending = await fetch(`${h.origin}/v1/approvals?status=pending`, { headers: auth(h) });
    const listed = (await pending.json()) as { items: Array<{ kind_key: string; target: string }> };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.kind_key).toBe("outside-write");
    sub.close();
  });

  test("allow_once on an outside write then writes the file and finishes the turn", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-out-")));
    workspaces.push(outsideDir);
    const outsidePath = join(outsideDir, "secret.md");
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks("call_out", "write_file", JSON.stringify({ path: outsidePath, content: "leak" })),
        );
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      expect(messages.some((m) => m.role === "tool" && String(m.content).includes('"ok":true'))).toBe(true);
      return sse(textChunks("done outside"));
    });
    const h = await startApi();
    const { sessionId } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "write outside" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once" }),
    });
    expect(resolved.status).toBe(200);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "done outside",
    );
    expect(readFileSync(outsidePath, "utf8")).toBe("leak");
    sub.close();
  });

  test("a jailed shell runs immediately and returns stdout", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_sh", "shell", '{"command":"echo hello"}'));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const tool = messages.find((m) => m.role === "tool");
      expect(tool?.content).toContain('"exit_code":0');
      expect(tool?.content).toContain("hello");
      return sse(textChunks("shelled"));
    });
    const h = await startApi();
    const { sessionId } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "run echo" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "shelled",
    );
    expect(sub.events.some((e) => e.event === "approval.upsert")).toBe(false);
    sub.close();
  });

  test("a visible outside path in shell parks unconstrained-shell and does not run", async () => {
    const fixture = await startFixture(() =>
      sse(toolCallChunks("call_sh", "shell", '{"command":"cat /etc/passwd"}')),
    );
    const h = await startApi();
    const { sessionId } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "cat passwd" }),
    });
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "waiting_approval");
    const approvalEvent = await waitFor(sub.events, (e) => e.event === "approval.upsert");
    expect(approvalEvent.kind_key).toBe("unconstrained-shell");
    sub.close();
  });

  test("deny on an outside write returns denied and does not write the file", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-deny-")));
    workspaces.push(outsideDir);
    const outsidePath = join(outsideDir, "secret.md");
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks("call_out", "write_file", JSON.stringify({ path: outsidePath, content: "leak" })),
        );
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const tool = messages.find((m) => m.role === "tool");
      expect(tool?.content).toContain('"code":"denied"');
      return sse(textChunks("denied it"));
    });
    const h = await startApi();
    const { sessionId } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "write outside" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "deny" }),
    });
    expect(resolved.status).toBe(200);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "denied it",
    );
    expect(existsSync(outsidePath)).toBe(false);
    sub.close();
  });
});

describe("MCP stdio tools on the local API", () => {
  const fixturePath = join(import.meta.dir, "mcp-fixture.ts");

  async function enableProbe(
    h: Harness,
    flag?: string,
  ): Promise<void> {
    const created = await fetch(`${h.origin}/v1/mcp-servers`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "probe",
        command: process.execPath,
        args: flag ? [fixturePath, flag] : [fixturePath],
        enabled: true,
      }),
    });
    expect(created.status).toBe(201);
    if (!flag) {
      const body = (await created.json()) as { id: string };
      for (let attempt = 0; attempt < 100; attempt++) {
        const server = h.store.listMcpServers().find((row) => row.id === body.id)!;
        if (server.instructions) break;
        await Bun.sleep(10);
      }
      const server = h.store.listMcpServers().find((row) => row.id === body.id)!;
      expect(server.instructions).toContain("Echo text");
      expect(server.tool_catalog.map((t) => t.name)).toEqual(["echo", "boom", "pid"]);
    }
  }

  test("an enabled fixture server is listed and echo comes back as { ok: true, data }", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        const tools = body.tools as Array<{ function?: { name?: string } }>;
        expect(tools.some((t) => t.function?.name === "mcp_probe_echo")).toBe(true);
        expect(tools.some((t) => t.function?.name === "send_message")).toBe(true);
        return sse(toolCallChunks("call_mcp", "mcp_probe_echo", '{"text":"ping"}'));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const tool = messages.find((m) => m.role === "tool");
      expect(tool?.content).toContain('"ok":true');
      expect(tool?.content).toContain("ping");
      expect(tool?.content).not.toContain('"ok":false');
      return sse(textChunks("echoed"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    await enableProbe(h);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "use echo" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "echoed" && e.author === botId,
      4000,
    );
    sub.close();
  });

  test("MCP isError stays ok true with the original payload", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_boom", "mcp_probe_boom", "{}"));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const tool = messages.find((m) => m.role === "tool");
      expect(tool?.content).toContain('"ok":true');
      expect(tool?.content).toContain('"isError":true');
      expect(tool?.content).toContain("boom");
      return sse(textChunks("saw error"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    await enableProbe(h);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "boom" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "saw error",
      4000,
    );
    sub.close();
  });

  test("a dead MCP child is failed, not ok", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_dead", "mcp_probe_echo", '{"text":"x"}'));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const tool = messages.find((m) => m.role === "tool");
      expect(tool?.content).toContain('"ok":false');
      expect(tool?.content).toContain('"code":"failed"');
      return sse(textChunks("host died"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    await enableProbe(h, "--crash-on-call");
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "echo" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "host died",
      4000,
    );
    sub.close();
  });

  test("a disabled MCP server is not listed on the turn", async () => {
    const fixture = await startFixture(({ body }) => {
      const tools = body.tools as Array<{ function?: { name?: string } }>;
      expect(tools.some((t) => t.function?.name?.startsWith("mcp_"))).toBe(false);
      return sse(textChunks("no mcp"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    const created = await fetch(`${h.origin}/v1/mcp-servers`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "probe",
        command: process.execPath,
        args: [fixturePath],
        enabled: false,
      }),
    });
    expect(created.status).toBe(201);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "hi" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "no mcp",
    );
    sub.close();
  });

  test("add_mcp_server parks, then the next hop lists the new tools", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks(
            "call_add",
            "add_mcp_server",
            JSON.stringify({
              name: "probe",
              command: process.execPath,
              args: [fixturePath],
            }),
          ),
        );
      }
      const tools = body.tools as Array<{ function?: { name?: string } }>;
      expect(tools.some((t) => t.function?.name === "mcp_probe_echo")).toBe(true);
      return sse(textChunks("mcp ready"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "add probe" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    expect(approvalEvent.kind_key).toBe("mcp-add");
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once" }),
    });
    expect(resolved.status).toBe(200);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "mcp ready",
      4000,
    );
    expect(h.store.listMcpServers().map((s) => s.name)).toEqual(["probe"]);
    expect(h.store.listMcpServers()[0]?.instructions).toContain("Echo text");
    sub.close();
  });

  test("HTTP add_mcp_server parks a card that collects Authorization; empty allow_once stays pending", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks(
            "call_http_mcp",
            "add_mcp_server",
            JSON.stringify({
              name: "cpa",
              url: "https://cpa.example/mcp",
            }),
          ),
        );
      }
      return sse(textChunks("http mcp ready"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "add cpa mcp" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    expect(approvalEvent.kind_key).toBe("mcp-add");
    expect(approvalEvent.target).toBe("https://cpa.example/mcp");
    expect(approvalEvent.requires_api_key).toBe(true);
    const missing = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once" }),
    });
    expect(missing.status).toBe(422);
    expect(h.store.listMcpServers()).toHaveLength(0);
    const stillPending = await fetch(`${h.origin}/v1/approvals?status=pending`, { headers: auth(h) });
    const pendingBody = (await stillPending.json()) as { items: Array<{ id: string; requires_api_key: boolean }> };
    expect(pendingBody.items).toHaveLength(1);
    expect(pendingBody.items[0]?.requires_api_key).toBe(true);
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once", api_key: "Bearer secret-token" }),
    });
    expect(resolved.status).toBe(200);
    expect(JSON.stringify(await resolved.json())).not.toContain("secret-token");
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "http mcp ready",
    );
    const servers = h.store.listMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("cpa");
    expect(servers[0]?.transport).toBe("http");
    expect(servers[0]?.auth_set).toBe(true);
    expect(await h.store.mcpAuth(servers[0]!.id)).toBe("Bearer secret-token");
    sub.close();
  });

  test("a just-added MCP stays on this turn even when the trigger does not match it", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks(
            "call_add",
            "add_mcp_server",
            JSON.stringify({
              name: "github",
              command: process.execPath,
              args: [fixturePath, "--github"],
            }),
          ),
        );
      }
      const tools = body.tools as Array<{ function?: { name?: string } }>;
      expect(tools.some((t) => t.function?.name === "mcp_github_get_issue")).toBe(true);
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("GitHub issues");
      expect(system).toContain("mcp_github_get_issue");
      return sse(textChunks("mcp ready"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "add this MCP so I can search the weather" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    expect(approvalEvent.kind_key).toBe("mcp-add");
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once" }),
    });
    expect(resolved.status).toBe(200);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "mcp ready",
      4000,
    );
    sub.close();
  });

  test.each(["stdio", "http"] as const)("Bot-added image and video tools are globally available on later turns (%s)", async (transport) => {
    let url: string | undefined;
    if (transport === "http") {
      const proc = Bun.spawn([process.execPath, fixturePath, "--http", "--http-legacy-sse", "--media"], {
        stdout: "pipe", stderr: "ignore", env: { ...process.env, MCP_HTTP_AUTH: "local-fixture" },
      });
      fixtures.push({ close: async () => { proc.kill(); await proc.exited; } });
      const reader = proc.stdout.getReader();
      try {
        let line = "";
        while (!line.includes("\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("HTTP MCP fixture exited before listening");
          line += new TextDecoder().decode(chunk.value);
        }
        url = `http://127.0.0.1:${JSON.parse(line.split("\n")[0]!).port}/mcp`;
      } finally {
        reader.releaseLock();
      }
    }
    const requests: Record<string, unknown>[] = [];
    const fixture = await startFixture(({ body }) => {
      requests.push(body);
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const results = messages.filter((message) => message.role === "tool");
      if (results.length > 0) {
        const last = results.at(-1)!.content!;
        if (last.includes("fixture-video") && last.includes("pending")) {
          const tools = body.tools as Array<{ function: { name: string } }>;
          if (!tools.some((tool) => tool.function.name === "mcp_studio_check_video")) return sse(textChunks("MCP tool missing"));
          return sse(toolCallChunks("check", "mcp_studio_check_video", JSON.stringify({ job_id: "fixture-video" })));
        }
        return sse(textChunks(last));
      }
      const trigger = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      if (trigger.includes("安装")) {
        return sse(toolCallChunks("install", "add_mcp_server", JSON.stringify({
          name: "studio",
          ...(url ? { url } : { command: process.execPath, args: [fixturePath, "--media"] }),
        })));
      }
      const name = trigger.includes("视频") ? "mcp_studio_submit_video" : "mcp_studio_generate_image";
      const tools = body.tools as Array<{ function: { name: string } }>;
      if (!tools.some((tool) => tool.function.name === name)) return sse(textChunks("MCP tool missing"));
      return sse(toolCallChunks("generate", name, JSON.stringify({ prompt: "a sunset" })));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const other = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Designer", duties: "create media", boundaries: "stay" }),
    });
    expect(other.status).toBe(201);
    const { bot: otherBot, direct_session: otherSession } = await other.json() as {
      bot: { id: string };
      direct_session: { id: string };
    };
    const group = h.store.createGroup({ name: "Media", members: [botId, otherBot.id] });
    const sub = await subscribe(h);
    try {
      await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
        method: "POST", headers: auth(h), body: JSON.stringify({ body: "安装创作服务" }),
      });
      const approval = await waitFor(sub.events, (event) => event.event === "approval.upsert" && event.status === "pending");
      const resolved = await fetch(`${h.origin}/v1/approvals/${approval.id}/resolve`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ action: "allow_once", ...(url ? { api_key: "local-fixture" } : {}) }),
      });
      expect(resolved.status).toBe(200);
      await waitFor(sub.events, (event) => event.event === "message.created" && event.kind === "bot", 4000);
      expect(h.store.listMcpServers()[0]?.tool_catalog.map((tool) => tool.name)).toEqual(["generate_image", "submit_video", "check_video"]);

      for (const [session, prompt, result] of [
        [sessionId, "帮我生成一张日落图片", "generate_image: a sunset"],
        [otherSession.id, "帮我生成日落视频", "completed"],
        [sessionId, "再来一张", "generate_image: a sunset"],
        [group.id, "@Designer 帮我生成日落视频", "completed"],
      ] as const) {
        const start = sub.events.length;
        const requestStart = requests.length;
        await fetch(`${h.origin}/v1/sessions/${session}/messages`, {
          method: "POST", headers: auth(h), body: JSON.stringify({ body: prompt }),
        });
        const message = await waitFor(sub.events, (event) =>
          sub.events.indexOf(event) >= start && event.event === "message.created" && event.kind === "bot",
          4000,
        );
        expect(message.body).toContain('"ok":true');
        expect(message.body).toContain(result);
        const tools = requests[requestStart]!.tools as Array<{ function: { name: string } }>;
        expect(tools.map((tool) => tool.function.name)).toContain("mcp_studio_generate_image");
        expect(tools.map((tool) => tool.function.name)).toContain("mcp_studio_submit_video");
        expect(tools.map((tool) => tool.function.name)).toContain("mcp_studio_check_video");
        const system = (requests[requestStart]!.messages as Array<{ role: string; content: string }>).find((message) => message.role === "system")!.content;
        expect(system).toContain("Create images and videos");
      }
      const routineResponse = await fetch(`${h.origin}/v1/routines`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({
          bot_id: otherBot.id,
          title: "每日图片",
          instruction: "帮我生成一张日落图片",
          schedule: { kind: "daily", time: "09:00" },
          enabled: false,
        }),
      });
      expect(routineResponse.status).toBe(201);
      const routine = await routineResponse.json() as { id: string };
      h.store.db.run("UPDATE routines SET created_at = ?, enabled = 1 WHERE id = ?", [
        new Date(2026, 8, 10, 8).toISOString(), routine.id,
      ]);
      const opened = h.engine.fireRoutine(routine.id, new Date(2026, 8, 14, 9));
      expect(opened).not.toBeNull();
      const routineMessage = await waitFor(sub.events, (event) =>
        event.event === "message.created" && event.kind === "bot" && event.turn_id === opened!.id,
        4000,
      );
      expect(routineMessage.body).toContain("generate_image: a sunset");

      const server = h.store.listMcpServers()[0]!;
      for (const enabled of [false, true]) {
        const changed = await fetch(`${h.origin}/v1/mcp-servers/${server.id}`, {
          method: "PATCH", headers: auth(h), body: JSON.stringify({ enabled }),
        });
        expect(changed.status).toBe(200);
        const start = sub.events.length;
        await fetch(`${h.origin}/v1/sessions/${otherSession.id}/messages`, {
          method: "POST", headers: auth(h), body: JSON.stringify({ body: "再来一张" }),
        });
        const message = await waitFor(sub.events, (event) =>
          sub.events.indexOf(event) >= start && event.event === "message.created" && event.kind === "bot",
          4000,
        );
        expect(message.body).toContain(enabled ? "generate_image: a sunset" : "MCP tool missing");
      }
      const deleted = await fetch(`${h.origin}/v1/mcp-servers/${server.id}`, {
        method: "DELETE", headers: auth(h),
      });
      expect(deleted.status).toBe(204);
      const start = sub.events.length;
      await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
        method: "POST", headers: auth(h), body: JSON.stringify({ body: "帮我生成日落视频" }),
      });
      const afterDelete = await waitFor(sub.events, (event) =>
        sub.events.indexOf(event) >= start && event.event === "message.created" && event.kind === "bot",
        4000,
      );
      expect(afterDelete.body).toBe("MCP tool missing");
      expect(sub.events.filter((event) => event.event === "approval.upsert" && event.status === "pending")).toHaveLength(1);
    } finally {
      sub.close();
    }
  });

  test("every turn lists all enabled MCP tools regardless of task keywords", async () => {
    const fixture = await startFixture(({ body }) => {
      const tools = body.tools as Array<{ function?: { name?: string } }>;
      const names = tools.map((t) => t.function?.name);
      expect(names).toContain("mcp_github_get_issue");
      expect(names).toContain("mcp_probe_echo");
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("GitHub issues");
      expect(system).toContain("Echo text");
      return sse(textChunks("issue read"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    await enableProbe(h);
    const github = await fetch(`${h.origin}/v1/mcp-servers`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "github",
        command: process.execPath,
        args: [fixturePath, "--github"],
        enabled: true,
      }),
    });
    expect(github.status).toBe(201);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "read GitHub issue 12" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "issue read",
      4000,
    );
    sub.close();
  });
});

describe("bot catalog tools on the local API", () => {
  test("add_endpoint parks until allow_once with an api_key", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks(
            "call_ep",
            "add_endpoint",
            JSON.stringify({
              name: "DeepSeek",
              base_url: "https://api.deepseek.com/v1",
              models: ["deepseek-chat"],
            }),
          ),
        );
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      expect(messages.some((m) => m.role === "tool" && String(m.content).includes("DeepSeek"))).toBe(
        true,
      );
      return sse(textChunks("endpoint added"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    const before = (await h.store.listProviders()).length;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "add deepseek" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    expect(approvalEvent.kind_key).toBe("endpoint-add");
    const missing = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once" }),
    });
    expect(missing.status).toBe(422);
    expect((await h.store.listProviders()).length).toBe(before);
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once", api_key: "sk-deepseek" }),
    });
    expect(resolved.status).toBe(200);
    expect(JSON.stringify(await resolved.json())).not.toContain("sk-deepseek");
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "endpoint added",
    );
    const listed = await h.store.listProviders();
    expect(listed.length).toBe(before + 1);
    expect(listed.some((p) => p.name === "DeepSeek" && p.key_set)).toBe(true);
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
    const learning = h.store.listSessionLearnings(body.direct_session.id);
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

describe("mention spelling in groups", () => {
  test("a bot's truncated @ resolves to the only matching member and wakes it", async () => {
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const name = system.match(/## 名字\n\n(.+)/)?.[1] ?? "bot";
      if (name === "导演") return sse(textChunks("@分镜 请按锁点出六场镜表"));
      return sse(textChunks("镜表已出"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "导演", duties: "direct" },
      { name: "分镜师", duties: "storyboard" },
    ]);
    const storyboard = bots.find((b) => b.name === "分镜师")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@导演 开始" }),
    });
    const reply = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === storyboard.id,
      4000,
    );
    expect(reply.body).toBe("镜表已出");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === storyboard.id,
      4000,
    );
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "system")).toBe(false);
    sub.close();
  });

  test("a bot's @ before a digit is a timestamp, not a miss: no system note is posted", async () => {
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const name = system.match(/## 名字\n\n(.+)/)?.[1] ?? "bot";
      if (name === "导演") return sse(textChunks("全局峰值 −1.0 dB @37.79s，@分镜师 请复核"));
      return sse(textChunks("已复核"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "导演", duties: "direct" },
      { name: "分镜师", duties: "storyboard" },
    ]);
    const storyboard = bots.find((b) => b.name === "分镜师")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@导演 开始" }),
    });
    const reply = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === storyboard.id,
      4000,
    );
    expect(reply.body).toBe("已复核");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === storyboard.id,
      4000,
    );
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "system")).toBe(false);
    sub.close();
  });

  test("a bot's unknown @ leaves a system note naming the members and wakes nobody", async () => {
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const name = system.match(/## 名字\n\n(.+)/)?.[1] ?? "bot";
      if (name === "导演") return sse(textChunks("@张三 请出镜表"));
      return sse(textChunks("ok"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "导演", duties: "direct" },
      { name: "分镜师", duties: "storyboard" },
    ]);
    const director = bots.find((b) => b.name === "导演")!;
    const storyboard = bots.find((b) => b.name === "分镜师")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@导演 开始" }),
    });
    const note = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "system" && e.author === director.id,
      4000,
    );
    expect(note.body).toBe("@张三 没有匹配到群成员。在场：分镜师。点名请逐字写全名。");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === director.id,
      4000,
    );
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.bot_id === storyboard.id)).toBe(false);
    sub.close();
  });
});

describe("a Bot↔Bot direct", () => {
  async function addResearcher(h: Harness): Promise<string> {
    const res = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Researcher", duties: "dig", boundaries: "stay" }),
    });
    return ((await res.json()) as { bot: { id: string } }).bot.id;
  }

  test("one bot's message wakes the other", async () => {
    const fixture = await startFixture(() => sse(textChunks("on it")));
    const h = await startApi();
    const { botId } = await createWriter(h, fixture.origin);
    const researcherId = await addResearcher(h);
    const direct = h.store.createBotDirect(botId, researcherId, null);
    const sub = await subscribe(h);

    const opener = h.store.insertMessage({
      sessionId: direct.id,
      kind: "bot",
      author: botId,
      body: "what did you find?",
    });
    await h.engine.handleInboundMessage(opener, { fromUser: false });

    const turn = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.bot_id === researcherId && e.session_id === direct.id,
    );
    expect(turn.trigger_message_id).toBe(opener.id);
    sub.close();
  });

  /**
   * With no user in the room there is nobody to want two answers at once, so a second message
   * retunes the live turn rather than cloning it. The user↔Bot default stays fork.
   */
  test("a second message retunes the live turn instead of forking it", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    const fixture = await startFixture(async () => {
      n += 1;
      if (n === 1) {
        await held;
        return sse(textChunks("first"));
      }
      return sse(textChunks("second"));
    });
    const h = await startApi();
    const { botId } = await createWriter(h, fixture.origin);
    const researcherId = await addResearcher(h);
    const direct = h.store.createBotDirect(botId, researcherId, null);
    const sub = await subscribe(h);

    const one = h.store.insertMessage({
      sessionId: direct.id,
      kind: "bot",
      author: botId,
      body: "one",
    });
    await h.engine.handleInboundMessage(one, { fromUser: false });
    const first = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === researcherId,
    );

    const two = h.store.insertMessage({
      sessionId: direct.id,
      kind: "bot",
      author: botId,
      body: "two",
    });
    await h.engine.handleInboundMessage(two, { fromUser: false });
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === first.id && e.status === "redirected",
    );
    release();
    sub.close();
  });

  /**
   * Every publisher builds the payload from one helper. If a hand-rolled copy comes back, the
   * direct silently loses the entry point it hangs under, so pin it on the wire.
   */
  test("session.upsert carries where the direct came from", async () => {
    const fixture = await startFixture(() => sse(textChunks("ok")));
    const h = await startApi();
    const { botId } = await createWriter(h, fixture.origin);
    const researcherId = await addResearcher(h);
    const group = h.store.createGroup({ name: "Desk", members: [botId, researcherId] });
    const trigger = h.store.postMessage(group.id, { body: "price the competition" });
    const turn = h.store.createTurn({ sessionId: group.id, botId, triggerMessageId: trigger.id });
    const opened = await runCollabTool(
      { store: h.store, botId, sessionId: group.id, turnId: turn.id, parentId: null },
      "create_direct",
      { name: "Researcher" },
    );
    const directId = String(opened.data?.session_id);
    const sub = await subscribe(h);

    await fetch(`${h.origin}/v1/sessions/${directId}/archive`, {
      method: "POST",
      headers: auth(h),
    });
    const event = await waitFor(
      sub.events,
      (e) => e.event === "session.upsert" && e.id === directId,
    );
    expect(event.origin_session_id).toBe(group.id);
    expect(event.origin_message_id).toBe(trigger.id);
    sub.close();
  });
});

type LedgerRow = {
  kind: string;
  session_id: string;
  session_name: string | null;
  bot_id: string | null;
  bot_name: string | null;
  turn_id: string | null;
  judgement_id: string | null;
  chain_id: string | null;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  thinking_level: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  missing_reason: string | null;
};

/** A non-streaming answer. `usage: null` is a body with no usage; omit it to leave usage off entirely. */
function judgeBody(content: string | null, usage?: Record<string, number> | null, status = 200): Response {
  const body: Record<string, unknown> = {
    choices: content === null ? [] : [{ message: { role: "assistant", content } }],
  };
  if (usage !== undefined) body.usage = usage;
  return Response.json(body, { status });
}

function systemOf(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role?: string; content?: string }> | undefined;
  return messages?.find((row) => row.role === "system")?.content ?? "";
}

function ledger(store: Store): LedgerRow[] {
  return store.db.query<LedgerRow, []>(`SELECT * FROM spend ORDER BY created_at ASC, id ASC`).all();
}

/** The restart sweep only reviews a chain that went quiet. Age its rows past the quiet window. */
function ageChain(store: Store, quietMs: number): void {
  const at = new Date(Date.now() - quietMs).toISOString();
  store.db.run(`UPDATE turn_route_decisions SET created_at = ?`, [at]);
  store.db.run(`UPDATE route_feedback SET created_at = ?`, [at]);
}

const PICK = '{"model":"code-pro","thinking_level":"high","reason":"要改代码","continues_previous":false}';
const PICK_CONTINUE = '{"model":"code-pro","thinking_level":"high","reason":"还在改","continues_previous":true}';
const REVIEW = '{"fault":"model","direction":"stronger","rounds":1,"confidence":0.9,"reason":"改偏了"}';
const SUGGEST = JSON.stringify({
  suggestions: [{ label: "继续", prompt: "继续写" }],
});
const USAGE = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, cost_in_usd_ticks: 9 };

describe("spend ledger for routing and composer calls", () => {
  async function catalog(h: Harness, origin: string): Promise<void> {
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    const patched = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: origin,
        endpoint_api_key: "sk-test",
        endpoint_models: [
          { name: "cheap-chat", price: 1, thinking_levels: ["none", "low"], strengths: ["chat"] },
          { name: "code-pro", price: 12, thinking_levels: ["medium", "high"], strengths: ["code"] },
          { name: "flash-lite", price: 1, thinking_levels: ["low"], strengths: ["chat"] },
        ],
        endpoint_default_model: "cheap-chat",
      }),
    });
    expect(patched.status).toBe(200);
  }

  function routeAnswer(
    body: Record<string, unknown>,
    mode: "usage" | "omitted" | "error" | "down",
    pick: string = PICK,
  ): Response {
    const system = systemOf(body);
    if (mode === "down") return judgeBody(null, null, 500);
    const content =
      system === ROUTE_REVIEW_SYSTEM ? REVIEW : system === ROUTE_LEARN_SYSTEM ? "{}" : system === ROUTE_PICK_SYSTEM ? pick : "{}";
    if (mode === "error") return judgeBody(null, USAGE, 500);
    if (mode === "omitted") return judgeBody(content, null);
    return judgeBody(content, USAGE);
  }

  test("a private message, two follow-ups and a quiet close record pick, turn, review and one learn hop", async () => {
    const calls: string[] = [];
    let picks = 0;
    const fixture = await startFixture(
      ({ body }) => {
        if (isJudgementRequest(body)) return judgementPass();
        return sse(textChunks("ok", { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }));
      },
      ({ body }) => {
        calls.push(systemOf(body));
        const system = systemOf(body);
        if (system === ROUTE_PICK_SYSTEM) {
          picks += 1;
          return routeAnswer(body, "usage", picks === 1 ? PICK : PICK_CONTINUE);
        }
        return routeAnswer(body, "usage");
      },
    );
    const h = await startApi();
    await catalog(h, fixture.origin);
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
    });
    const body = (await created.json()) as { bot: { id: string; name: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    for (const text of ["把这个函数重构一下", "这里不对", "还是不行"]) {
      await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ body: text }),
      });
      const done = sub.events.filter((event) => event.event === "turn.upsert" && event.status === "completed").length;
      await waitFor(
        sub.events,
        () => sub.events.filter((event) => event.event === "turn.upsert" && event.status === "completed").length > done,
        4000,
      );
    }
    // The chain stays open until the user goes quiet. The restart sweep is that same review path.
    ageChain(h.store, 4 * 60_000);
    h.engine.sweepStaleChains();
    await waitFor(sub.events, () => calls.includes(ROUTE_LEARN_SYSTEM), 4000);
    await h.engine.drain();

    const rows = ledger(h.store);
    const kinds = rows.map((row) => row.kind);
    expect(kinds.filter((kind) => kind === "route_pick")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "turn")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "route_review")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "route_learn")).toHaveLength(1);
    const providerId = (await h.store.listProviders())[0]!.id;
    const chainId = h.store.listSessionRoutes(body.direct_session.id)[0]!.chain_id;
    for (const row of rows) {
      expect(row.session_id).toBe(body.direct_session.id);
      expect(row.session_name).toBe("Writer");
      expect(row.bot_id).toBe(body.bot.id);
      expect(row.bot_name).toBe("Writer");
      expect(row.provider_id).toBe(providerId);
      expect(row.provider_name).toBe("Default");
      expect(row.input_tokens).not.toBeNull();
      expect(row.missing_reason).toBeNull();
    }
    for (const row of rows.filter((row) => row.kind === "route_pick" || row.kind === "route_review" || row.kind === "route_learn")) {
      expect(row.model).toBe("cheap-chat");
      expect(row.thinking_level).toBeNull();
      expect(row.chain_id).toBe(row.kind === "route_pick" ? null : chainId);
    }
    const turns = h.store.listSessionRoutes(body.direct_session.id);
    expect(rows.filter((row) => row.kind === "route_pick").map((row) => row.turn_id).sort()).toEqual(
      turns.map((row) => row.turn_id).sort(),
    );
    expect(rows.find((row) => row.kind === "route_review")!.turn_id).toBe(turns[0]!.turn_id);
    expect(rows.find((row) => row.kind === "turn")!.model).toBe("code-pro");
    expect(rows.find((row) => row.kind === "turn")!.thinking_level).toBe("high");
    sub.close();
  });

  test("a clean quiet chain is recorded locally and spends nothing on review or learning", async () => {
    const calls: string[] = [];
    const fixture = await startFixture(
      () => sse(textChunks("ok")),
      ({ body }) => {
        calls.push(systemOf(body));
        return routeAnswer(body, "usage");
      },
    );
    const h = await startApi();
    await catalog(h, fixture.origin);
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
    await waitFor(sub.events, (event) => event.event === "turn.upsert" && event.status === "completed");
    ageChain(h.store, 4 * 60_000);
    h.engine.sweepStaleChains();
    await h.engine.drain();
    expect(calls).toEqual([ROUTE_PICK_SYSTEM]);
    const rows = ledger(h.store);
    expect(rows.map((row) => row.kind).sort()).toEqual(["route_pick", "turn"]);
    expect(h.store.listSessionReviews(body.direct_session.id)[0]).toMatchObject({ fault: "none" });
    sub.close();
  });

  test("a bot with model and thinking level pinned never calls routing and writes no route_pick", async () => {
    const calls: string[] = [];
    const fixture = await startFixture(
      ({ body }) => {
        expect(body.model).toBe("code-pro");
        expect(body.reasoning_effort).toBe("high");
        return sse(textChunks("ok", USAGE));
      },
      ({ body }) => {
        calls.push(systemOf(body));
        return routeAnswer(body, "usage");
      },
    );
    const h = await startApi();
    await catalog(h, fixture.origin);
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
    await waitFor(sub.events, (event) => event.event === "turn.upsert" && event.status === "completed");
    await h.engine.drain();
    expect(calls).toEqual([]);
    const rows = ledger(h.store);
    expect(rows.map((row) => row.kind)).toEqual(["turn"]);
    expect(rows[0]).toMatchObject({ model: "code-pro", thinking_level: "high", bot_id: body.bot.id });
    sub.close();
  });

  test.each(["route_pick", "route_review", "route_learn"] as const)(
    "%s records usage, an omitted body, an error that still reported usage, and nothing when the endpoint is unreachable",
    async (kind) => {
      for (const mode of ["usage", "omitted", "error", "down"] as const) {
        const calls: string[] = [];
        const fixture = await startFixture(
          () => sse(textChunks("ok")),
          ({ body }) => {
            const system = systemOf(body);
            calls.push(system);
            if (kind === "route_pick" && system === ROUTE_PICK_SYSTEM) return routeAnswer(body, mode);
            if (kind !== "route_pick" && system === ROUTE_PICK_SYSTEM) return routeAnswer(body, "usage");
            if (system === ROUTE_REVIEW_SYSTEM) {
              return kind === "route_review" ? routeAnswer(body, mode) : routeAnswer(body, "usage");
            }
            return routeAnswer(body, mode);
          },
        );
        const h = await startApi();
        await catalog(h, fixture.origin);
        const created = await fetch(`${h.origin}/v1/bots`, {
          method: "POST",
          headers: auth(h),
          body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
        });
        const body = (await created.json()) as { direct_session: { id: string } };
        const sub = await subscribe(h);
        await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
          method: "POST",
          headers: auth(h),
          body: JSON.stringify({ body: "把这个函数重构一下" }),
        });
        await waitFor(sub.events, (event) => event.event === "turn.upsert" && event.status === "completed");
        if (kind !== "route_pick") {
          await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
            method: "POST",
            headers: auth(h),
            body: JSON.stringify({ body: "这里不对" }),
          });
          await waitFor(
            sub.events,
            () => sub.events.filter((event) => event.event === "turn.upsert" && event.status === "completed").length >= 2,
          );
          ageChain(h.store, 4 * 60_000);
          h.engine.sweepStaleChains();
          if (mode !== "down" || kind !== "route_review") {
            await waitFor(sub.events, () => calls.includes(kind === "route_learn" ? ROUTE_LEARN_SYSTEM : ROUTE_REVIEW_SYSTEM), 4000);
          } else {
            await waitFor(sub.events, () => calls.includes(ROUTE_REVIEW_SYSTEM), 4000);
          }
        }
        await h.engine.drain();
        const row = ledger(h.store).find((item) => item.kind === kind);
        if (mode === "down") {
          expect(row).toBeUndefined();
        } else if (mode === "omitted") {
          expect(row).toMatchObject({ input_tokens: null, total_tokens: null, missing_reason: "endpoint_omitted" });
        } else {
          expect(row).toMatchObject({ input_tokens: 11, output_tokens: 3, total_tokens: 14, missing_reason: null });
        }
        sub.close();
        await h.close();
        harnesses.pop();
      }
    },
    20_000,
  );

  test("composer suggestions record the light model, a missing usage, an error usage, and nothing when unreachable", async () => {
    const modes = ["usage", "omitted", "error", "down"] as const;
    for (const mode of modes) {
      const fixture = await startFixture(({ body }) => {
        if (isComposerSuggestRequest(body)) {
          expect(body.model).toBe("flash-lite");
          if (mode === "down") return judgeBody(null, null, 500);
          if (mode === "error") return judgeBody(null, USAGE, 500);
          if (mode === "omitted") return judgeBody(SUGGEST, null);
          return judgeBody(SUGGEST, USAGE);
        }
        if (isJudgementRequest(body)) return judgementPass();
        return sse(textChunks("ok"));
      });
      const h = await startApi();
      await catalog(h, fixture.origin);
      const writer = (await (
        await fetch(`${h.origin}/v1/bots`, {
          method: "POST",
          headers: auth(h),
          body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
        })
      ).json()) as { bot: { id: string } };
      const reviewer = (await (
        await fetch(`${h.origin}/v1/bots`, {
          method: "POST",
          headers: auth(h),
          body: JSON.stringify({ name: "Reviewer", duties: "review", boundaries: "stay" }),
        })
      ).json()) as { bot: { id: string } };
      const groupId = ((await (
        await fetch(`${h.origin}/v1/sessions`, {
          method: "POST",
          headers: auth(h),
          body: JSON.stringify({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] }),
        })
      ).json()) as { id: string }).id;
      await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ body: "请各自介绍" }),
      });
      const res = await fetch(`${h.origin}/v1/sessions/${groupId}/composer-suggestions`, { headers: auth(h) });
      expect(res.status).toBe(200);
      const row = ledger(h.store).find((item) => item.kind === "composer_suggest");
      if (mode === "down") {
        expect(row).toBeUndefined();
        expect(await res.json()).toEqual({ items: [] });
      } else {
        expect(row).toMatchObject({
          session_id: groupId,
          session_name: "Brief",
          bot_id: null,
          bot_name: null,
          turn_id: null,
          chain_id: null,
          model: "flash-lite",
          thinking_level: null,
          provider_name: "Default",
        });
        if (mode === "omitted") {
          expect(row!.missing_reason).toBe("endpoint_omitted");
          expect(row!.input_tokens).toBeNull();
        } else {
          expect(row).toMatchObject({ input_tokens: 11, missing_reason: null });
        }
      }
      await h.close();
      harnesses.pop();
    }
  });

  test("a composer suggestion cancelled after the response came back is still recorded", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await startFixture(() => sse(textChunks("unused")));
    const h = await startApi(undefined, {
      completions: {
        complete: () => Promise.reject(new Error("unused")),
        async judge(request) {
          entered();
          await held;
          // The user's abort arrived while this call was out. The body still came back.
          expect(request.signal.aborted).toBe(true);
          return {
            content: SUGGEST,
            toolCalls: [],
            hadToolCalls: false,
            usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14, cached_tokens: null, reasoning_tokens: null, cost_usd_ticks: 9 },
            failKind: null,
          };
        },
      },
    });
    await catalog(h, fixture.origin);
    const writer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const reviewer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Reviewer", duties: "review", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const groupId = ((await (
      await fetch(`${h.origin}/v1/sessions`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] }),
      })
    ).json()) as { id: string }).id;
    const controller = new AbortController();
    const pending = h.engine.suggestComposer(groupId, controller.signal);
    await started;
    controller.abort();
    release();
    await expect(pending).resolves.toEqual([]);
    await h.engine.drain();
    const row = ledger(h.store).find((item) => item.kind === "composer_suggest");
    expect(row).toMatchObject({
      session_id: groupId,
      bot_id: null,
      model: "flash-lite",
      input_tokens: 11,
      missing_reason: null,
    });
  });

  test("a composer suggestion cancelled before any response writes no row", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (reason?: unknown) => void;
    const held = new Promise<never>((_, reject) => {
      release = reject;
    });
    const fixture = await startFixture(() => sse(textChunks("unused")));
    const h = await startApi(undefined, {
      completions: {
        complete: () => Promise.reject(new Error("unused")),
        async judge() {
          entered();
          return held;
        },
      },
    });
    await catalog(h, fixture.origin);
    const writer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const reviewer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Reviewer", duties: "review", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const groupId = ((await (
      await fetch(`${h.origin}/v1/sessions`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] }),
      })
    ).json()) as { id: string }).id;
    const controller = new AbortController();
    const pending = h.engine.suggestComposer(groupId, controller.signal);
    await started;
    controller.abort();
    release(new DOMException("aborted", "AbortError"));
    await expect(pending).resolves.toEqual([]);
    await h.engine.drain();
    expect(ledger(h.store).some((row) => row.kind === "composer_suggest")).toBe(false);
  });

  /**
   * Suggestions are drafted when someone presses ✨ and waits for them. The 8s they had as a silent
   * background fetch timed out on a thinking "flash" model (3-8s measured), and a press came back empty.
   */
  test("a composer suggestion waits long enough for a thinking model to answer", async () => {
    let timeoutMs: number | undefined;
    const fixture = await startFixture(() => sse(textChunks("unused")));
    const h = await startApi(undefined, {
      completions: {
        complete: () => Promise.reject(new Error("unused")),
        async judge(request: { timeoutMs?: number }) {
          timeoutMs = request.timeoutMs;
          return { content: SUGGEST, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
        },
      },
    });
    await catalog(h, fixture.origin);
    const writer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const reviewer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Reviewer", duties: "review", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const groupId = ((await (
      await fetch(`${h.origin}/v1/sessions`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] }),
      })
    ).json()) as { id: string }).id;
    await h.engine.suggestComposer(groupId);
    expect(timeoutMs).toBeGreaterThanOrEqual(20_000);
  });
});

for (const end of ["stop", "delete"] as const) {
  test(`returned paid turn usage survives ${end} before the response settles`, async () => {
    let entered!: () => void;
    const began = new Promise<void>((resolve) => { entered = resolve; });
    let respond!: (value: import("./completions").CompletionResult) => void;
    const pending = new Promise<import("./completions").CompletionResult>((resolve) => { respond = resolve; });
    const h = await startApi(undefined, { completions: {
      async complete() { entered(); return pending; },
      async judge() { return { content: "{}", toolCalls: [], hadToolCalls: false, usage: null, failKind: null }; },
    } });
    const provider = await h.store.createProvider({ name: "Billing", base_url: "http://unused.invalid", api_key: "fixture", models: [{ name: "model", thinking_levels: ["high"] }] });
    const created = h.store.createBot({ name: "Paid", duties: "test", boundaries: "fixture", model: "model", thinking_level: "high" });
    const trigger = h.store.postMessage(created.direct_session.id, { body: "do it" });
    await h.engine.handleInboundMessage(trigger);
    await began;
    const turn = h.store.listLiveTurns()[0]!;
    h.engine.stop(turn.id);
    if (end === "delete") {
      h.store.clearSessionMessages(created.direct_session.id);
      h.store.deleteBot(created.bot.id);
    }
    respond({ ok: true, content: "late", toolCalls: [], finishReason: "stop", hadChoices: true,
      usage: { input_tokens: 10, output_tokens: 2, cached_tokens: null, reasoning_tokens: null, total_tokens: 12, cost_usd_ticks: 8 }, missingReason: null });
    await h.engine.drain();
    expect(h.store.listSpend({ session_id: created.direct_session.id })).toMatchObject([{
      kind: "turn", turn_id: turn.id, bot_name: "Paid", session_name: "Paid", provider_id: provider.id,
      model: "model", thinking_level: "high", total_tokens: 12, cost_usd_ticks: 8,
    }]);
  });
}

test("judgements record an unspecified reasoning level when the request sends none", async () => {
  const requests: import("./completions").JudgeRequest[] = [];
  const h = await startApi(undefined, { completions: {
    async complete() { throw new Error("a pass cannot open a turn"); },
    async judge(request) { requests.push(request); return { content: '{"decision":"pass","reason":"fixture"}', toolCalls: [], hadToolCalls: false,
      usage: { input_tokens: 10, output_tokens: 2, cached_tokens: null, reasoning_tokens: null, total_tokens: 12, cost_usd_ticks: 8 }, failKind: null }; },
  } });
  await h.store.createProvider({ name: "Billing", base_url: "http://unused.invalid", api_key: "fixture", models: [{ name: "model", thinking_levels: ["high"] }] });
  const a = h.store.createBot({ name: "First", duties: "test", boundaries: "fixture", model: "model", thinking_level: "high" });
  const b = h.store.createBot({ name: "Second", duties: "test", boundaries: "fixture", model: "model", thinking_level: "high" });
  const group = h.store.createGroup({ name: "Judgements", members: [a.bot.id, b.bot.id] });
  await h.engine.handleInboundMessage(h.store.postMessage(group.id, { body: "Anyone?" }));
  await h.engine.drain();
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => !("thinkingLevel" in request))).toBe(true);
  const rows = h.store.listSpend({ session_id: group.id });
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.kind === "judgement" && row.model === "model" && row.thinking_level === null)).toBe(true);
});
