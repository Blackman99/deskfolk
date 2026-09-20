import {
  isThinkingLevel,
  sortThinkingLevels,
  type ProbedModel,
} from "@real-bot/protocol";
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

export async function probeEndpointModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const url = `${cleanBase}/models`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      redirect: "error",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(422, "probe_failed", `Failed to connect to ${url}: ${msg}`);
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
