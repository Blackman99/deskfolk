import { HttpError } from "./errors";

export function extractModelIds(data: unknown): string[] {
  const list: string[] = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "string") list.push(item);
      else if (item && typeof item === "object") {
        const id = (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name;
        if (typeof id === "string") list.push(id);
      }
    }
  } else if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    const raw = Array.isArray(rec.data) ? rec.data : Array.isArray(rec.models) ? rec.models : [];
    for (const item of raw) {
      if (typeof item === "string") list.push(item);
      else if (item && typeof item === "object") {
        const id = (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name;
        if (typeof id === "string") list.push(id);
      }
    }
  }
  return Array.from(new Set(list.map((s) => s.trim()).filter((s) => s.length > 0)));
}

export async function probeEndpointModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
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
      signal: AbortSignal.timeout(12000),
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
  const models = extractModelIds(json);
  if (models.length === 0) {
    throw new HttpError(422, "no_models", "No models found in endpoint response");
  }
  return models;
}
