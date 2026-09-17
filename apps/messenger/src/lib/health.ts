import { LOCAL_API_NAME } from "@real-bot/protocol";

export type HealthProbe = "ours" | "other" | "down";

export function classifyHealth(status: number | null, body: unknown): HealthProbe {
  if (status == null) return "down";
  if (status === 200 && isOurs(body)) return "ours";
  return "other";
}

function isOurs(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as { ok?: unknown; name?: unknown };
  return record.ok === true && record.name === LOCAL_API_NAME;
}
