type TauriInternals = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

export async function openWorkspacePath(abs: string, reveal = false): Promise<boolean> {
  const internals = readTauriInternals();
  if (!internals?.invoke) return false;
  try {
    await internals.invoke("open_workspace_path", { path: abs, reveal });
    return true;
  } catch {
    return false;
  }
}

function readTauriInternals(): TauriInternals | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const w = globalThis as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__;
}
