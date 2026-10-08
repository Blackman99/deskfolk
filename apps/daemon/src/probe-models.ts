import {
  isThinkingLevel,
  sortThinkingLevels,
  type ApiFormat,
  type ProbedModel,
} from "@real-bot/protocol";
import { anthropicHeaders, anthropicUrl, type AnthropicAuth } from "./anthropic-messages";
import { HttpError } from "./errors";

export type { ProbedModel };

export type ProbeResult = {
  models: string[];
  catalog: ProbedModel[];
};

export function extractModelIds(data: unknown): string[] {
  return extractProbedModels(data).models;
}

export function extractProbedModels(data: unknown): ProbeResult {
  const catalog: ProbedModel[] = [];
  const seen = new Set<string>();
  for (const item of modelItems(data)) {
    const row = parseProbedItem(item);
    if (!row || seen.has(row.name)) continue;
    seen.add(row.name);
    catalog.push(row);
  }
  return { models: catalog.map((row) => row.name), catalog };
}

/** How long one try at `/models` gets, headers and body together. */
export const PROBE_TIMEOUT_MS = 12_000;

export type ProbeOptions = {
  /** Per-try limit; tests shorten it. */
  timeoutMs?: number;
  /** Runs immediately before every outbound fetch, the retry's included; throwing stops the probe. */
  guard?: () => void;
  /** The endpoint's wire format; absent is `openai`. */
  apiFormat?: ApiFormat;
};

export async function probeEndpointModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const anthropic = options.apiFormat === "anthropic";
  const cleanBase = baseUrl.replace(/\/+$/, "");
  // Anthropic's list comes in pages of 20 unless asked for more; 1000 is the most it gives at once.
  const url = anthropic ? `${anthropicUrl(cleanBase, "models")}?limit=1000` : `${cleanBase}/models`;
  const headersFor = (auth: AnthropicAuth): Record<string, string> => {
    if (anthropic) {
      const { "Content-Type": _json, ...rest } = anthropicHeaders(apiKey, auth);
      return { Accept: "application/json", ...rest };
    }
    return { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  };
  // An Anthropic-format endpoint that refuses the key as `x-api-key` is asked once more with it as
  // a Bearer token, as completions do.
  let auth: AnthropicAuth = "x-api-key";
  let headers = headersFor(auth);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  // A relay that has to ask upstream for its list with a valid key can stall one request and
  // answer the next, so a try that runs out of time gets one more. Nothing else is retried: a
  // refused connection or an HTTP error answers the same way twice.
  let tries = 0;
  for (;;) {
    tries += 1;
    options.guard?.();
    const probed = await probeOnce(url, headers, fetchImpl, signal, timeoutMs, anthropic && auth === "x-api-key" && Boolean(apiKey));
    if (probed === "auth_refused") {
      auth = "bearer";
      headers = headersFor(auth);
      tries -= 1;
      continue;
    }
    if (probed !== "timed_out") return probed;
    if (tries >= 2) {
      throw new HttpError(
        422,
        "probe_failed",
        `${url} did not answer within ${timeoutMs / 1000}s (tried ${tries} times)`,
      );
    }
  }
}

/**
 * One GET of `/models`; `"timed_out"` only when this try's own clock ran out, not the caller's, and
 * `"auth_refused"` for a 401 or 403 when `authRetry` says the key may be sent another way.
 */
async function probeOnce(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  authRetry = false,
): Promise<ProbeResult | "timed_out" | "auth_refused"> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
  } catch (err: unknown) {
    if (timeout.aborted && !signal?.aborted) return "timed_out";
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(422, "probe_failed", `Failed to connect to ${url}: ${msg}`);
  }

  if (authRetry && (res.status === 401 || res.status === 403)) {
    await res.body?.cancel().catch(() => {});
    return "auth_refused";
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(
      res.status === 401 ? 401 : 422,
      "probe_failed",
      `Endpoint returned ${res.status}: ${text.slice(0, 150)}`,
    );
  }

  const json = await res.json().catch(() => null);
  // The same clock covers the body: one still unread when it runs out is a stall, not an empty list.
  if (json === null && timeout.aborted && !signal?.aborted) return "timed_out";
  const probed = extractProbedModels(json);
  if (probed.models.length === 0) {
    throw new HttpError(422, "no_models", "No models found in endpoint response");
  }
  return probed;
}

function modelItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const rec = data as Record<string, unknown>;
  if (Array.isArray(rec.data)) return rec.data;
  if (Array.isArray(rec.models)) return rec.models;
  return [];
}

function parseProbedItem(item: unknown): ProbedModel | null {
  if (typeof item === "string") {
    const name = item.trim();
    return name.length > 0 ? { name, thinking_levels: [] } : null;
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  const rawName = rec.id ?? rec.name;
  if (typeof rawName !== "string") return null;
  const name = rawName.trim();
  if (name.length === 0) return null;
  return { name, thinking_levels: extractThinkingLevels(rec) };
}

/**
 * Pulls advertised `reasoning_effort` names off a `/models` object. Field names vary across
 * OpenAI-compatible gateways; an empty list means this object did not say.
 */
function extractThinkingLevels(rec: Record<string, unknown>): string[] {
  const nested =
    rec.reasoning && typeof rec.reasoning === "object" && !Array.isArray(rec.reasoning)
      ? (rec.reasoning as Record<string, unknown>)
      : rec.thinking && typeof rec.thinking === "object" && !Array.isArray(rec.thinking)
        ? (rec.thinking as Record<string, unknown>)
        : null;
  const candidates: unknown[] = [
    rec.thinking_levels,
    rec.thinking_level,
    rec.reasoning_efforts,
    rec.supported_reasoning_efforts,
    rec.supported_thinking_levels,
    rec.reasoning_effort,
    nested?.supported_efforts,
    nested?.efforts,
    nested?.thinking_levels,
    nested?.thinking_level,
  ];
  const collected: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      collected.push(...splitLevelBlob(candidate));
      continue;
    }
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (typeof item === "string") {
        collected.push(...splitLevelBlob(item));
        continue;
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const row = item as Record<string, unknown>;
        const named = row.id ?? row.name ?? row.effort ?? row.level;
        if (typeof named === "string") collected.push(...splitLevelBlob(named));
      }
    }
  }
  return sortThinkingLevels(collected.filter((level) => isThinkingLevel(level)));
}

function splitLevelBlob(raw: string): string[] {
  return raw.split(/[,/|\s]+/).map((part) => part.trim()).filter((part) => part.length > 0);
}
