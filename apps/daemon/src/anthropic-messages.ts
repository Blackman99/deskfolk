/**
 * Anthropic's Messages API as an endpoint format (ADR 0066), beside Chat Completions. The turn loop
 * and every judge keep speaking in Chat Completions terms (`ChatMessage`, OpenAI-shaped tools,
 * `finish_reason`, `prompt_tokens`); this module turns a request into a Messages body and what
 * comes back into the same terms, so `completions.ts` keeps one retry, timer and refit path for
 * both formats.
 */
import type { ThinkingLevel } from "@real-bot/protocol";
import type { ChatContentPart, ChatMessage, MappedUsage, ToolCall } from "./completions";

export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Messages requires an output cap, where Chat Completions may leave it to the endpoint. A hop always
 * has one (the model's `max_output`, 32,768 when unset); this covers a caller that sends none.
 */
export const ANTHROPIC_DEFAULT_CAP = 32_768;

/**
 * `POST …/v1/messages` under the base URL you gave. The base is usually what Claude Code takes as
 * `ANTHROPIC_BASE_URL` (`https://api.anthropic.com`, `https://api.deepseek.com/anthropic`), without
 * `/v1`; a base that already ends in `/v1` (`http://127.0.0.1:8317/v1`) gets only `/messages`.
 */
export function anthropicUrl(baseUrl: string, resource: "messages" | "models"): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v1$/i.test(base) ? `${base}/${resource}` : `${base}/v1/${resource}`;
}

/**
 * How the key goes: `x-api-key` is Anthropic's own, and what most copies take; some of them only
 * take `Authorization: Bearer` (what Claude Code sends for `ANTHROPIC_AUTH_TOKEN`). The other one is
 * tried once the first is refused with a 401 or 403, and kept for that base URL.
 */
export type AnthropicAuth = "x-api-key" | "bearer";

export function anthropicHeaders(apiKey: string, auth: AnthropicAuth): Record<string, string> {
  return {
    ...(auth === "bearer" ? { Authorization: `Bearer ${apiKey}` } : { "x-api-key": apiKey }),
    "anthropic-version": ANTHROPIC_VERSION,
    "Content-Type": "application/json",
  };
}

// ── Thinking ───────────────────────────────────────────────────────────────────────────────────

/**
 * How one endpoint and model take a thinking level. `adaptive` is Anthropic's own for its current
 * models (`thinking: {type: "adaptive"}` with `output_config.effort`); `budget` is the older form most
 * copies still take (`thinking: {type: "enabled", budget_tokens}`); `off` sends neither. Each refusal
 * that names thinking moves one step down, and the model keeps the step it landed on.
 */
export type ThinkForm = "adaptive" | "budget" | "off";

const EFFORT: Record<string, string> = {
  minimal: "low",
  min: "low",
  low: "low",
  medium: "medium",
  default: "medium",
  high: "high",
  xhigh: "xhigh",
  extra_high: "xhigh",
  max: "max",
  maximum: "max",
};

/** Thinking tokens per level in the `budget` form, before it is fitted under the cap. */
const BUDGET: Record<string, number> = { low: 2_048, medium: 8_192, high: 16_384, xhigh: 24_576, max: 32_000 };
/** The smallest budget Anthropic takes; a cap with no room for it above the answer sends none. */
const MIN_BUDGET = 1_024;

/**
 * The thinking fields of a request. No level sends none, and the endpoint thinks as it likes. `none`
 * asks for the least: low effort in the `adaptive` form (Anthropic's newest models cannot turn
 * thinking off; on the others, no `thinking` field already means none), nothing in the others. A cap
 * too small for thinking (a verdict's 256 tokens) gets the effort alone in the `adaptive` form, as it
 * gets no budget in the `budget` one, so the answer is not spent on thinking.
 */
export function thinkingFields(form: ThinkForm, level: ThinkingLevel | null | undefined, cap: number): Record<string, unknown> {
  if (!level || form === "off") return {};
  const name = level.trim().toLowerCase();
  const off = name === "none" || name === "off";
  const effort = EFFORT[name];
  if (form === "adaptive") {
    if (off) return { output_config: { effort: "low" } };
    if (!effort) return {};
    return cap < MIN_BUDGET * 2 ? { output_config: { effort } } : { thinking: { type: "adaptive" }, output_config: { effort } };
  }
  if (off || !effort) return {};
  const budget = Math.min(BUDGET[effort] ?? BUDGET.medium!, Math.floor(cap / 2));
  return budget >= MIN_BUDGET ? { thinking: { type: "enabled", budget_tokens: budget } } : {};
}

/** Wording of a 400 about the thinking fields: the field names, or the thinking modes themselves. */
const THINKING_REFUSED = /thinking|budget_tokens|adaptive|effort|output_config/i;
/**
 * Wording of a 400 about thinking blocks in the history rather than the fields sent: "Expected
 * `thinking` or `redacted_thinking`, but found `tool_use`", a signature that does not check out.
 * Another thinking form would not change the history, so these are not refits.
 */
const THINKING_HISTORY = /^\s*expected|redacted_thinking|signature|thinking block/i;

/** The next form down after a 400 about thinking, or null when the 400 is about something else. */
export function refitThinking(body: string, form: ThinkForm, sent: Record<string, unknown>): ThinkForm | null {
  if (Object.keys(sent).length === 0 || !THINKING_REFUSED.test(body)) return null;
  if (THINKING_HISTORY.test(errorMessage(body))) return null;
  return form === "adaptive" ? "budget" : form === "budget" ? "off" : null;
}

/** The message of an Anthropic error body (`{error: {message}}`), or the body as it came. */
function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    return typeof message === "string" ? message : body;
  } catch {
    return body;
  }
}

// ── Request ────────────────────────────────────────────────────────────────────────────────────

type Block = Record<string, unknown>;
type Turn = { role: "user" | "assistant"; content: Block[] };

/**
 * The loop as a Messages body: every system message goes to the top-level `system`; tool results
 * become `tool_result` blocks in a user turn; neighbouring turns of one role are merged, since
 * Messages alternates; and a history that opens with the Bot's own line gets a user turn before it.
 * Whitespace-only text is dropped, as for Chat Completions. `carryKey` names the endpoint and model
 * this request goes to: an assistant line's thinking blocks go back only to the one that wrote them.
 */
export function toAnthropicMessages(messages: ChatMessage[], carryKey: string): { system: string; messages: Turn[] } {
  const system: string[] = [];
  const turns: Turn[] = [];
  const push = (role: Turn["role"], content: Block[]) => {
    if (content.length === 0) return;
    const last = turns.at(-1);
    if (last && last.role === role) last.content.push(...content);
    else turns.push({ role, content: [...content] });
  };
  for (const m of messages) {
    if (m.role === "system") {
      const text = plainText(m.content);
      if (text.trim()) system.push(text);
      continue;
    }
    if (m.role === "tool") {
      const content = contentBlocks(m.content);
      push("user", [{
        type: "tool_result",
        tool_use_id: toolId(m.tool_call_id ?? ""),
        ...(content.length > 0 ? { content } : {}),
      }]);
      continue;
    }
    if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.carry && m.carry.key === carryKey && m.tool_calls?.length) blocks.push(...(m.carry.blocks as Block[]));
      blocks.push(...contentBlocks(m.content));
      for (const call of m.tool_calls ?? []) {
        blocks.push({ type: "tool_use", id: toolId(call.id), name: call.name, input: toolInput(call.arguments) });
      }
      push("assistant", blocks);
      continue;
    }
    push("user", contentBlocks(m.content));
  }
  // A user turn may carry tool results and text together once merged; the results go first.
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    const results = turn.content.filter((block) => block.type === "tool_result");
    if (results.length === 0 || results.length === turn.content.length) continue;
    turn.content = [...results, ...turn.content.filter((block) => block.type !== "tool_result")];
  }
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: [{ type: "text", text: "…" }] });
  return { system: system.join("\n\n"), messages: turns };
}

/** OpenAI-shaped function tools as Messages tools. */
export function toAnthropicTools(tools: unknown[]): Block[] {
  const out: Block[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    const fn = (raw as { function?: { name?: unknown; description?: unknown; parameters?: unknown } }).function;
    if (!fn || typeof fn.name !== "string" || !fn.name) continue;
    const schema = fn.parameters && typeof fn.parameters === "object" ? (fn.parameters as Block) : {};
    out.push({
      name: fn.name,
      ...(typeof fn.description === "string" && fn.description ? { description: fn.description } : {}),
      input_schema: { ...schema, type: "object" },
    });
  }
  return out;
}

/**
 * A Messages body. Two cache breakpoints: the end of the system prompt, which with the tools before
 * it is the same for every call of a kind, and, for a turn's hop, the end of the loop, so the next hop
 * reads everything up to there from the cache. Anthropic caches nothing unasked; copies that cache by
 * themselves ignore the marks.
 */
export function anthropicBody(input: {
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  maxTokens: number;
  thinking: Record<string, unknown>;
  stream: boolean;
  carryKey: string;
  cacheLoop: boolean;
}): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(input.messages, input.carryKey);
  if (input.cacheLoop) {
    const last = messages.at(-1)?.content.at(-1);
    if (last) last.cache_control = { type: "ephemeral" };
  }
  const tools = toAnthropicTools(input.tools);
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...input.thinking,
    ...(input.stream ? { stream: true } : {}),
  };
}

function plainText(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n\n");
}

function contentBlocks(content: ChatMessage["content"]): Block[] {
  if (content == null) return [];
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  const out: Block[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.trim()) out.push({ type: "text", text: part.text });
    } else {
      const image = imageBlock(part);
      if (image) out.push(image);
    }
  }
  return out;
}

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

function imageBlock(part: Extract<ChatContentPart, { type: "image_url" }>): Block | null {
  const url = part.image_url.url;
  const data = DATA_URI.exec(url);
  if (data) return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

/**
 * A tool call id as Messages takes it (letters, digits, `_` and `-`). A loop begun on a Chat
 * Completions endpoint may hold other characters; the call and its result map the same way.
 */
function toolId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return clean || "call";
}

/** Arguments as the object a `tool_use` block holds; ones that are no JSON object go as `{}`. */
function toolInput(args: string): Block {
  try {
    const parsed = JSON.parse(args || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Block) : {};
  } catch {
    return {};
  }
}

// ── Response ───────────────────────────────────────────────────────────────────────────────────

/**
 * A stop reason in Chat Completions terms: `end_turn` and `stop_sequence` are `stop`, `tool_use` is
 * `tool_calls`, a reply at the cap or a full context is `length`, and `refusal` stays a refusal (see
 * `declinedFinish`). Anything else is passed on lower-cased.
 */
export function anthropicFinish(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower === "end_turn" || lower === "stop_sequence") return "stop";
  if (lower === "tool_use") return "tool_calls";
  if (lower === "max_tokens" || lower === "model_context_window_exceeded") return "length";
  return lower;
}

/**
 * Usage in Chat Completions terms. Messages counts the input read from the cache and the input
 * written to it apart from `input_tokens`; Chat Completions counts both inside `prompt_tokens`, and
 * the spend ledger prices `cached_tokens` as part of the input.
 */
export function mapAnthropicUsage(raw: unknown): MappedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const fresh = num(u.input_tokens);
  const written = num(u.cache_creation_input_tokens);
  const read = num(u.cache_read_input_tokens);
  const output = num(u.output_tokens);
  if (fresh == null && written == null && read == null && output == null) return null;
  const input = fresh == null && written == null && read == null ? null : (fresh ?? 0) + (written ?? 0) + (read ?? 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input != null && output != null ? input + output : null,
    cached_tokens: read,
    reasoning_tokens: null,
    cost_usd_ticks: null,
  };
}

/** A tool call delta shaped like Chat Completions' streaming `tool_calls`, which the turn reads. */
export type ToolCallDelta = { index: number; id?: string; type?: "function"; function: { name?: string; arguments?: string } };

export type StreamStep = {
  /** The reply has begun: `message_start` or any content block. */
  started?: boolean;
  text?: string;
  toolCalls?: ToolCallDelta[];
  finish?: string;
  usage?: MappedUsage;
  /** `message_stop`: the stream is whole. */
  done?: boolean;
  /** An `error` event in the stream, and whether it is the endpoint being busy. */
  error?: "busy" | "endpoint_error";
};

/**
 * Reads one Messages stream event at a time. Usage arrives in parts (input in `message_start`,
 * output in `message_delta`, some copies put all of it in the latter), so it is kept whole here and
 * every step that changes it hands the whole of it back.
 */
export class AnthropicStream {
  private usage: Record<string, unknown> = {};
  private blocks = new Map<number, Block & { tool?: number; gotJson?: boolean }>();
  private tools = 0;
  /** Thinking blocks in order, for the next hop of the turn (see `ReplyCarry`). */
  readonly thinking: Block[] = [];

  feed(event: Record<string, unknown>): StreamStep {
    switch (event.type) {
      case "message_start": {
        const message = (event.message ?? {}) as Record<string, unknown>;
        return { started: true, ...this.takeUsage(message.usage) };
      }
      case "content_block_start": {
        const index = typeof event.index === "number" ? event.index : this.blocks.size;
        const block = { ...((event.content_block ?? {}) as Block) } as Block & { tool?: number; gotJson?: boolean };
        this.blocks.set(index, block);
        if (block.type === "tool_use") {
          block.tool = this.tools++;
          return {
            started: true,
            toolCalls: [{ index: block.tool, id: String(block.id ?? ""), type: "function", function: { name: String(block.name ?? ""), arguments: "" } }],
          };
        }
        if (block.type === "text" && typeof block.text === "string" && block.text) return { started: true, text: block.text };
        return { started: true };
      }
      case "content_block_delta": {
        const index = typeof event.index === "number" ? event.index : -1;
        const block = this.blocks.get(index);
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") return { text: delta.text };
        if (delta.type === "input_json_delta" && block?.tool !== undefined && typeof delta.partial_json === "string") {
          block.gotJson = true;
          return { toolCalls: [{ index: block.tool, function: { arguments: delta.partial_json } }] };
        }
        if (block && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking}`;
        }
        if (block && delta.type === "signature_delta" && typeof delta.signature === "string") {
          block.signature = `${typeof block.signature === "string" ? block.signature : ""}${delta.signature}`;
        }
        return {};
      }
      case "content_block_stop": {
        const index = typeof event.index === "number" ? event.index : -1;
        const block = this.blocks.get(index);
        if (!block) return {};
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          const { tool: _tool, gotJson: _gotJson, ...clean } = block;
          this.thinking.push(clean);
        }
        // A call with no arguments may stream none: its input is whole in the start event.
        if (block.tool !== undefined && !block.gotJson) {
          return { toolCalls: [{ index: block.tool, function: { arguments: JSON.stringify(block.input ?? {}) } }] };
        }
        return {};
      }
      case "message_delta": {
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        const finish = typeof delta.stop_reason === "string" && delta.stop_reason ? anthropicFinish(delta.stop_reason) : undefined;
        return { ...(finish ? { finish } : {}), ...this.takeUsage(event.usage) };
      }
      case "message_stop":
        return { done: true };
      case "error": {
        const kind = ((event.error ?? {}) as Record<string, unknown>).type;
        return { error: kind === "overloaded_error" || kind === "rate_limit_error" ? "busy" : "endpoint_error" };
      }
      default:
        return {};
    }
  }

  private takeUsage(raw: unknown): { usage?: MappedUsage } {
    if (!raw || typeof raw !== "object") return {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) this.usage[key] = value;
    }
    const usage = mapAnthropicUsage(this.usage);
    return usage ? { usage } : {};
  }
}

/** A whole (non-streaming) Messages answer, in the terms a judge reads. */
export function readAnthropicMessage(body: unknown): {
  content: string | null;
  toolCalls: ToolCall[];
  usage: MappedUsage | null;
  finish: string | null;
} | null {
  if (!body || typeof body !== "object") return null;
  const message = body as Record<string, unknown>;
  if (!Array.isArray(message.content)) return null;
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const raw of message.content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    if (block.type === "tool_use" && typeof block.name === "string" && block.name) {
      toolCalls.push({
        id: typeof block.id === "string" && block.id ? block.id : `call_${toolCalls.length}`,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }
  return {
    content: text.length > 0 ? text.join("") : null,
    toolCalls,
    usage: mapAnthropicUsage(message.usage),
    finish: typeof message.stop_reason === "string" ? anthropicFinish(message.stop_reason) : null,
  };
}

/** The key a reply's carry is filed under: its endpoint and model. */
export function carryKey(baseUrl: string, model: string): string {
  return `${baseUrl} ${model}`;
}


function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
