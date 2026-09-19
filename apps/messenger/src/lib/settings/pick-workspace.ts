import { isTauri, readTauriInternals, type TauriInternals } from "../tauri.ts";

export function parsePickedWorkspacePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  return path.length > 0 ? path : null;
}

export async function pickWorkspaceFolder(
  current: string,
  title: string,
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<string | null> {
  if (!internals?.invoke) return null;
  const picked = await internals.invoke("pick_workspace_folder", {
    current: current.trim() || null,
    title,
  });
  return parsePickedWorkspacePath(picked);
}

export function workspacePickerAvailable(
  internals: TauriInternals | undefined = readTauriInternals(),
): boolean {
  return isTauri(internals);
}
