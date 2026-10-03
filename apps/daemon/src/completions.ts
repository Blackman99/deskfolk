import type { ThinkingLevel } from "@real-bot/protocol";
import type { FailKind } from "./prompts";
import { declinedFinish, RepeatWatch } from "./hop-limits";
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
};

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
};

export type CompletionFail = {
  ok: false;
  failKind: FailKind;
  hadChoices: boolean;
  usage: MappedUsage | null;
  missingReason: "stream_interrupted" | "endpoint_omitted" | null;
};

export type CompletionResult = CompletionOk | CompletionFail;

export type CompletionsClient = {
  complete(request: CompletionRequest): Promise<CompletionResult>;
  judge(request: JudgeRequest): Promise<JudgeResult>;
};

export type CompletionRequest = {
  baseUrl: string;
  apiKey: string;
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
  onEvent?: (chunk: Record<string, unknown>) => void;
  onToken?: (text: string) => void;
};

export type JudgeRequest = {
  baseUrl: string;
  apiKey: string;
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
};

export type JudgeResult = {
  content: string | null;
  toolCalls: ToolCall[];
  /** True when the answer carried any tool call. Derived so callers can read either field. */
  hadToolCalls: boolean;
  usage: MappedUsage | null;
  failKind: FailKind | null;
  /**
   * The answer stopped at the token cap (`finish_reason: "length"`), so what came back is only its
   * start. Absent is false. It is not a failure here: a short verdict cut off can still read, so
   * each caller decides what a cut-off answer is worth.
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

export function createCompletionsClient(
  options: { fetch?: FetchLike; clock?: Partial<Clock>; originLimit?: number; wake?: WakeWatch } = {},
): CompletionsClient {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const clock: Clock = { ...DEFAULT_CLOCK };
  if (options.clock?.now) clock.now = options.clock.now;
  if (options.clock?.sleep) clock.sleep = options.clock.sleep;
  if (options.clock?.firstByteMs) clock.firstByteMs = options.clock.firstByteMs;
  if (options.clock?.idleMs) clock.idleMs = options.clock.idleMs;
  const gate = createOriginGate(options.originLimit ?? ORIGIN_STREAM_LIMIT);
  const readingGate = createOriginGate(options.originLimit ?? ORIGIN_STREAM_LIMIT);
  const capForms: CapForms = new Map();

  return {
    async complete(request) {
      return completeStreaming(fetchImpl, clock, gate, request, capForms, options.wake);
    },
    async judge(request) {
      return completeJudge(fetchImpl, clock, request.lane === "reading" ? readingGate : gate, request);
    },
  };
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

async function completeStreaming(
  fetchImpl: FetchLike,
  clock: Clock,
  gate: OriginGate,
  request: CompletionRequest,
  capForms: CapForms,
  wake?: WakeWatch,
): Promise<CompletionResult> {
  let lastFail: FailKind = "unreachable";
  let lastUsage: MappedUsage | null = null;
  let lastMissing: CompletionOk["missingReason"] = null;
  let lastHadChoices = false;
  const key = originKey(request.baseUrl);
  let wakeRetries = 0;

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
      result = await oneStreamAttempt(fetchImpl, clock, request, capForms, sleptThrough);
    } finally {
      gate.release(key);
    }
    lastFail = result.failKind ?? "incomplete";
    lastUsage = result.usage;
    lastMissing = result.missingReason;
    lastHadChoices = result.hadChoices;
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
  capForms: CapForms,
  sleptThrough?: () => boolean,
): Promise<Attempt> {
  const wallAt = request.wallMs ? clock.now() + request.wallMs : Number.POSITIVE_INFINITY;
  const capKey = `${request.baseUrl} ${request.model}`;
  const post = (form: CapForm) =>
    fetchImpl(completionsUrl(request.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        reasoning_effort: request.thinkingLevel,
        [form.field]: capSent(form, request.maxTokens),
        messages: toApiMessages(request.messages),
        tools: request.tools.length ? request.tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    });
  let response: Response;
  try {
    let form = capForms.get(capKey) ?? { field: "max_tokens" };
    response = await post(form);
    // Refused for the cap alone: sent again at once the way the endpoint asked. Each refit only
    // renames the field once or lowers the cap, so a few are enough: a reasoning model may want the
    // other name and then a lower limit, and a full context comes on top of either.
    for (let refits = 0; refits < 3 && response.status === 400; refits++) {
      const refit = refitCap(await response.text(), form, request.maxTokens);
      if (!refit) break;
      form = refit.form;
      if (refit.keep) capForms.set(capKey, form);
      response = await post(form);
    }
  } catch {
    if (request.signal.aborted) {
      return fail("unreachable", { retryable: false, retryBurned: false });
    }
    return fail("unreachable", { retryable: true, retryBurned: false });
  }

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

  return readSse(response.body, clock, request, wallAt, sleptThrough);
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

  // One server-sent event: "done" at `[DONE]`, "repeat" once the body text loops.
  const take = (raw: string): "done" | "repeat" | null => {
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
      content += delta.content;
      request.onToken?.(delta.content);
      if (repeats.feed(delta.content)) return "repeat";
    }
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
        if (ended === "done") break;
      }
    }
    // An endpoint may close the stream right after its last event, without the blank line that
    // ends it. That event may carry the finish reason, so it is read like the others.
    if (!sawDone && buf.trim().length > 0 && take(buf) === "repeat") return endAs("repeat");
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
const CAP_FINISH: ReadonlySet<string> = new Set(["length", "max_tokens", "model_length"]);

/**
 * The finish reason as this client reads it: lower-cased, with the other names for a length limit
 * read as `length`. Some OpenAI-compatible proxies pass a provider's own reasons through as they
 * are, like Gemini's `STOP` and `MAX_TOKENS`, and Mistral calls a full context `model_length`.
 */
function normalizeFinish(reason: string): string {
  const lower = reason.toLowerCase();
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
): Promise<JudgeResult> {
  const acquired = await gate.acquire(originKey(request.baseUrl), request.signal);
  if (!acquired) {
    return { content: null, toolCalls: [], hadToolCalls: false, usage: null, failKind: "unreachable" };
  }
  try {
    return await completeJudgeBody(fetchImpl, clock, request);
  } finally {
    gate.release(originKey(request.baseUrl));
  }
}

async function completeJudgeBody(
  fetchImpl: FetchLike,
  clock: Clock,
  request: JudgeRequest,
): Promise<JudgeResult> {
  let response: Response;
  try {
    response = await fetchImpl(completionsUrl(request.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        ...(request.thinkingLevel ? { reasoning_effort: request.thinkingLevel } : {}),
        messages: toApiMessages(request.messages),
        temperature: 0,
        max_tokens: request.maxTokens ?? (request.tools?.length ? 512 : 256),
        stream: false,
        ...(request.tools?.length ? { tools: request.tools } : {}),
      }),
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(request.timeoutMs ?? clock.firstByteMs),
      ]),
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return judgeResult({
      content: null,
      toolCalls: [],
      usage: null,
      failKind: timeout && !request.signal.aborted ? "first_byte" : "unreachable",
    });
  }
  if (response.status >= 500) {
    return judgeResult({ content: null, toolCalls: [], usage: mapUsageFromResponse(await peekJson(response)), failKind: "endpoint_error" });
  }
  if (response.status >= 400) {
    return judgeResult({ content: null, toolCalls: [], usage: mapUsageFromResponse(await peekJson(response)), failKind: "endpoint_error" });
  }
  const body = (await peekJson(response)) as Record<string, unknown> | null;
  if (!body) {
    return judgeResult({ content: null, toolCalls: [], usage: null, failKind: "incomplete" });
  }
  const usage = mapUsage(body.usage);
  const choices = body.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    return judgeResult({ content: null, toolCalls: [], usage, failKind: "incomplete" });
  }
  const choice = choices[0] as { message?: Record<string, unknown>; finish_reason?: unknown };
  const message = choice.message ?? {};
  const content = message.content;
  return judgeResult({
    content: typeof content === "string" ? content : content == null ? null : String(content),
    toolCalls: judgeToolCalls(message.tool_calls),
    usage,
    failKind: null,
    ...(typeof choice.finish_reason === "string" && normalizeFinish(choice.finish_reason) === "length" ? { truncated: true } : {}),
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
