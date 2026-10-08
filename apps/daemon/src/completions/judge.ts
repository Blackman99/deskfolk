/** A judge call: one non-streamed request that answers with a reading. */
import type { ThinkingLevel } from "@real-bot/protocol";
import { mapAnthropicUsage, readAnthropicMessage } from "../anthropic-messages";
import type { Clock, FetchLike, JudgeRequest, JudgeResult, MappedUsage, ToolCall } from "../completions";
import { promptBytes, stripLeadingThink } from "../local-model";
import type { FailKind } from "../prompts";
import { postAnthropic } from "./anthropic";
import type { Forms } from "./caps";
import { originKey, type OriginGate } from "./origin-gate";
import { normalizeFinish } from "./sse";
import { afterLocal, bearer, completionsUrl, mapUsage, mapUsageFromResponse, parseJson, peekJson, preflight, PROMPT_OVER_CONTEXT, sessionHeader, toApiMessages, type LocalSizing } from "./wire";

/** A short call to a local server that the app does not wait on gets at least this long. */
export const LOCAL_JUDGE_MS = 10 * 60_000;

/**
 * The `X-Session-ID` of a judge call: calls of one kind share their fixed system message (see
 * `JudgeRequest.prompt`). A reading you wait on is short and not worth keeping on one account: it
 * would queue there.
 */
function judgeAffinity(request: JudgeRequest): string | undefined {
  return request.prompt && request.lane !== "reading" ? `deskfolk-${request.prompt.id}` : undefined;
}

export async function completeJudge(
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
