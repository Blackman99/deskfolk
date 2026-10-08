/** The Anthropic Messages format: a request sent there and its reply read back in the chat-completions shape. */
import { anthropicBody, anthropicHeaders, anthropicUrl, carryKey, refitThinking, thinkingFields, type AnthropicAuth, type ThinkForm } from "../anthropic-messages";
import type { CompletionRequest, FetchLike, JudgeRequest } from "../completions";
import { capSent, refitCap, type CapForm, type Forms } from "./caps";
import { sessionHeader } from "./wire";

/**
 * One Messages request, sent again at once while the endpoint refuses it for how it was asked: the
 * key header (401/403, tried the other way once per base URL), the thinking fields (400 naming them,
 * one form down) and, for a hop, the output cap (as for Chat Completions). Messages takes no request
 * without a cap, so a cap the refit would leave out stays as it was.
 */
export async function postAnthropic(
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
