/**
 * The menu of a right click on a file a line names (its chip in `MarkdownBody`): open it with the
 * system's app, show it in Finder, copy its path on the machine. The file list's own menu
 * (`ArtifactTreeMenu`) drawn for this one file, its entries' test ids
 * `artifact-tree-menu-{open,reveal,copy-abs-path}`.
 *
 * Where the file is comes from `files.locate` when an entry is chosen, which says itself why it
 * cannot tell; a file the system could not open (moved, deleted since) is said too.
 */
import { Clipboard } from "nsh";
import { openWorkspacePath } from "../m/overlays/open-workspace.ts";
import { showToast } from "../m/toast.svelte.ts";
import { copy } from "../runtime";
import type { FileOnDisk } from "./file-on-disk";
import { ArtifactTreeMenu } from "./overlays/ArtifactTreeMenu";

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

export function FileChipMenu(props: { files: FileOnDisk; path: string; x: number; y: number; onClose: () => void }) {
  // Each entry reads the file as it is chosen, before the menu closes: the props are gone once it has.
  async function onDisk(reveal: boolean): Promise<void> {
    const { files, path } = props;
    const abs = await files.locate(path);
    if (!abs) return;
    const opened = await (files.open ?? openWorkspacePath)(abs, reveal);
    if (!opened) showToast(copy().stream.artifactNotOnDisk(path), { tone: "info" });
  }

  async function copyAbsPath(): Promise<void> {
    const abs = await props.files.locate(props.path);
    if (abs) await Clipboard.writeText(abs).catch(() => {});
  }

  return (
    <ArtifactTreeMenu
      x={props.x}
      y={props.y}
      title={baseName(props.path)}
      onOpen={() => void onDisk(false)}
      onReveal={() => void onDisk(true)}
      onCopyAbsPath={() => void copyAbsPath()}
      onClose={props.onClose}
    />
  );
}
