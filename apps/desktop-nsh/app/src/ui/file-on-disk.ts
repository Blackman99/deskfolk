/**
 * A file a line names, on this computer: where it is, for the right-click menu of its chip
 * (`MarkdownBody`, `FileChipMenu`), which opens it with its app or shows it in the system's file
 * manager as the file list's menu does (`ArtifactPreview`'s `openOnDisk`).
 *
 * A Bot's paths are the workspace's (what its preview opens: `absWorkspacePath` on the workspace
 * root), written in full, or from `~`; a project session's agent's are relative to where it worked,
 * so that conversation places them itself (`project-chat-state`'s `projectFiles`) and hands the
 * answer to `citedOnDisk`.
 *
 * Only a window on this computer offers the menu (`onThisComputer`): through the phone's page or a
 * remote window the files are on another machine, and a right click on a chip stays the line's menu.
 * So far only the Mac's shell opens files (`host/src/system.rs`); the Windows and Linux shells do
 * not answer `open_workspace_path` yet (`launch.rs`), so their windows leave the right click to the
 * line too.
 */
import { platform } from "nsh";
import { absWorkspacePath } from "../m/overlays/artifacts.ts";
import { sanitizeCitedPreviewPath } from "../m/session-url.ts";
import { isTauri } from "../m/tauri.ts";
import { showToast } from "../m/toast.svelte.ts";
import { copy, runtime } from "../runtime";

export type FileOnDisk = {
  /** Where `relpath` is on this computer; null once it has said why it cannot tell. */
  locate: (relpath: string) => Promise<string | null>;
  /** Opens `abs` with its app, or shows it in the file manager (`reveal`); false when the system could not. By default the shell's `open_workspace_path`. */
  open?: (abs: string, reveal: boolean) => Promise<boolean>;
};

/** This window runs on the computer the files are on, with a shell that opens them. */
export function onThisComputer(): boolean {
  return platform.os === "macos" && runtime.client?.kind !== "remote" && isTauri();
}

const fromHome = (path: string) => /^~[\\/]/.test(path);

/** The home as the runtime's machine names it, asked for once per connection (a path from `~` needs it). */
let home: { client: unknown; path: Promise<string | null> } | null = null;
function homeDir(): Promise<string | null> {
  const client = runtime.client;
  if (!client) return Promise.resolve(null);
  if (home?.client !== client) {
    const asked = {
      client,
      path: client.workspaceTree("~").then(
        (page) => page.path || null,
        () => {
          // Asked again next time.
          if (home === asked) home = null;
          return null;
        },
      ),
    };
    home = asked;
  }
  return home.path;
}

/** Where a path written in full, or from `~`, is on this computer; null for one relative to somewhere. */
export async function citedOnDisk(path: string): Promise<string | null> {
  const clean = sanitizeCitedPreviewPath(path);
  if (!clean) return null;
  return absWorkspacePath(null, clean, fromHome(clean) ? await homeDir() : null);
}

/** A path a Bot's line names: the workspace's, or written in full, or from `~`. */
async function workspaceFile(relpath: string): Promise<string | null> {
  const clean = sanitizeCitedPreviewPath(relpath);
  const root = runtime.snapshot.settings.workspace_path || null;
  const abs = clean ? absWorkspacePath(root, clean, fromHome(clean) ? await homeDir() : null) : null;
  if (!abs) showToast(copy().stream.artifactNotOnDisk(relpath), { tone: "info" });
  return abs;
}

const WORKSPACE_FILES: FileOnDisk = { locate: workspaceFile };

/** The files a Bot's lines name, where this window can open them; none elsewhere. */
export function workspaceFiles(): FileOnDisk | undefined {
  return onThisComputer() ? WORKSPACE_FILES : undefined;
}
