import { isTauri, readTauriInternals, type TauriInternals } from "../tauri.ts";
import type { MessengerApi } from "../messenger-api.ts";

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
  remote = false,
): boolean {
  return remote || isTauri(internals);
}

export type HostTreePage = {
  path: string;
  parent?: string | null;
  truncated: boolean;
  items: Array<{ name: string; path: string; kind: "file" | "dir" }>;
};

export async function listRemoteHostDir(api: MessengerApi, path = ""): Promise<HostTreePage> {
  if (!("hostTree" in api) || typeof api.hostTree !== "function") {
    throw new Error("host browse is remote-only");
  }
  return api.hostTree(path);
}
