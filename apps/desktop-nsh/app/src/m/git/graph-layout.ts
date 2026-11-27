import { persistedWidth } from "../storage.ts";

/** Minimum commit inspector width (points) to lay out changed files and diff side by side. */
export const GIT_COMMIT_SIDE_BY_SIDE_MIN = 540;

export const GIT_GRAPH_LIST_MIN = 220;
export const GIT_GRAPH_LIST_DEFAULT = 320;
export const GIT_GRAPH_LIST_MAX = 520;

export const GIT_COMMIT_FILES_WIDTH_MIN = 180;
export const GIT_COMMIT_FILES_WIDTH_DEFAULT = 220;
export const GIT_COMMIT_FILES_WIDTH_MAX = 460;

export const GIT_COMMIT_FILES_HEIGHT_MIN = 100;
export const GIT_COMMIT_FILES_HEIGHT_DEFAULT = 180;
export const GIT_COMMIT_FILES_HEIGHT_MAX = 400;

const graphListWidth = persistedWidth({
  key: "real-bot-git-graph-list-width",
  min: GIT_GRAPH_LIST_MIN,
  default: GIT_GRAPH_LIST_DEFAULT,
  max: GIT_GRAPH_LIST_MAX,
  ratio: 0.45,
});

const commitFilesWidth = persistedWidth({
  key: "real-bot-git-commit-files-width",
  min: GIT_COMMIT_FILES_WIDTH_MIN,
  default: GIT_COMMIT_FILES_WIDTH_DEFAULT,
  max: GIT_COMMIT_FILES_WIDTH_MAX,
  ratio: 0.5,
});

const commitFilesHeight = persistedWidth({
  key: "real-bot-git-commit-files-height",
  min: GIT_COMMIT_FILES_HEIGHT_MIN,
  default: GIT_COMMIT_FILES_HEIGHT_DEFAULT,
  max: GIT_COMMIT_FILES_HEIGHT_MAX,
  ratio: 0.5,
});

export function loadGitGraphListWidth(): number {
  return graphListWidth.load();
}

export function saveGitGraphListWidth(w: number): void {
  graphListWidth.save(w);
}

export function clampGitGraphListWidth(w: number, viewWidth?: number): number {
  return graphListWidth.clamp(w, viewWidth);
}

export function loadGitCommitFilesWidth(): number {
  return commitFilesWidth.load();
}

export function saveGitCommitFilesWidth(w: number): void {
  commitFilesWidth.save(w);
}

export function clampGitCommitFilesWidth(w: number, inspectorWidth?: number): number {
  return commitFilesWidth.clamp(w, inspectorWidth);
}

export function loadGitCommitFilesHeight(): number {
  return commitFilesHeight.load();
}

export function saveGitCommitFilesHeight(h: number): void {
  commitFilesHeight.save(h);
}

export function clampGitCommitFilesHeight(h: number, bodyHeight?: number): number {
  return commitFilesHeight.clamp(h, bodyHeight);
}

/** Whether the commit inspector has enough room to show the file tree and diff side by side. */
export function isCommitFilesSideBySide(inspectorWidth: number, narrow: boolean): boolean {
  return !narrow && inspectorWidth >= GIT_COMMIT_SIDE_BY_SIDE_MIN;
}
