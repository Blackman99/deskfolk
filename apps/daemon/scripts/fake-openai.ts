/**
 * A scripted OpenAI-compatible endpoint for isolated UI verification. It never calls a real model:
 * every answer is decided by the rules below, so a run is repeatable and costs nothing.
 *
 *   bun apps/daemon/scripts/fake-openai.ts            # listens on 127.0.0.1:17917
 *   REAL_BOT_FAKE_PORT=17918 bun apps/daemon/scripts/fake-openai.ts
 *
 * Routes:
 *   GET  /v1/models                 — one model, `fixture`, with thinking levels.
 *   POST /v1/chat/completions       — `stream: false` (judgement, route pick, suggestions) answers `{}`;
 *                                     `stream: true` answers by the rules below, as SSE.
 *   POST /__next  { reply }         — queue one scripted reply: `{ content }` or `{ tool_calls: [{ name, arguments }] }`.
 *   GET  /__log                     — every request received, newest last (messages trimmed).
 *
 * Rules for a streamed turn, when nothing is queued:
 *   1. The last message is a tool result → a short closing reply.
 *   2. The trigger carries a batch of annotations (`[批注 i/n · id=…]` / `[Annotation i/n · id=…]`) →
 *      one `resolve_annotation` call per id, each with a note; then (rule 1) a closing reply.
 *   3. Otherwise → a plain acknowledgement quoting the first line of the trigger.
 */

type ChatPart = { type: string; text?: string };
type ChatMessage = { role: string; content: string | ChatPart[] | null; tool_calls?: unknown[]; tool_call_id?: string };
type Scripted = { content?: string; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> };

const port = Number(process.env.REAL_BOT_FAKE_PORT ?? 17917);
const queue: Scripted[] = [];
const log: Array<{ at: string; stream: boolean; tools: string[]; last: string; images: number }> = [];
let callSeq = 0;

function text(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
}

function images(content: ChatMessage["content"]): number {
  return Array.isArray(content) ? content.filter((part) => part.type === "image_url").length : 0;
}

/** The trigger: the user-role message the daemon marked `（本轮触发）`, else the last user message. */
function trigger(messages: ChatMessage[]): ChatMessage | undefined {
  const users = messages.filter((m) => m.role === "user");
  return users.find((m) => text(m.content).includes("（本轮触发）")) ?? users.at(-1);
}

function decide(messages: ChatMessage[]): Scripted {
  const queued = queue.shift();
  if (queued) return queued;
  const last = messages.at(-1);
  if (last?.role === "tool") {
    const resolved = messages.filter((m) => m.role === "tool" && text(m.content).includes('"resolved"')).length;
    return { content: resolved > 0 ? `已按批注改好，逐条标成了已处理（${resolved} 条）。` : "好了。" };
  }
  const body = text(trigger(messages)?.content ?? "");
  const ids = [...body.matchAll(/\[(?:批注|Annotation) \d+\/\d+ · id=([0-9A-HJKMNP-TV-Z]{26})\]/g)].map((m) => m[1]!);
  if (ids.length > 0) {
    return {
      tool_calls: ids.map((id, i) => ({ name: "resolve_annotation", arguments: { id, note: `按第 ${i + 1} 条意见改了` } })),
    };
  }
  const first = body.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("【") && line !== "（本轮触发）") ?? "";
  return { content: `收到：${first.slice(0, 60)}` };
}

function sse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

function streamed(reply: Scripted): Response {
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  const chunks: unknown[] = [];
  if (reply.tool_calls?.length) {
    reply.tool_calls.forEach((call, index) => {
      chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${++callSeq}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] });
    });
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    const content = reply.content ?? "";
    for (let i = 0; i < content.length; i += 12) chunks.push({ choices: [{ index: 0, delta: { content: content.slice(i, i + 12) } }] });
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  chunks.push({ choices: [], usage });
  return sse(chunks);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "fixture", object: "model", reasoning_efforts: ["low", "medium", "high"] }] });
    }
    if (request.method === "GET" && url.pathname === "/__log") return Response.json(log);
    if (request.method === "POST" && url.pathname === "/__next") {
      const body = (await request.json()) as { reply?: Scripted };
      if (body.reply) queue.push(body.reply);
      return Response.json({ queued: queue.length });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = (await request.json()) as { messages?: ChatMessage[]; stream?: boolean; tools?: Array<{ function?: { name?: string } }> };
      const messages = body.messages ?? [];
      const last = trigger(messages);
      log.push({
        at: new Date().toISOString(),
        stream: Boolean(body.stream),
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? "?"),
        last: text(last?.content ?? "").slice(0, 4000),
        images: messages.reduce((n, m) => n + images(m.content), 0),
      });
      if (!body.stream) {
        return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
      }
      return streamed(decide(messages));
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`fake OpenAI endpoint on http://${server.hostname}:${server.port}/v1`);
