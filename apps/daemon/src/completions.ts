import { isLocalEndpoint, type ApiFormat, type ThinkingLevel } from "@real-bot/protocol";
import type { Forms } from "./completions/caps";
import { completeJudge } from "./completions/judge";
import { createOriginGate } from "./completions/origin-gate";
import { completeStreaming } from "./completions/stream";
import type { LocalSizing } from "./completions/wire";
import type { FailKind } from "./prompts";
import type { PromptRef } from "./prompts/registry";
import type { WakeWatch } from "./wake";

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
/**
 * Streams sent at once to one local server. It serves one request at a time by default, and a
 * request queued there runs out its first-byte time behind a hop of twenty minutes; queued here it
 * waits without a clock.
 */
const LOCAL_STREAM_LIMIT = 1;
const ORIGIN_STREAM_LIMIT = 2;

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
