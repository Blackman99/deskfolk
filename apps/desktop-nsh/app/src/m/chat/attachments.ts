export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

import { citedInWorkspace, isRasterImageName } from "../overlays/artifacts.ts";

export function isImageFileName(name: string): boolean {
  return isRasterImageName(name) || /\.svg$/i.test(name);
}

/**
 * Paths dragged from a file tree into a project session's composer, as they go out: one in the
 * workspace on the message as a file (`attach`), as a Bot's composer sends it; one elsewhere (the
 * project's own folder, written absolute) in the line itself (`mention`), since a message's files
 * are the workspace's, and the agent reads the path where it is.
 */
export function splitDraggedPaths(paths: readonly string[], workspace: string | null): { attach: string[]; mention: string[] } {
  const attach: string[] = [];
  const mention: string[] = [];
  for (const path of paths) (workspace && citedInWorkspace(workspace, path) ? attach : mention).push(path);
  return { attach, mention };
}
