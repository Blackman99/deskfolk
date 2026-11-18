import type { ProjectAgent } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import { pickWorkspaceFolder, workspacePickerAvailable } from "../settings/pick-workspace.ts";
import { newProjectRequest } from "./import-claude-session.ts";

type Host = Pick<MessengerRuntime, "createProjectSession" | "openCreateProject">;

/**
 * A new project session of an agent in a folder you pick (ADR 0095, ADR 0099): the Mac's own
 * folder dialog where there is one, and the session opens in what you picked; the sheet elsewhere
 * — a phone, a browser — with that agent picked, where directories are listed and browsed instead.
 * A folder the daemon will not take opens the sheet, which says why and offers others.
 */
export async function newProjectInFolder(
  runtime: Host,
  t: Copy,
  agent: ProjectAgent = "claude_code",
  dialog: { available: () => boolean; pick: (current: string, title: string) => Promise<string | null> } = { available: () => workspacePickerAvailable(), pick: pickWorkspaceFolder },
): Promise<void> {
  if (!dialog.available()) {
    runtime.openCreateProject("new", agent);
    return;
  }
  let dir: string | null;
  try {
    dir = await dialog.pick("", t.project.pickTitle);
  } catch {
    runtime.openCreateProject("new", agent);
    return;
  }
  if (dir) await newProjectIn(runtime, dir, agent);
}

/** A new session of an agent in a directory the list already shows; one gone since opens the sheet to pick another. */
export async function newProjectIn(runtime: Host, dir: string, agent: ProjectAgent = "claude_code"): Promise<void> {
  if (await runtime.createProjectSession(newProjectRequest(dir, agent))) runtime.openCreateProject("new", agent);
}
