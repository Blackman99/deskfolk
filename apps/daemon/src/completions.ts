import type { ThinkingLevel } from "@real-bot/protocol";
import type { FailKind } from "./prompts";
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
  finishReason: string | null;
  hadChoices: boolean;
  usage: MappedUsage | null;
  missingReason: "stream_interrupted" | "endpoint_omitted" | null;
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

  return {
    async complete(request) {
      return completeStreaming(fetchImpl, clock, gate, request, options.wake);
    },
    async judge(request) {
      return completeJudge(fetchImpl, clock, gate, request);
    },
  };
}

function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function toApiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: m.content ?? "" };
    if (m.role === "assistant" && m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      }));
      if (!m.content) out.content = null;
    }
    if (m.role === "tool") out.tool_call_id = m.tool_call_id;
    return out;
  });
}

async function completeStreaming(
  fetchImpl: FetchLike,
  clock: Clock,
  gate: OriginGate,
  request: CompletionRequest,
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
      result = await oneStreamAttempt(fetchImpl, clock, request, sleptThrough);
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
  sleptThrough?: () => boolean,
): Promise<Attempt> {
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
        reasoning_effort: request.thinkingLevel,
        messages: toApiMessages(request.messages),
        tools: request.tools.length ? request.tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    });
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

  return readSse(response.body, clock, request, sleptThrough);
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  clock: Clock,
  request: CompletionRequest,
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

  const nextDeadline = () => clock.now() + (first ? clock.firstByteMs : clock.idleMs);

  let deadline = nextDeadline();

  try {
    while (!sawDone) {
      if (request.signal.aborted) {
        return failOrSalvage({
          first,
          content,
          tools,
          finishReason,
          hadChoices,
          usage,
          sawUsagePacket,
          retryBurned,
          retryable: false,
        });
      }
      const remaining = deadline - clock.now();
      if (remaining <= 0) {
        return failOrSalvage({
          first,
          content,
          tools,
          finishReason,
          hadChoices,
          usage,
          sawUsagePacket,
          retryBurned,
          retryable: true,
          salvage: !sleptThrough?.(),
        });
      }
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
        return failOrSalvage({
          first,
          content,
          tools,
          finishReason,
          hadChoices,
          usage,
          sawUsagePacket,
          retryBurned,
          retryable: true,
          salvage: !sleptThrough?.(),
        });
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
        const dataLines = raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const data = dataLines.join("");
        first = false;
        retryBurned = true;
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        request.onEvent?.(parsed);
        const mapped = mapUsage(parsed.usage);
        if (mapped) {
          usage = mapped;
          sawUsagePacket = true;
        }
        const choices = parsed.choices;
        if (!Array.isArray(choices) || choices.length === 0) continue;
        hadChoices = true;
        const choice = choices[0] as Record<string, unknown>;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
        if (typeof delta.content === "string" && delta.content.length > 0) {
          content += delta.content;
          request.onToken?.(delta.content);
        }
        const calls = delta.tool_calls;
        if (Array.isArray(calls)) mergeToolDeltas(tools, calls);
      }
    }
    if (!sawDone && buf.trim().length > 0) {
      buf += "\n\n";
    }
  } catch {
    if (request.signal.aborted) {
      return failOrSalvage({
        first,
        content,
        tools,
        finishReason,
        hadChoices,
        usage,
        sawUsagePacket,
        retryBurned,
        retryable: false,
      });
    }
    return failOrSalvage({
      first,
      content,
      tools,
      finishReason,
      hadChoices,
      usage,
      sawUsagePacket,
      retryBurned,
      retryable: true,
      unreachable: first,
      salvage: !sleptThrough?.(),
    });
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
  const classified = classifyHop(hadChoices, finishReason, content, toolCalls);
  if (classified.ok) {
    return {
      ok: true,
      content: classified.content,
      toolCalls: classified.toolCalls,
      finishReason,
      hadChoices,
      usage,
      missingReason,
      retryable: false,
      retryBurned,
    };
  }
  const salvaged =
    finishReason === "content_filter" ? null : salvageHop(hadChoices, content, toolCalls);
  if (salvaged) {
    return {
      ok: true,
      content: salvaged.content,
      toolCalls: salvaged.toolCalls,
      finishReason,
      hadChoices,
      usage,
      missingReason,
      retryable: false,
      retryBurned,
    };
  }
  return fail(classified.failKind, {
    retryable: finishReason !== "content_filter",
    retryBurned,
    hadChoices,
    usage,
    missingReason,
  });
}

function failOrSalvage(opts: {
  first: boolean;
  content: string;
  tools: Map<number, { id: string; name: string; arguments: string }>;
  finishReason: string | null;
  hadChoices: boolean;
  usage: MappedUsage | null;
  sawUsagePacket: boolean;
  retryBurned: boolean;
  retryable: boolean;
  unreachable?: boolean;
  /**
   * False when sleep cut the stream off: half a reply the Mac slept through is not the model
   * stopping, and the retry after the wake gets the whole of it.
   */
  salvage?: boolean;
}): Attempt {
  const toolCalls = [...opts.tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  const missingReason = missingForStream(
    opts.content,
    opts.tools,
    opts.usage,
    opts.sawUsagePacket,
    true,
  );
  if (opts.salvage !== false && opts.finishReason !== "content_filter") {
    const salvaged = salvageHop(opts.hadChoices, opts.content, toolCalls);
    if (salvaged) {
      return {
        ok: true,
        content: salvaged.content,
        toolCalls: salvaged.toolCalls,
        finishReason: opts.finishReason,
        hadChoices: opts.hadChoices,
        usage: opts.usage,
        missingReason,
        retryable: false,
        retryBurned: opts.retryBurned,
      };
    }
  }
  const failKind = opts.unreachable ? "unreachable" : opts.first ? "first_byte" : "stalled";
  return fail(failKind, {
    retryable: opts.retryable,
    retryBurned: opts.retryBurned,
    hadChoices: opts.hadChoices,
    usage: opts.usage,
    missingReason,
  });
}

function classifyHop(
  hadChoices: boolean,
  finishReason: string | null,
  content: string,
  toolCalls: ToolCall[],
): { ok: true; content: string; toolCalls: ToolCall[] } | { ok: false; failKind: FailKind } {
  if (!hadChoices) return { ok: false, failKind: "incomplete" };
  if (finishReason === "content_filter") return { ok: false, failKind: "incomplete" };
  if (toolCalls.length > 0) {
    const valid = toolCalls.every((c) => c.id && c.name && parseJson(c.arguments) !== undefined);
    if (!valid) return { ok: false, failKind: "incomplete" };
    return { ok: true, content, toolCalls };
  }
  if (
    finishReason === "stop" ||
    finishReason === "length" ||
    finishReason === "end_turn" ||
    finishReason === null
  ) {
    return { ok: true, content, toolCalls: [] };
  }
  if (finishReason === "tool_calls") return { ok: false, failKind: "incomplete" };
  return { ok: false, failKind: "incomplete" };
}

function salvageHop(
  hadChoices: boolean,
  content: string,
  toolCalls: ToolCall[],
): { content: string; toolCalls: ToolCall[] } | null {
  if (!hadChoices) return null;
  if (toolCalls.length > 0) {
    const valid = toolCalls.every((c) => c.id && c.name && parseJson(c.arguments) !== undefined);
    return valid ? { content, toolCalls } : null;
  }
  if (content.trim().length > 0) return { content, toolCalls: [] };
  return null;
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
    ...(choice.finish_reason === "length" ? { truncated: true } : {}),
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
