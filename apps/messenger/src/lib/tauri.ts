export type TauriInternals = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

export function readTauriInternals(): TauriInternals | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const w = globalThis as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__;
}

export function isTauri(internals: TauriInternals | undefined = readTauriInternals()): boolean {
  return Boolean(internals?.invoke);
}
