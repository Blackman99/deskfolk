import { readShellBridge } from "../desktop-shell.ts";

export async function openWorkspacePath(abs: string, reveal = false): Promise<boolean> {
  const internals = readShellBridge();
  if (!internals?.invoke) return false;
  try {
    await internals.invoke("open_workspace_path", { path: abs, reveal });
    return true;
  } catch {
    return false;
  }
}
