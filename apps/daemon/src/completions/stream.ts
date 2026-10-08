/** A streamed turn hop: attempts, retries and waits around one request. */
import { ANTHROPIC_DEFAULT_CAP } from "../anthropic-messages";
import type { Clock, CompletionOk, CompletionRequest, CompletionResult, FetchLike, MappedUsage } from "../completions";
import { promptBytes } from "../local-model";
import type { FailKind } from "../prompts";
import type { WakeWatch } from "../wake";
import { postAnthropic } from "./anthropic";
import { capSent, refitCap, type CapForm, type Forms } from "./caps";
import { originKey, type OriginGate } from "./origin-gate";
import { readSse } from "./sse";
import { abortableSleep, afterLocal, bearer, completionsUrl, fail, parseRetryAfter, preflight, PROMPT_OVER_CONTEXT, sessionHeader, toApiMessages, type Attempt, type LocalSizing } from "./wire";

const MAX_ATTEMPTS = 3;
/** Failures that only say the network was not there: the ones a sleep produces. */
const NETWORK_FAILS: ReadonlySet<FailKind> = new Set<FailKind>(["unreachable", "first_byte", "stalled"]);
/** How many times sleep may send one request back without it using up an attempt. */
const WAKE_RETRIES = 10;

export async function completeStreaming(
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
