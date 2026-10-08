import { isLocalEndpoint, type ApiFormat, type ThinkingLevel } from "@real-bot/protocol";
import {
  ANTHROPIC_DEFAULT_CAP,
  AnthropicStream,
  anthropicBody,
  anthropicHeaders,
  anthropicUrl,
  carryKey,
  mapAnthropicUsage,
  readAnthropicMessage,
  refitThinking,
  thinkingFields,
  type AnthropicAuth,
  type ThinkForm,
} from "./anthropic-messages";
import type { FailKind } from "./prompts";
import { declinedFinish, RepeatWatch } from "./hop-limits";
import {
  ThinkStrip,
  estimateTokens,
  nextBytesPerToken,
  overWindow,
  pictureCount,
  promptBytes,
  promptWasCut,
  readLessThanBefore,
  readLocalModels,
  stripLeadingThink,
  type ThreadReading,
} from "./local-model";
import type { WakeWatch } from "./wake";
import type { PromptRef } from "./prompts/registry";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: ChatRole;
  content?: string | ChatContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** What the endpoint that wrote this assistant line needs back with it (see `ReplyCarry`). */
  carry?: ReplyCarry;
};

/**
 * Parts of a reply that only its own endpoint reads, kept with the assistant line for the rest of
 * the turn: an Anthropic-format model that thought before calling tools refuses the next hop unless
 * its thinking blocks come back unchanged with the calls. `key` is the endpoint and model that wrote
 * them; any other one is sent the line without them.
 */
export type ReplyCarry = { key: string; blocks: unknown[] };

export type MappedUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd_ticks: number | null;
};

export type CompletionOk = {
  ok: true;
  content: string;
  toolCalls: ToolCall[];
  /** Lower-cased, with the other names endpoints give the output cap read as `length`. */
  finishReason: string | null;
  hadChoices: boolean;
  usage: MappedUsage | null;
  missingReason: "stream_interrupted" | "endpoint_omitted" | null;
  /**
   * The reply reached the output cap (`finish_reason: "length"`) partway through a tool call's
   * arguments. A call cut off there cannot run, so `toolCalls` is empty and the caller decides how to
   * go on. Absent is false.
   */
  toolArgsCut?: boolean;
  /** Present when the endpoint wants parts of this reply back on the next hop (see `ReplyCarry`). */
  carry?: ReplyCarry;
};

export type CompletionFail = {
  ok: false;
  failKind: FailKind;
  hadChoices: boolean;
  usage: MappedUsage | null;
  missingReason: "stream_interrupted" | "endpoint_omitted" | null;
  /** With `context_full`: the numbers behind it, for the line the turn fails with (ADR 0067). */
  contextFull?: ContextFull;
};

/**
 * A prompt the model's context window could not hold. `estimated` is the request's size by the
 * bytes sent; `read` is what the endpoint reported reading when it cut the prompt instead of
 * refusing it; `window` is the window the server runs with, when it said.
 */
export type ContextFull = { estimated: number; read?: number; window?: number };

export type CompletionResult = CompletionOk | CompletionFail;

export type CompletionsClient = {
  complete(request: CompletionRequest): Promise<CompletionResult>;
  judge(request: JudgeRequest): Promise<JudgeResult>;
};

export type CompletionRequest = {
  baseUrl: string;
  apiKey: string;
  /** The endpoint's wire format; absent is `openai` (Chat Completions). */
  apiFormat?: ApiFormat;
  model: string;
  thinkingLevel: ThinkingLevel;
  messages: ChatMessage[];
  tools: unknown[];
  signal: AbortSignal;
  /**
   * Sent as `max_tokens`, or as `max_completion_tokens` to a model that asked for that name. A model
   * that allows less gets the limit its endpoint named when it refused this one, or no cap. Absent
   * leaves the cap to the endpoint.
   */
  maxTokens?: number;
  /**
   * How long one attempt may stream, from sending the request to the end of the stream; past it the
   * attempt fails as `overtime` and is not sent again. Time asleep does not count. Absent, only the
   * first-byte and idle timers bound it.
   */
  wallMs?: number;
  /**
   * Which conversation this request belongs to, sent as `X-Session-ID`. A proxy that spreads
   * requests over several accounts (CLIProxyAPI with `routing.session-affinity`) keeps one
   * conversation on one account by it, and the account's prompt cache is what a step reuses.
   */
  affinity?: string;
  onEvent?: (chunk: Record<string, unknown>) => void;
  onToken?: (text: string) => void;
  /**
   * `reading`: something you wait on that must not queue behind the Bots' hops in the app's own
   * per-origin slots — a speed test you pressed (ADR 0067). Takes the readings' slots.
   */
  lane?: "reading";
};

export type JudgeRequest = {
  baseUrl: string;
  apiKey: string;
  /** The endpoint's wire format; absent is `openai` (Chat Completions). */
  apiFormat?: ApiFormat;
  model: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  /** Override the first-byte timeout used for this short call. */
  timeoutMs?: number;
  /**
   * Tools this short call may use. Absent keeps the call tool-less, which is what the routing
   * calls are. Present, the answer's tool calls come back for the caller to run.
   */
  tools?: unknown[];
  /**
   * The answer's token cap. Absent is sized for a verdict: 256 tool-less, 512 with tools. A caller
   * that asks for a document back (the organizer's plan) has to say how much room it needs, or the
   * answer stops mid-sentence.
   */
  maxTokens?: number;
  /**
   * Sent as `reasoning_effort` when given. Absent sends none, and the endpoint thinks as it likes;
   * a reading the app waits on asks for the lightest the model lists (ADR 0055).
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * `reading`: a reading the app waits on before it acts on a line (ADR 0055). It takes its own
   * per-origin slots instead of queueing behind the Bots' streaming hops, which can hold the shared
   * ones for minutes; a stop said while two Bots stream must not wait for either of them.
   */
  lane?: "reading";
  /**
   * Which built-in prompt the system message is, and which revision of yours it ran on (ADR 0064).
   * A failed reading is recorded against it, and tests tell calls apart by it rather than by their
   * text, which you may have changed. Only its id goes to the endpoint, as the call's `X-Session-ID`
   * (see `CompletionRequest.affinity`): calls of one kind share their fixed system message.
   */
  prompt?: PromptRef;
};

export type JudgeResult = {
  content: string | null;
  toolCalls: ToolCall[];
  /** True when the answer carried any tool call. Derived so callers can read either field. */
  hadToolCalls: boolean;
  usage: MappedUsage | null;
  failKind: FailKind | null;
  /**
   * The answer stopped at the token cap (`finish_reason: "length"`) or at a full context, so what
   * came back is only its start. Absent is false. It is not a failure here: a short verdict cut off
   * can still read, so each caller decides what a cut-off answer is worth.
   */
  truncated?: boolean;
};

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  firstByteMs: number;
  idleMs: number;
};

const DEFAULT_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  firstByteMs: 120_000,
  idleMs: 180_000,
};

/**
 * A model server on this computer or network (ADR 0067) gets longer: before its first byte it may
 * load the model (Ollama allows five minutes), wait behind another request (Ollama serves one at a
 * time unless told otherwise) and read a prompt of tens of thousands of tokens at a few hundred a
 * second — 57 s for 49,837 tokens on an 8B model, 2026-10-08.
 */
export const LOCAL_FIRST_BYTE_MS = 15 * 60_000;
export const LOCAL_IDLE_MS = 5 * 60_000;
/** A short call to a local server that the app does not wait on gets at least this long. */
export const LOCAL_JUDGE_MS = 10 * 60_000;
/**
 * Streams sent at once to one local server. It serves one request at a time by default, and a
 * request queued there runs out its first-byte time behind a hop of twenty minutes; queued here it
 * waits without a clock.
 */
const LOCAL_STREAM_LIMIT = 1;

const MAX_ATTEMPTS = 3;
/** Failures that only say the network was not there: the ones a sleep produces. */
const NETWORK_FAILS: ReadonlySet<FailKind> = new Set<FailKind>(["unreachable", "first_byte", "stalled"]);
/** How many times sleep may send one request back without it using up an attempt. */
const WAKE_RETRIES = 10;
const ORIGIN_STREAM_LIMIT = 2;

type OriginGate = {
  acquire: (key: string, signal: AbortSignal) => Promise<boolean>;
  release: (key: string) => void;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CompletionsOptions = {
  fetch?: FetchLike;
  clock?: Partial<Clock>;
  originLimit?: number;
  wake?: WakeWatch;
  /** Whether a base URL is a model server on this computer or network; tests turn it off. */
  local?: (baseUrl: string) => boolean;
  /** A model's context window as its endpoint entry has it (ADR 0067), checked before a local request is sent. */
  windowOf?: (baseUrl: string, model: string) => number | undefined;
  /** The window a local server said it runs a model with, read when a prompt came back cut. */
  onWindow?: (baseUrl: string, model: string, window: number) => void;
};

export function createCompletionsClient(options: CompletionsOptions = {}): CompletionsClient {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const clock: Clock = { ...DEFAULT_CLOCK };
  if (options.clock?.now) clock.now = options.clock.now;
  if (options.clock?.sleep) clock.sleep = options.clock.sleep;
  if (options.clock?.firstByteMs) clock.firstByteMs = options.clock.firstByteMs;
  if (options.clock?.idleMs) clock.idleMs = options.clock.idleMs;
  // A clock a test set stays as set; otherwise a local server gets its own, longer timers.
  const localClock: Clock = {
    ...clock,
    firstByteMs: options.clock?.firstByteMs ?? LOCAL_FIRST_BYTE_MS,
    idleMs: options.clock?.idleMs ?? LOCAL_IDLE_MS,
  };
  const isLocal = options.local ?? isLocalEndpoint;
  const gate = createOriginGate(options.originLimit ?? ORIGIN_STREAM_LIMIT);
  const localGate = createOriginGate(options.originLimit ?? LOCAL_STREAM_LIMIT);
  const readingGate = createOriginGate(options.originLimit ?? ORIGIN_STREAM_LIMIT);
  const forms: Forms = { cap: new Map(), think: new Map(), auth: new Map() };
  const sizing: LocalSizing = {
    bytesPerToken: new Map(),
    lastRead: new Map(),
    noThinkOff: new Set(),
    fetchImpl,
    windowOf: options.windowOf,
    onWindow: options.onWindow,
  };

  return {
    async complete(request) {
      if (!isLocal(request.baseUrl)) return completeStreaming(fetchImpl, clock, request.lane === "reading" ? readingGate : gate, request, forms, options.wake);
      return completeStreaming(fetchImpl, localClock, request.lane === "reading" ? readingGate : localGate, request, forms, options.wake, sizing);
    },
    async judge(request) {
      const local = isLocal(request.baseUrl);
      const laneGate = request.lane === "reading" ? readingGate : local ? localGate : gate;
      return completeJudge(fetchImpl, clock, laneGate, request, forms, local ? sizing : undefined);
    },
  };
}

/**
 * What the client keeps about the local models it sends to (ADR 0067): the bytes per token each
 * read its last whole requests at (by base URL and model), how each conversation's last whole
 * request was read (by base URL, model and affinity; ADR 0068), the models that refused to have
 * their thinking turned off, and where to read and record a model's window.
 */
type LocalSizing = {
  bytesPerToken: Map<string, number>;
  lastRead: Map<string, ThreadReading>;
  noThinkOff: Set<string>;
  fetchImpl: FetchLike;
  windowOf?: (baseUrl: string, model: string) => number | undefined;
  onWindow?: (baseUrl: string, model: string, window: number) => void;
};

/** A local request clearly too big for the window its entry names: refused unsent, with the numbers. */
function preflight(sizing: LocalSizing, request: { baseUrl: string; model: string }, bytes: number): ContextFull | null {
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
async function afterLocal(
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
function bearer(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function completionsUrl(baseUrl: string): string {
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
function toApiMessages(messages: ChatMessage[]): unknown[] {
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

/**
 * How one endpoint and model take the output cap, once they have refused it the first way. Most
 * endpoints take `max_tokens` as asked, so that is what goes first. OpenAI's reasoning models refuse
 * `max_tokens` with a 400 that names `max_completion_tokens`, and a model that writes less than the
 * cap refuses it as too large, usually stating its own limit (DeepSeek's 8,192, OpenAI gpt-4o's
 * 16,384). Before hops had a cap those requests went through, so a refusal like that must not fail
 * the turn.
 */
type CapForm = {
  field: "max_tokens" | "max_completion_tokens";
  /** The model's own limit, read from the refusal; null sends no cap; absent sends the hop's. */
  limit?: number | null;
};
/** Keyed by base URL and model. */
type CapForms = Map<string, CapForm>;

/**
 * What this client learned about how each endpoint takes a request, from the requests it refused:
 * the output cap (by base URL and model), and for the Anthropic format the thinking fields (by base
 * URL and model) and the key header (by base URL). Kept for the daemon's life.
 */
type Forms = {
  cap: CapForms;
  think: Map<string, ThinkForm>;
  auth: Map<string, AnthropicAuth>;
};

async function completeStreaming(
  fetchImpl: FetchLike,
  clock: Clock,
  gate: OriginGate,
  request: CompletionRequest,
  forms: Forms,
  wake?: WakeWatch,
  sizing?: LocalSizing,
): Promise<CompletionResult> {
  let lastFail: FailKind = "unreachable";
  let lastUsage: MappedUsage | null = null;
  let lastMissing: CompletionOk["missingReason"] = null;
  let lastHadChoices = false;
  const key = originKey(request.baseUrl);
  let wakeRetries = 0;
  // A local server cuts a prompt past its window instead of refusing it (ADR 0067): one clearly too
  // big for the window on record is not sent at all, and one that came back cut fails the hop.
  const bytes = sizing ? promptBytes(request.messages, request.tools) : 0;
  const tooBig = sizing ? preflight(sizing, request, bytes) : null;
  if (tooBig) return { ok: false, failKind: "context_full", hadChoices: false, usage: null, missingReason: null, contextFull: tooBig };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (request.signal.aborted) {
      return { ok: false, failKind: lastFail, hadChoices: lastHadChoices, usage: lastUsage, missingReason: lastMissing };
    }
    if (attempt > 0) {
      const delay = attempt === 1 ? 1000 : 2000;
      await abortableSleep(clock, delay, request.signal);
      if (request.signal.aborted) break;
    }
    const acquired = await gate.acquire(key, request.signal);
    if (!acquired) {
      return { ok: false, failKind: lastFail, hadChoices: lastHadChoices, usage: lastUsage, missingReason: lastMissing };
    }
    let result: Attempt;
    const startedAt = clock.now();
    const sleptThrough = wake ? () => wake.sleptBetween(startedAt, clock.now()) > 0 : undefined;
    try {
      result = await oneStreamAttempt(fetchImpl, clock, request, forms, sleptThrough, sizing !== undefined);
    } finally {
      gate.release(key);
    }
    lastFail = result.failKind ?? "incomplete";
    lastUsage = result.usage;
    lastMissing = result.missingReason;
    lastHadChoices = result.hadChoices;
    if (result.ok && sizing) {
      const cut = await afterLocal(sizing, request, bytes, result.usage);
      if (cut) return { ok: false, failKind: "context_full", hadChoices: true, usage: result.usage, missingReason: result.missingReason, contextFull: cut };
    }
    if (result.ok) return result;
    if (!result.retryable) return result;
    // The Mac slept through this attempt, or woke and sent it before Wi-Fi was back: none of that
    // is about the endpoint. Wait for the network and go again without spending an attempt.
    if (
      wake &&
      wakeRetries < WAKE_RETRIES &&
      NETWORK_FAILS.has(lastFail) &&
      (sleptThrough!() || !wake.settled(clock.now()))
    ) {
      wakeRetries += 1;
      attempt -= 1;
      if (!(await wake.untilSettled(request.signal))) break;
      continue;
    }
    if (result.retryAfterMs) {
      await abortableSleep(clock, result.retryAfterMs, request.signal);
    }
  }
  return {
    ok: false,
    failKind: lastFail,
    hadChoices: lastHadChoices,
    usage: lastUsage,
    missingReason: lastMissing,
  };
}

type Attempt = CompletionResult & {
  retryable: boolean;
  retryBurned: boolean;
  retryAfterMs?: number;
  failKind?: FailKind;
};

async function oneStreamAttempt(
  fetchImpl: FetchLike,
  clock: Clock,
  request: CompletionRequest,
  forms: Forms,
  sleptThrough?: () => boolean,
  local = false,
): Promise<Attempt> {
  const wallAt = request.wallMs ? clock.now() + request.wallMs : Number.POSITIVE_INFINITY;
  const capForms = forms.cap;
  const capKey = `${request.baseUrl} ${request.model}`;
  if (request.apiFormat === "anthropic") {
    let response: Response;
    try {
      response = await postAnthropic(fetchImpl, request, forms, {
        stream: true,
        tools: request.tools,
        maxTokens: request.maxTokens ?? ANTHROPIC_DEFAULT_CAP,
        refitCap: true,
        cacheLoop: true,
        affinity: request.affinity,
      });
    } catch {
      return fail("unreachable", { retryable: !request.signal.aborted, retryBurned: false });
    }
    // A prompt over the model's context ("prompt is too long: 210000 tokens > 200000 maximum"),
    // once the cap is out of the way, reads as it does on Chat Completions (ADR 0068).
    if (response.status === 400) {
      const refusal = await response.text().catch(() => "");
      return fail(PROMPT_OVER_CONTEXT.test(refusal) ? "context_full" : "refused", { retryable: false, retryBurned: false });
    }
    return streamResponse(response, clock, request, wallAt, sleptThrough, local);
  }
  const post = (form: CapForm) =>
    fetchImpl(completionsUrl(request.baseUrl), {
      method: "POST",
      headers: {
        ...bearer(request.apiKey),
        "Content-Type": "application/json",
        ...sessionHeader(request.affinity),
      },
      body: JSON.stringify({
        model: request.model,
        ...(request.thinkingLevel ? { reasoning_effort: request.thinkingLevel } : {}),
        [form.field]: capSent(form, request.maxTokens),
        messages: toApiMessages(request.messages),
        tools: request.tools.length ? request.tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    });
  let response: Response;
  // The refusal last read, which says whether the prompt itself is over the model's context.
  let refusal: string | null = null;
  try {
    let form = capForms.get(capKey) ?? { field: "max_tokens" };
    response = await post(form);
    // Refused for the cap alone: sent again at once the way the endpoint asked. Each refit only
    // renames the field once or lowers the cap, so a few are enough: a reasoning model may want the
    // other name and then a lower limit, and a full context comes on top of either.
    for (let refits = 0; refits < 3 && response.status === 400; refits++) {
      refusal = await response.text();
      const refit = refitCap(refusal, form, request.maxTokens);
      if (!refit) break;
      form = refit.form;
      if (refit.keep) capForms.set(capKey, form);
      response = await post(form);
      refusal = null;
    }
    if (response.status === 400) {
      refusal ??= await response.text().catch(() => "");
      if (PROMPT_OVER_CONTEXT.test(refusal)) return fail("context_full", { retryable: false, retryBurned: false });
    }
  } catch {
    if (request.signal.aborted) {
      return fail("unreachable", { retryable: false, retryBurned: false });
    }
    return fail("unreachable", { retryable: true, retryBurned: false });
  }
  return streamResponse(response, clock, request, wallAt, sleptThrough, local);
}

/**
 * A refusal that says the prompt is over the model's context, once the cap is out of the way:
 * OpenAI's "maximum context length", llama.cpp's "exceeds the available context size", vLLM's,
 * Anthropic's "prompt is too long". Read as `context_full`, which names what to change, rather than
 * a bare refusal.
 */
const PROMPT_OVER_CONTEXT = /context[ _]?(?:length|window|size)|maximum context|exceeds? (?:the )?(?:available )?context|prompt is too long|too many (?:input )?tokens|上下文(?:长度|窗口|限制)|超(?:出|过)[^，。,.]{0,8}上下文/i;

/** What a streaming request's response is worth: a failure by its status, or its stream read. */
function streamResponse(
  response: Response,
  clock: Clock,
  request: CompletionRequest,
  wallAt: number,
  sleptThrough?: () => boolean,
  local = false,
): Promise<Attempt> | Attempt {
  if (response.status === 429) {
    return fail("busy", {
      retryable: true,
      retryBurned: false,
      retryAfterMs: parseRetryAfter(response.headers.get("Retry-After"), clock),
    });
  }
  if (response.status >= 500) {
    return fail("endpoint_error", { retryable: true, retryBurned: false });
  }
  if (response.status >= 400) {
    return fail("refused", { retryable: false, retryBurned: false });
  }

  if (!response.body) {
    return fail("incomplete", { retryable: false, retryBurned: false, hadChoices: false });
  }

  return readSse(response.body, clock, request, wallAt, sleptThrough, local);
}

/**
 * One Messages request, sent again at once while the endpoint refuses it for how it was asked: the
 * key header (401/403, tried the other way once per base URL), the thinking fields (400 naming them,
 * one form down) and, for a hop, the output cap (as for Chat Completions). Messages takes no request
 * without a cap, so a cap the refit would leave out stays as it was.
 */
async function postAnthropic(
  fetchImpl: FetchLike,
  request: CompletionRequest | JudgeRequest,
  forms: Forms,
  opts: {
    stream: boolean;
    tools: unknown[];
    maxTokens: number;
    refitCap: boolean;
    cacheLoop: boolean;
    affinity: string | undefined;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const key = `${request.baseUrl} ${request.model}`;
  const authKey = request.baseUrl;
  let auth: AnthropicAuth = forms.auth.get(authKey) ?? "x-api-key";
  let think: ThinkForm = forms.think.get(key) ?? "adaptive";
  let cap: CapForm = (opts.refitCap ? forms.cap.get(key) : undefined) ?? { field: "max_tokens" };
  let triedAuth = false;
  const capOf = (form: CapForm) => capSent(form, opts.maxTokens) ?? opts.maxTokens;
  const post = () => {
    const maxTokens = capOf(cap);
    const thinking = thinkingFields(think, request.thinkingLevel, maxTokens);
    return {
      thinking,
      response: fetchImpl(anthropicUrl(request.baseUrl, "messages"), {
        method: "POST",
        headers: { ...anthropicHeaders(request.apiKey, auth), ...sessionHeader(opts.affinity) },
        body: JSON.stringify(anthropicBody({
          model: request.model,
          messages: request.messages,
          tools: opts.tools,
          maxTokens,
          thinking,
          stream: opts.stream,
          carryKey: carryKey(request.baseUrl, request.model),
          cacheLoop: opts.cacheLoop,
        })),
        signal: opts.signal ?? request.signal,
      }),
    };
  };
  let sent = post();
  let response = await sent.response;
  // A thinking form a refusal stepped down to is kept for the model only once a request in it got
  // past the 400: one that failed anyway says nothing about the form.
  let thinkStepped = false;
  for (let refits = 0; refits < 5; refits++) {
    if ((response.status === 401 || response.status === 403) && !triedAuth) {
      triedAuth = true;
      const first = auth;
      auth = first === "x-api-key" ? "bearer" : "x-api-key";
      const retry = post();
      const answer = await retry.response;
      if (answer.status === 401 || answer.status === 403) {
        // Refused the other way too: the key itself is wrong, and the first answer says so.
        await answer.body?.cancel().catch(() => {});
        auth = first;
        break;
      }
      forms.auth.set(authKey, auth);
      sent = retry;
      response = answer;
      continue;
    }
    if (response.status !== 400) break;
    const body = await response.text();
    const nextThink = refitThinking(body, think, sent.thinking);
    if (nextThink) {
      think = nextThink;
      thinkStepped = true;
    } else {
      const refit = opts.refitCap ? refitCap(body, cap, opts.maxTokens) : null;
      if (!refit || capOf(refit.form) === capOf(cap)) {
        response = new Response(body, { status: 400, headers: response.headers });
        break;
      }
      cap = refit.form;
      if (refit.keep) forms.cap.set(key, cap);
    }
    sent = post();
    response = await sent.response;
  }
  if (thinkStepped && response.status !== 400) forms.think.set(key, think);
  return response;
}

/**
 * The `X-Session-ID` of a judge call: calls of one kind share their fixed system message (see
 * `JudgeRequest.prompt`). A reading you wait on is short and not worth keeping on one account: it
 * would queue there.
 */
function judgeAffinity(request: JudgeRequest): string | undefined {
  return request.prompt && request.lane !== "reading" ? `deskfolk-${request.prompt.id}` : undefined;
}

function capSent(form: CapForm, maxTokens: number | undefined): number | undefined {
  if (maxTokens === undefined || form.limit === null) return undefined;
  return form.limit === undefined ? maxTokens : Math.min(form.limit, maxTokens);
}

/** The names endpoints give the output cap in their errors, Gemini's `maxOutputTokens` included. */
const CAP_NAMED = /max[_ ]?(?:completion[_ ]?|output[_ ]?)?tokens/i;
/**
 * Wording that says the cap is more than the model allows. Not "invalid": OpenAI's every error has
 * the type `invalid_request_error`.
 */
const CAP_TOO_LARGE = /too large|too big|range|at most|maximum|exceed|greater than|less than|超过|超出|范围|非法/i;
/**
 * Where a refusal states the model's own limit, with what to take off it: OpenAI's "at most 16384",
 * DeepSeek's and Qwen's "[1, 8192]", "<= 8192", Anthropic's "> 8192, which is the maximum", and
 * Gemini on Vertex's "to 8193 (exclusive)".
 */
const CAP_STATED: ReadonlyArray<readonly [RegExp, number]> = [
  [/at most (\d+)/i, 0],
  [/\[\s*\d+\s*,\s*(\d+)\s*\]/, 0],
  [/<=\s*(\d+)/, 0],
  [/>\s*(\d+),? which is the maximum/i, 0],
  [/to (\d+) \(exclusive\)/i, 1],
];

/**
 * Wording that says the prompt and the cap together are over the model's context, not that the cap
 * alone is too large: OpenAI's `context_length_exceeded`, and vLLM's "This model's maximum context
 * length is 32768 tokens and your request has 150 input tokens".
 */
const CONTEXT_FULL = /context[ _]length|context window|maximum context|上下文/i;

/**
 * How to send the cap again after a 400 about the cap alone, or null when the 400 is about
 * something else. `keep` is whether this model gets that form from then on.
 */
function refitCap(body: string, form: CapForm, maxTokens: number | undefined): { form: CapForm; keep: boolean } | null {
  const sent = capSent(form, maxTokens);
  if (sent === undefined) return null;
  // The prompt and the cap together are over the model's context ("… 32768 in the completion", as
  // OpenAI and DeepSeek word it, or an error about the context length that names the cap). Without
  // a cap the endpoint writes into what room is left, as it did before hops had one. The next
  // prompt may fit, so this is for this request only.
  if (new RegExp(`\\b${sent} in the completion\\b`).test(body)) return { form: { ...form, limit: null }, keep: false };
  // Anthropic's own wording of the same: "input length and `max_tokens` exceed context limit:
  // 190000 + 32000 > 200000". What is left of the context is the cap that fits, this time.
  const sum = /(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/.exec(body);
  if (sum && Number(sum[2]) === sent && CAP_NAMED.test(body)) {
    const room = Number(sum[3]) - Number(sum[1]);
    return { form: { ...form, limit: room >= 1 && room < sent ? room : null }, keep: false };
  }
  if (CAP_NAMED.test(body) && CONTEXT_FULL.test(body)) return { form: { ...form, limit: null }, keep: false };
  if (!CAP_NAMED.test(body)) return null;
  if (form.field === "max_tokens" && body.includes("max_completion_tokens") && /not supported|unsupported|instead/i.test(body)) {
    return { form: { ...form, field: "max_completion_tokens" }, keep: true };
  }
  if (!CAP_TOO_LARGE.test(body)) return null;
  // A number that is not under what was sent is some other limit (vLLM names the context length):
  // no cap then, which is the request that went through before.
  const stated = statedLimit(body);
  return { form: { ...form, limit: stated !== null && stated >= 1 && stated < sent ? stated : null }, keep: true };
}

function statedLimit(body: string): number | null {
  for (const [pattern, less] of CAP_STATED) {
    const match = pattern.exec(body);
    if (match) return Number(match[1]) - less;
  }
  return null;
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  clock: Clock,
  request: CompletionRequest,
  wallAt: number,
  sleptThrough?: () => boolean,
  local = false,
): Promise<Attempt> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let first = true;
  let retryBurned = false;
  let content = "";
  let finishReason: string | null = null;
  const tools = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: MappedUsage | null = null;
  let sawUsagePacket = false;
  let hadChoices = false;
  let sawDone = false;
  // Watched as it streams, so a reply that loops is cut off within seconds instead of running on
  // to the cap (see hop-limits.ts).
  const repeats = new RepeatWatch();
  // A reasoning model's thinking left in the reply text (llama.cpp, LM Studio, vLLM without a
  // reasoning parser) is not the reply, and a small local model can loop inside its thinking as
  // well as in its reply; both are read here (ADR 0067).
  const think = new ThinkStrip();
  const thoughtRepeats = local ? new RepeatWatch({ sameSentenceOnly: true }) : null;
  // A Messages stream is read event by event into the same state a Chat Completions one fills.
  const anthropic = request.apiFormat === "anthropic" ? new AnthropicStream() : null;
  let streamError: FailKind | null = null;

  const nextDeadline = () => clock.now() + (first ? clock.firstByteMs : clock.idleMs);
  const stopped = (retryable: boolean, unreachable = false): Attempt =>
    cutOff({ first, content, tools, hadChoices, usage, sawUsagePacket, retryBurned, retryable, unreachable });
  // A failure the same request would only meet again: the turn decides whether to ask differently.
  const endAs = (failKind: FailKind): Attempt =>
    fail(failKind, {
      retryable: false,
      retryBurned,
      hadChoices,
      usage,
      missingReason: missingForStream(content, tools, usage, sawUsagePacket, true),
    });
  // A timer ran out: this attempt's time limit, or the first-byte or idle one. Past the limit the
  // model was still writing, so the same request would only run as long again; a Mac that slept
  // through it goes back to the idle path, which waits for the network and asks again.
  const timedOut = (): Attempt => (clock.now() >= wallAt && !sleptThrough?.() ? endAs("overtime") : stopped(true));
  // The endpoint reported a failure inside the stream (Messages' `error` event, often "overloaded"):
  // what came so far is half a reply, and the same request may go through on another try.
  const streamFailed = (): Attempt =>
    fail(streamError ?? "endpoint_error", {
      retryable: true,
      retryBurned,
      hadChoices,
      usage,
      missingReason: missingForStream(content, tools, usage, sawUsagePacket, true),
    });

  const takeAnthropic = (event: Record<string, unknown>): "done" | "repeat" | "error" | null => {
    const step = anthropic!.feed(event);
    if (step.started) hadChoices = true;
    if (step.usage) {
      usage = step.usage;
      sawUsagePacket = true;
    }
    if (step.finish) finishReason = normalizeFinish(step.finish);
    if (step.toolCalls) {
      mergeToolDeltas(tools, step.toolCalls);
      // The turn announces a call from its first delta, which it reads in Chat Completions' shape.
      request.onEvent?.({ choices: [{ index: 0, delta: { tool_calls: step.toolCalls } }] });
    }
    if (step.text) {
      content += step.text;
      request.onToken?.(step.text);
      if (repeats.feed(step.text)) return "repeat";
    }
    if (step.error) {
      streamError = step.error;
      return "error";
    }
    if (step.done) {
      sawDone = true;
      return "done";
    }
    return null;
  };

  // One server-sent event: "done" at `[DONE]` (or Messages' `message_stop`), "repeat" once the body
  // text loops, "error" at a Messages `error` event.
  const take = (raw: string): "done" | "repeat" | "error" | null => {
    const dataLines = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return null;
    const data = dataLines.join("");
    first = false;
    retryBurned = true;
    if (data === "[DONE]") {
      sawDone = true;
      return "done";
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (anthropic) return takeAnthropic(parsed);
    request.onEvent?.(parsed);
    const mapped = mapUsage(parsed.usage);
    if (mapped) {
      usage = mapped;
      sawUsagePacket = true;
    }
    const choices = parsed.choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    hadChoices = true;
    const choice = choices[0] as Record<string, unknown>;
    // An empty string is no finish reason: some endpoints send `""` on every chunk until the last.
    if (typeof choice.finish_reason === "string" && choice.finish_reason.trim() !== "") finishReason = normalizeFinish(choice.finish_reason);
    const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      const visible = think.feed(delta.content);
      if (visible.length > 0) {
        content += visible;
        request.onToken?.(visible);
        if (repeats.feed(visible)) return "repeat";
      }
    }
    // Ollama sends a model's thinking as `reasoning`, DeepSeek and vLLM as `reasoning_content`.
    const thought = typeof delta.reasoning_content === "string" ? delta.reasoning_content : delta.reasoning;
    if (thoughtRepeats && typeof thought === "string" && thoughtRepeats.feed(thought)) return "repeat";
    const calls = delta.tool_calls;
    if (Array.isArray(calls)) mergeToolDeltas(tools, calls);
    return null;
  };

  let deadline = nextDeadline();

  try {
    while (!sawDone) {
      if (request.signal.aborted) return stopped(false);
      const remaining = Math.min(deadline, wallAt) - clock.now();
      // Once the finish reason is in, the model is done: a timer that runs out after it only means
      // the endpoint never sent its last packets (usage, `[DONE]`) or closed. The reply is whole.
      if (remaining <= 0 && finishReason !== null) break;
      if (remaining <= 0) return timedOut();
      const pending = reader.read().then(
        (value) => ({ kind: "read" as const, value }),
        () => ({ kind: "read" as const, value: { done: true, value: undefined } }),
      );
      const raced = await Promise.race([
        pending,
        clock.sleep(remaining).then(() => ({ kind: "timeout" as const })),
      ]);
      if (raced.kind === "timeout") {
        void pending;
        if (finishReason !== null) break;
        return timedOut();
      }
      const { done, value } = raced.value;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (raw.trim().length > 0) {
          deadline = clock.now() + (first ? clock.firstByteMs : clock.idleMs);
        }
        const ended = take(raw);
        if (ended === "repeat") return endAs("repeat");
        if (ended === "error") return streamFailed();
        if (ended === "done") break;
      }
    }
    // An endpoint may close the stream right after its last event, without the blank line that
    // ends it. That event may carry the finish reason, so it is read like the others.
    if (!sawDone && buf.trim().length > 0) {
      const ended = take(buf);
      if (ended === "repeat") return endAs("repeat");
      if (ended === "error") return streamFailed();
    }
  } catch {
    if (request.signal.aborted) return stopped(false);
    return stopped(true, first);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }

  content = think.finish(content);
  const toolCalls = [...tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  const missingReason = missingForStream(content, tools, usage, sawUsagePacket, !sawDone);
  const classified = classifyHop(hadChoices, finishReason, toolCalls, sawDone);
  if (classified.ok) {
    return {
      ok: true,
      content,
      toolCalls: classified.toolCalls,
      finishReason,
      hadChoices,
      usage,
      missingReason,
      ...(classified.toolArgsCut ? { toolArgsCut: true } : {}),
      ...(anthropic && anthropic.thinking.length > 0 && classified.toolCalls.length > 0
        ? { carry: { key: carryKey(request.baseUrl, request.model), blocks: anthropic.thinking } }
        : {}),
      retryable: false,
      retryBurned,
    };
  }
  // A broken stream may come out whole on another try; the endpoint's refusal would only repeat.
  return fail(classified.failKind, {
    retryable: classified.failKind === "incomplete",
    retryBurned,
    hadChoices,
    usage,
    missingReason,
  });
}

/**
 * The stream stopped before the model finished: a timer ran out before the finish reason came,
 * reading failed, or the turn was stopped. (A connection closed partway ends the stream instead,
 * and `classifyHop` reads that as incomplete.) Half a reply is never used (ADR 0040 P1): kept, it
 * went out as the Bot's message or ran its tool calls with the rest missing. The attempt fails, and
 * goes again when `retryable`.
 */
function cutOff(opts: {
  first: boolean;
  content: string;
  tools: Map<number, { id: string; name: string; arguments: string }>;
  hadChoices: boolean;
  usage: MappedUsage | null;
  sawUsagePacket: boolean;
  retryBurned: boolean;
  retryable: boolean;
  unreachable: boolean;
}): Attempt {
  const missingReason = missingForStream(opts.content, opts.tools, opts.usage, opts.sawUsagePacket, true);
  const failKind = opts.unreachable ? "unreachable" : opts.first ? "first_byte" : "stalled";
  return fail(failKind, {
    retryable: opts.retryable,
    retryBurned: opts.retryBurned,
    hadChoices: opts.hadChoices,
    usage: opts.usage,
    missingReason,
  });
}

/**
 * What a stream that ran to its end is worth. `finished` is whether it ended with `[DONE]`: one that
 * closed without it and without a finish reason was cut off, not finished.
 */
function classifyHop(
  hadChoices: boolean,
  finishReason: string | null,
  toolCalls: ToolCall[],
  finished: boolean,
): { ok: true; toolCalls: ToolCall[]; toolArgsCut?: true } | { ok: false; failKind: FailKind } {
  if (!hadChoices) return { ok: false, failKind: "incomplete" };
  if (declinedFinish(finishReason)) return { ok: false, failKind: "declined" };
  if (finishReason === null && !finished) return { ok: false, failKind: "incomplete" };
  // OpenRouter ends a stream this way when the model behind it failed partway: what came is half.
  if (finishReason === "error") return { ok: false, failKind: "incomplete" };
  // The prompt and the reply together filled the model's context: what came is cut, and only a
  // smaller prompt can go on from here (ADR 0068).
  if (finishReason === "context_window") return { ok: false, failKind: "context_full" };
  const valid = toolCalls.every((c) => c.id && c.name && parseJson(c.arguments) !== undefined);
  // At the output cap the last call's arguments are usually cut mid-way. Such a call cannot run; the
  // turn asks for it in smaller parts instead.
  if (finishReason === "length") return valid ? { ok: true, toolCalls } : { ok: true, toolCalls: [], toolArgsCut: true };
  if (toolCalls.length > 0) return valid ? { ok: true, toolCalls } : { ok: false, failKind: "incomplete" };
  // It stopped to call tools, and none arrived whole.
  if (finishReason === "tool_calls") return { ok: false, failKind: "incomplete" };
  // `stop`, or a reason this client has no name for (`eos`, a proxy's own): the model says it is
  // done, so the stream is whole, not half of one to ask for again. The turn judges the reply like
  // any other.
  return { ok: true, toolCalls: [] };
}

/** Finish reasons that mean the reply reached a length limit. */
const CAP_FINISH: ReadonlySet<string> = new Set(["length", "max_tokens"]);
/** Finish reasons that mean the prompt and the reply together filled the model's context. */
const CONTEXT_FINISH: ReadonlySet<string> = new Set(["model_length", "model_context_window_exceeded", "context_window"]);

/**
 * The finish reason as this client reads it: lower-cased, with the other names for a length limit
 * read as `length` and those for a full context as `context_window`. Some OpenAI-compatible proxies
 * pass a provider's own reasons through as they are, like Gemini's `STOP` and `MAX_TOKENS`;
 * Mistral calls a full context `model_length`, Anthropic `model_context_window_exceeded`.
 */
function normalizeFinish(reason: string): string {
  const lower = reason.toLowerCase();
  if (CONTEXT_FINISH.has(lower)) return "context_window";
  return CAP_FINISH.has(lower) ? "length" : lower;
}

function mergeToolDeltas(tools: Map<number, { id: string; name: string; arguments: string }>, calls: unknown[]): void {
  for (const raw of calls) {
    if (!raw || typeof raw !== "object") continue;
    const call = raw as {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    const index = typeof call.index === "number" ? call.index : 0;
    const current = tools.get(index) ?? { id: "", name: "", arguments: "" };
    if (typeof call.id === "string" && call.id) current.id = call.id;
    if (typeof call.function?.name === "string" && call.function.name) current.name = call.function.name;
    if (typeof call.function?.arguments === "string") current.arguments += call.function.arguments;
    tools.set(index, current);
  }
}

async function completeJudge(
  fetchImpl: FetchLike,
  clock: Clock,
  gate: OriginGate,
  request: JudgeRequest,
  forms: Forms,
  sizing?: LocalSizing,
): Promise<JudgeResult> {
  const acquired = await gate.acquire(originKey(request.baseUrl), request.signal);
  if (!acquired) {
    return { content: null, toolCalls: [], hadToolCalls: false, usage: null, failKind: "unreachable" };
  }
  try {
    return await completeJudgeBody(fetchImpl, clock, request, forms, sizing);
  } finally {
    gate.release(originKey(request.baseUrl));
  }
}

/**
 * Wording of a 400 about the thinking level a short call sent: a local model whose thinking cannot
 * be turned off (`reasoning_effort: "none"`) refuses it, and is asked again without one.
 */
const THINK_OFF_REFUSED = /reasoning|effort|think/i;

async function completeJudgeBody(
  fetchImpl: FetchLike,
  clock: Clock,
  request: JudgeRequest,
  forms: Forms,
  sizing?: LocalSizing,
): Promise<JudgeResult> {
  let response: Response;
  // A local server may be busy with a Bot's hop for many minutes; a call nobody waits on waits it
  // out instead of failing (ADR 0067). A reading keeps its own short limit: the line it reads waits.
  const wait = request.timeoutMs ?? clock.firstByteMs;
  const timeoutMs = sizing && request.lane !== "reading" ? Math.max(wait, LOCAL_JUDGE_MS) : wait;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
  const maxTokens = request.maxTokens ?? (request.tools?.length ? 512 : 256);
  // A short call that names no thinking level lets the endpoint think as it likes. A local reasoning
  // model then spends the whole cap thinking and answers nothing (qwen3:8b: 256 of 256 tokens,
  // empty reply), so a local one is asked not to think unless the model refused that before.
  const modelKey = `${request.baseUrl} ${request.model}`;
  const thinkOff = Boolean(sizing && !request.thinkingLevel && !sizing.noThinkOff.has(modelKey));
  const bytes = sizing ? promptBytes(request.messages, request.tools) : 0;
  const tooBig = sizing ? preflight(sizing, request, bytes) : null;
  if (tooBig) return judgeResult({ content: null, toolCalls: [], usage: null, failKind: "context_full" });
  const sendOpenai = (thinkingLevel: ThinkingLevel | undefined) => fetchImpl(completionsUrl(request.baseUrl), {
    method: "POST",
    headers: {
      ...bearer(request.apiKey),
      "Content-Type": "application/json",
      ...sessionHeader(judgeAffinity(request)),
    },
    body: JSON.stringify({
      model: request.model,
      ...(thinkingLevel ? { reasoning_effort: thinkingLevel } : {}),
      messages: toApiMessages(request.messages),
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
      ...(request.tools?.length ? { tools: request.tools } : {}),
    }),
    signal,
  });
  try {
    if (request.apiFormat === "anthropic") {
      // No `temperature: 0` here: Anthropic's current models refuse any sampling setting.
      response = await postAnthropic(fetchImpl, thinkOff ? { ...request, thinkingLevel: "none" } : request, forms, {
        stream: false,
        tools: request.tools ?? [],
        maxTokens,
        refitCap: false,
        cacheLoop: false,
        affinity: judgeAffinity(request),
        signal,
      });
    } else {
      response = await sendOpenai(thinkOff ? "none" : request.thinkingLevel);
      if (thinkOff && response.status === 400) {
        const refusal = await response.text().catch(() => "");
        if (THINK_OFF_REFUSED.test(refusal)) {
          sizing!.noThinkOff.add(modelKey);
          response = await sendOpenai(undefined);
        } else {
          response = new Response(refusal, { status: 400 });
        }
      }
    }
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return judgeResult({
      content: null,
      toolCalls: [],
      usage: null,
      failKind: timeout && !request.signal.aborted ? "first_byte" : "unreachable",
    });
  }
  if (response.status >= 400) {
    const text = response.bodyUsed ? "" : await response.text().catch(() => "");
    const usage = request.apiFormat === "anthropic" ? null : mapUsageFromResponse(parseJson(text));
    const failKind: FailKind = response.status === 400 && PROMPT_OVER_CONTEXT.test(text) ? "context_full" : "endpoint_error";
    return judgeResult({ content: null, toolCalls: [], usage, failKind });
  }
  const body = (await peekJson(response)) as Record<string, unknown> | null;
  if (!body) {
    return judgeResult({ content: null, toolCalls: [], usage: null, failKind: "incomplete" });
  }
  const cutOff = async (usage: MappedUsage | null): Promise<boolean> =>
    Boolean(sizing && (await afterLocal(sizing, request, bytes, usage)));
  if (request.apiFormat === "anthropic") {
    const message = readAnthropicMessage(body);
    if (!message) return judgeResult({ content: null, toolCalls: [], usage: mapAnthropicUsage(body.usage), failKind: "incomplete" });
    if (await cutOff(message.usage)) return judgeResult({ content: null, toolCalls: [], usage: message.usage, failKind: "context_full" });
    return judgeResult({
      content: message.content,
      toolCalls: message.toolCalls,
      usage: message.usage,
      failKind: null,
      ...(message.finish === "length" || message.finish === "context_window" ? { truncated: true } : {}),
    });
  }
  const usage = mapUsage(body.usage);
  const choices = body.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    return judgeResult({ content: null, toolCalls: [], usage, failKind: "incomplete" });
  }
  if (await cutOff(usage)) return judgeResult({ content: null, toolCalls: [], usage, failKind: "context_full" });
  const choice = choices[0] as { message?: Record<string, unknown>; finish_reason?: unknown };
  const message = choice.message ?? {};
  const content = message.content;
  return judgeResult({
    // A reasoning model's `<think>` left in the reply is not the verdict, and would not parse as one.
    content: typeof content === "string" ? stripLeadingThink(content) : content == null ? null : String(content),
    toolCalls: judgeToolCalls(message.tool_calls),
    usage,
    failKind: null,
    ...(typeof choice.finish_reason === "string" && ["length", "context_window"].includes(normalizeFinish(choice.finish_reason)) ? { truncated: true } : {}),
  });
}

function judgeResult(result: Omit<JudgeResult, "hadToolCalls">): JudgeResult {
  return { ...result, hadToolCalls: result.toolCalls.length > 0 };
}

/** Tool calls on a non-streaming judge answer. A call missing its name is dropped. */
function judgeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof call.function?.name === "string" ? call.function.name : "";
    if (!name) continue;
    out.push({
      id: typeof call.id === "string" && call.id ? call.id : `call_${out.length}`,
      name,
      arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "{}",
    });
  }
  return out;
}

async function peekJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function mapUsageFromResponse(body: unknown): MappedUsage | null {
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function missingForStream(
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

function fail(
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

function parseRetryAfter(header: string | null, clock: Clock): number | undefined {
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

async function abortableSleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return;
  await Promise.race([clock.sleep(ms), new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
}

function originKey(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/$/, "");
  }
}

function createOriginGate(limit: number): OriginGate {
  const slots = new Map<string, number>();
  const waiters = new Map<string, Array<() => boolean>>();

  function wake(key: string): void {
    const queue = waiters.get(key);
    while (queue && queue.length > 0) {
      const next = queue.shift();
      if (queue.length === 0) waiters.delete(key);
      if (next?.()) return;
    }
  }

  function acquire(key: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const used = slots.get(key) ?? 0;
    if (used < limit) {
      slots.set(key, used + 1);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = (): boolean => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          resolve(false);
          return false;
        }
        slots.set(key, (slots.get(key) ?? 0) + 1);
        resolve(true);
        return true;
      };
      const onAbort = () => {
        const queue = waiters.get(key);
        if (queue) {
          const idx = queue.indexOf(grant);
          if (idx >= 0) queue.splice(idx, 1);
          if (queue.length === 0) waiters.delete(key);
        }
        resolve(false);
      };
      const queue = waiters.get(key) ?? [];
      queue.push(grant);
      waiters.set(key, queue);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function release(key: string): void {
    const used = slots.get(key) ?? 0;
    if (used <= 1) slots.delete(key);
    else slots.set(key, used - 1);
    wake(key);
  }

  return { acquire, release };
}
