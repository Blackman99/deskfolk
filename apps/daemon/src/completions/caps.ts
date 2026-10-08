/** The output cap a request names, and fitting it again when a provider refuses it. */
import type { AnthropicAuth, ThinkForm } from "../anthropic-messages";

/**
 * How one endpoint and model take the output cap, once they have refused it the first way. Most
 * endpoints take `max_tokens` as asked, so that is what goes first. OpenAI's reasoning models refuse
 * `max_tokens` with a 400 that names `max_completion_tokens`, and a model that writes less than the
 * cap refuses it as too large, usually stating its own limit (DeepSeek's 8,192, OpenAI gpt-4o's
 * 16,384). Before hops had a cap those requests went through, so a refusal like that must not fail
 * the turn.
 */
export type CapForm = {
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
export type Forms = {
  cap: CapForms;
  think: Map<string, ThinkForm>;
  auth: Map<string, AnthropicAuth>;
};

export function capSent(form: CapForm, maxTokens: number | undefined): number | undefined {
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
export function refitCap(body: string, form: CapForm, maxTokens: number | undefined): { form: CapForm; keep: boolean } | null {
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
