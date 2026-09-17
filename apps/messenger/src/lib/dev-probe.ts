import { LOCAL_API_NAME } from "@real-bot/protocol";
import { parseDiscovery } from "./discovery.ts";

export type MessengerDevProbe = "ours" | "other" | "down";
export type MessengerDevAction = "reuse" | "start" | "refuse";

export function classifyMessengerDev(status: number | null, body: unknown): MessengerDevProbe {
  if (status == null) return "down";
  if (isOurs(body)) return "ours";
  return "other";
}

export function decideMessengerDev(probes: readonly MessengerDevProbe[]): MessengerDevAction {
  if (probes.some((probe) => probe === "ours")) return "reuse";
  if (probes.some((probe) => probe === "other")) return "refuse";
  return "start";
}

function isOurs(body: unknown): boolean {
  if (parseDiscovery(body)) return true;
  if (!body || typeof body !== "object") return false;
  const record = body as { name?: unknown; error?: unknown };
  if (!record.error || typeof record.error !== "object") return false;
  const err = record.error as { code?: unknown; message?: unknown };
  if (err.code !== "not_found") return false;
  return record.name === LOCAL_API_NAME || err.message === "runtime not running";
}
