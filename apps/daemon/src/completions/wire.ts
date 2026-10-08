/** Shaping a request and reading what comes back, shared by streamed hops and judge calls: URLs, headers, messages, local sizing, usage, failures and waits. */
import type { ChatContentPart, ChatMessage, Clock, CompletionOk, CompletionResult, ContextFull, FetchLike, MappedUsage } from "../completions";
import { estimateTokens, nextBytesPerToken, overWindow, pictureCount, promptWasCut, readLessThanBefore, readLocalModels, type ThreadReading } from "../local-model";
import type { FailKind } from "../prompts";

/**
 * What the client keeps about the local models it sends to (ADR 0067): the bytes per token each
 * read its last whole requests at (by base URL and model), how each conversation's last whole
 * request was read (by base URL, model and affinity; ADR 0068), the models that refused to have
 * their thinking turned off, and where to read and record a model's window.
 */
export type LocalSizing = {
  bytesPerToken: Map<string, number>;
  lastRead: Map<string, ThreadReading>;
  noThinkOff: Set<string>;
  fetchImpl: FetchLike;
  windowOf?: (baseUrl: string, model: string) => number | undefined;
  onWindow?: (baseUrl: string, model: string, window: number) => void;
};

/** A local request clearly too big for the window its entry names: refused unsent, with the numbers. */
export function preflight(sizing: LocalSizing, request: { baseUrl: string; model: string }, bytes: number): ContextFull | null {
  const window = sizing.windowOf?.(request.baseUrl, request.model);
  const ratio = sizing.bytesPerToken.get(`${request.baseUrl} ${request.model}`);
  if (!overWindow(bytes, ratio, window)) return null;
  return { estimated: estimateTokens(bytes, ratio), ...(window ? { window } : {}) };
}

/**
 * After a local request went through: whether the tokens it reports reading say the server cut the
 * prompt — far fewer than its bytes come to, or, within one conversation (`affinity`), fewer than
 * the request before it although it sent more — and then the window the server runs with, asked
 * of it and recorded; else what this request teaches about the model's bytes per token.
 */
export async function afterLocal(
  sizing: LocalSizing,
  request: { baseUrl: string; model: string; signal: AbortSignal; messages: readonly ChatMessage[]; affinity?: string },
  bytes: number,
  usage: MappedUsage | null,
): Promise<ContextFull | null> {
  const key = `${request.baseUrl} ${request.model}`;
  const ratio = sizing.bytesPerToken.get(key);
  const read = usage?.input_tokens ?? null;
  const thread = request.affinity ? `${key} ${request.affinity}` : null;
  const pictures = pictureCount(request.messages);
  const before = thread ? sizing.lastRead.get(thread) : undefined;
  if (!promptWasCut(bytes, read, ratio) && !readLessThanBefore(before, bytes, read, pictures)) {
    const next = nextBytesPerToken(ratio, bytes, read);
    if (next !== undefined) sizing.bytesPerToken.set(key, next);
    if (thread && read && read > 0) sizing.lastRead.set(thread, { bytes, read, pictures });
    return null;
  }
  const facts = await readLocalModels(sizing.fetchImpl, request.baseUrl, [request.model], { signal: request.signal });
  const window = facts.get(request.model)?.context_window;
  if (window) sizing.onWindow?.(request.baseUrl, request.model, window);
  return { estimated: estimateTokens(bytes, ratio), read: read!, ...(window ? { window } : {}) };
}

/**
 * The `X-Session-ID` header for a request's conversation. A value that is not plain printable
 * ASCII is left out rather than sent: `fetch` throws on such a header, and every hop would fail.
 */
export function sessionHeader(affinity: string | undefined): Record<string, string> {
  return affinity && /^[\x21-\x7e]{1,128}$/.test(affinity) ? { "X-Session-ID": affinity } : {};
}

/** The key as a Bearer token; a keyless local server (ADR 0067) gets no `Authorization` header at all. */
export function bearer(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

/**
 * The loop as the endpoint takes it. Text that is only whitespace is left out: Claude refuses a
 * request holding such a text block outright ("text content blocks must contain non-whitespace
 * text"), and a model that answers "\n\n" twice in a row put one in the loop, so the next step of
 * the turn was refused. A user, system or tool-less assistant line with nothing in it is dropped,
 * an assistant line with tool calls keeps them with null content, and a tool result stays as it
 * is (it answers a call, and endpoints take an empty one).
 */
export function toApiMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    const content = m.role === "tool" ? (m.content ?? "") : withoutBlankText(m.content);
    const calls = m.role === "assistant" && m.tool_calls?.length ? m.tool_calls : null;
    if (content === null && !calls && m.role !== "tool") continue;
    const msg: Record<string, unknown> = { role: m.role, content: content ?? "" };
    if (calls) {
      msg.tool_calls = calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      }));
      if (content === null) msg.content = null;
    }
    if (m.role === "tool") msg.tool_call_id = m.tool_call_id;
    out.push(msg);
  }
  return out;
}

/** The content with whitespace-only text dropped; null when nothing is left. */
function withoutBlankText(content: ChatMessage["content"]): string | ChatContentPart[] | null {
  if (content == null) return null;
  if (typeof content === "string") return content.trim() ? content : null;
  const parts = content.filter((part) => part.type !== "text" || part.text.trim() !== "");
  return parts.length ? parts : null;
}

export type Attempt = CompletionResult & {
  retryable: boolean;
  retryBurned: boolean;
  retryAfterMs?: number;
  failKind?: FailKind;
};

/**
 * A refusal that says the prompt is over the model's context, once the cap is out of the way:
 * OpenAI's "maximum context length", llama.cpp's "exceeds the available context size", vLLM's,
 * Anthropic's "prompt is too long". Read as `context_full`, which names what to change, rather than
 * a bare refusal.
 */
export const PROMPT_OVER_CONTEXT = /context[ _]?(?:length|window|size)|maximum context|exceeds? (?:the )?(?:available )?context|prompt is too long|too many (?:input )?tokens|上下文(?:长度|窗口|限制)|超(?:出|过)[^，。,.]{0,8}上下文/i;

export async function peekJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function mapUsageFromResponse(body: unknown): MappedUsage | null {
  if (!body || typeof body !== "object") return null;
  return mapUsage((body as { usage?: unknown }).usage);
}

export function mapUsage(raw: unknown): MappedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const outDetails = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const mapped: MappedUsage = {
    input_tokens: num(u.prompt_tokens),
    output_tokens: num(u.completion_tokens),
    total_tokens: num(u.total_tokens),
    cached_tokens: num(details.cached_tokens),
    reasoning_tokens: num(outDetails.reasoning_tokens),
    cost_usd_ticks: num(u.cost_in_usd_ticks),
  };
  if (
    mapped.input_tokens == null &&
    mapped.output_tokens == null &&
    mapped.total_tokens == null &&
    mapped.cached_tokens == null &&
    mapped.reasoning_tokens == null &&
    mapped.cost_usd_ticks == null
  ) {
    return null;
  }
  return mapped;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function missingForStream(
  content: string,
  tools: Map<number, { id: string; name: string; arguments: string }>,
  usage: MappedUsage | null,
  sawUsagePacket: boolean,
  cut: boolean,
): "stream_interrupted" | "endpoint_omitted" | null {
  if (usage) return null;
  const hadOutput = content.length > 0 || tools.size > 0;
  if (cut && hadOutput && !sawUsagePacket) return "stream_interrupted";
  if (cut) return null;
  return "endpoint_omitted";
}

export function fail(
  failKind: FailKind,
  extra: {
    retryable: boolean;
    retryBurned: boolean;
    retryAfterMs?: number;
    hadChoices?: boolean;
    usage?: MappedUsage | null;
    missingReason?: CompletionOk["missingReason"];
  },
): Attempt {
  return {
    ok: false,
    failKind,
    hadChoices: extra.hadChoices ?? false,
    usage: extra.usage ?? null,
    missingReason: extra.missingReason ?? null,
    retryable: extra.retryable,
    retryBurned: extra.retryBurned,
    retryAfterMs: extra.retryAfterMs,
  };
}

export function parseRetryAfter(header: string | null, clock: Clock): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 15) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const ms = date - clock.now();
    if (ms > 0 && ms <= 15_000) return ms;
  }
  return undefined;
}

export async function abortableSleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return;
  await Promise.race([clock.sleep(ms), new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
}
