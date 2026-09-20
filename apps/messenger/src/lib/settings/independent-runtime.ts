import { readTauriInternals, type TauriInternals } from "../tauri.ts";

export type IndependentWriter = "window" | "agent" | "down";

export type IndependentDrain = {
  phase: "running" | "draining" | "drained";
  remaining: string[];
  forced: boolean;
};

export type IndependentStatus = {
  enabled: boolean;
  available: boolean;
  diagnostic: string;
  supervising: boolean;
  writer: IndependentWriter;
  drain: IndependentDrain;
  error: string | null;
  warning: string | null;
};

const writers = new Set<IndependentWriter>(["window", "agent", "down"]);
const phases = new Set<IndependentDrain["phase"]>(["running", "draining", "drained"]);

export const gatedIndependentStatus = (diagnostic: string): IndependentStatus => ({
  enabled: false,
  available: false,
  diagnostic,
  supervising: true,
  writer: "window",
  drain: { phase: "running", remaining: [], forced: false },
  error: null,
  warning: null,
});

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseIndependentStatus(body: unknown): IndependentStatus | null {
  if (!body || typeof body !== "object") return null;
  const record = body as {
    enabled?: unknown;
    available?: unknown;
    diagnostic?: unknown;
    supervising?: unknown;
    writer?: unknown;
    drain?: {
      phase?: unknown;
      remaining?: unknown;
      forced?: unknown;
    };
    error?: unknown;
    warning?: unknown;
  };
  if (typeof record.enabled !== "boolean" || typeof record.available !== "boolean") return null;
  if (typeof record.diagnostic !== "string" || typeof record.supervising !== "boolean") return null;
  if (typeof record.writer !== "string" || !writers.has(record.writer as IndependentWriter)) return null;
  const drain = record.drain;
  if (!drain || typeof drain !== "object") return null;
  if (typeof drain.phase !== "string" || !phases.has(drain.phase as IndependentDrain["phase"])) return null;
  if (typeof drain.forced !== "boolean" || !Array.isArray(drain.remaining)) return null;
  if (!drain.remaining.every((id) => typeof id === "string")) return null;
  return {
    enabled: record.enabled,
    available: record.available,
    diagnostic: record.diagnostic,
    supervising: record.supervising,
    writer: record.writer as IndependentWriter,
    drain: {
      phase: drain.phase as IndependentDrain["phase"],
      remaining: drain.remaining as string[],
      forced: drain.forced,
    },
    error: optionalString(record.error),
    warning: optionalString(record.warning),
  };
}

export async function invokeIndependentRuntime(
  operation: "status" | "enable" | "wait" | "force" | "cancel" | "disable",
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<IndependentStatus> {
  if (!internals?.invoke) return gatedIndependentStatus("browser_cannot_install_agent");
  try {
    const body =
      operation === "status"
        ? await internals.invoke("independent_runtime_status")
        : await internals.invoke("independent_runtime", { request: { operation } });
    return parseIndependentStatus(body) ?? gatedIndependentStatus("malformed");
  } catch {
    return gatedIndependentStatus("disabled");
  }
}

export async function setLaunchAtLogin(
  enabled: boolean,
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<boolean> {
  if (!internals?.invoke) return false;
  try {
    const result = await internals.invoke("set_launch_at_login", { enabled });
    return result === true;
  } catch {
    return false;
  }
}
