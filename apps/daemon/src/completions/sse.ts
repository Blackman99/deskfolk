/** Reading a streamed reply: SSE frames into content, tool calls, usage and how the hop finished. */
import { AnthropicStream, carryKey } from "../anthropic-messages";
import type { Clock, CompletionRequest, MappedUsage, ToolCall } from "../completions";
import { declinedFinish, RepeatWatch } from "../hop-limits";
import { ThinkStrip } from "../local-model";
import type { FailKind } from "../prompts";
import { fail, mapUsage, missingForStream, parseJson, type Attempt } from "./wire";

export async function readSse(
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
export function cutOff(opts: {
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
export function normalizeFinish(reason: string): string {
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
