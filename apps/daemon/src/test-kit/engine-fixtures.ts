/** Fake completion endpoints and stream chunks for the turn-engine tests on the local API. */
import { ORGANIZER_SYSTEM } from "../prompts/organizer";
import { READ_BOT_LINE_SYSTEM, READ_USER_LINE_SYSTEM } from "../prompts/reader";
import { SCRIBE_SYSTEM } from "../prompts/scribe";
import { ROUTE_LEARN_SYSTEM, ROUTE_PICK_SYSTEM, ROUTE_REVIEW_SYSTEM } from "../prompts/routing";
import { Store } from "../store";
import { fixtures, startLocalApi, type Harness } from "./local-api-harness";

export function startApi(
  store?: Store,
  extra?: { completions?: import("../completions").CompletionsClient },
): Promise<Harness> {
  return startLocalApi({
    store,
    key: "sk-test",
    completions: extra?.completions,
    // The fixture endpoints on 127.0.0.1 stand for cloud ones; ADR 0067's local handling is tested on its own.
    localEndpoint: () => false,
  });
}

export type FixtureHandler = (request: {
  url: URL;
  body: Record<string, unknown>;
}) => Response | Promise<Response>;

/** The routing calls are plain completions, not streams, so they answer like the judgement does. */
export function routingAnswer(content: string): Response {
  return Response.json({ choices: [{ message: { role: "assistant", content } }] });
}

/** True for the daemon's own short calls: picking a model, reviewing a chain, learning from it, filing, noting requirements, reading a line. */
export function isRoutingCall(body: Record<string, unknown>): boolean {
  const messages = body.messages as Array<{ role?: string; content?: string }> | undefined;
  const system = messages?.find((row) => row.role === "system")?.content ?? "";
  return (
    system === ROUTE_PICK_SYSTEM ||
    system === ROUTE_REVIEW_SYSTEM ||
    system === ROUTE_LEARN_SYSTEM ||
    system === ORGANIZER_SYSTEM ||
    system === SCRIBE_SYSTEM ||
    system === READ_USER_LINE_SYSTEM ||
    system === READ_BOT_LINE_SYSTEM
  );
}

/**
 * Every turn now asks a model what to run on, so each test's scripted queue would be eaten by a
 * call it never wrote. Unless a test answers routing itself, those calls get an answer that names
 * nothing — which is exactly the case the engine handles by falling back to the rules, so a test
 * written before agent routing keeps testing what it always did.
 */
export async function startFixture(
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

export function textChunks(text: string, usage?: Record<string, number>): unknown[] {
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

export function isJudgementRequest(body: Record<string, unknown>): boolean {
  const messages = body.messages as Array<{ role: string; content?: string }>;
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  return system.includes("你正在做一次判断");
}

export function isComposerSuggestRequest(body: Record<string, unknown>): boolean {
  const messages = body.messages as Array<{ role: string; content?: string }>;
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  return system.includes("你在给用户写下一步要发进输入框的草稿");
}

export function judgementPass(): Response {
  return Response.json({
    choices: [{ message: { role: "assistant", content: JSON.stringify({ decision: "pass", reason: "no" }) } }],
  });
}

export function toolCallChunks(id: string, name: string, args: string): unknown[] {
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
