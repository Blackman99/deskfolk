import { inDesktopShell, readShellBridge, type ShellBridge } from "../desktop-shell.ts";

export function parsePickedWorkspacePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  return path.length > 0 ? path : null;
}

export async function pickWorkspaceFolder(
  current: string,
  title: string,
  internals: ShellBridge | undefined = readShellBridge(),
): Promise<string | null> {
  if (!internals?.invoke) return null;
  const picked = await internals.invoke("pick_workspace_folder", {
    current: current.trim() || null,
    title,
  });
  return parsePickedWorkspacePath(picked);
}

export function workspacePickerAvailable(
  internals: ShellBridge | undefined = readShellBridge(),
): boolean {
  return inDesktopShell(internals);
}

export type HostTreePage = {
  path: string;
  parent?: string | null;
  truncated: boolean;
  items: Array<{ name: string; path: string; kind: "file" | "dir" }>;
};
