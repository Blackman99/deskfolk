import { expect, test } from "bun:test";
import {
  clampGitCommitFilesHeight,
  clampGitCommitFilesWidth,
  clampGitGraphListWidth,
  GIT_COMMIT_FILES_HEIGHT_DEFAULT,
  GIT_COMMIT_FILES_HEIGHT_MAX,
  GIT_COMMIT_FILES_HEIGHT_MIN,
  GIT_COMMIT_FILES_WIDTH_DEFAULT,
  GIT_COMMIT_FILES_WIDTH_MAX,
  GIT_COMMIT_FILES_WIDTH_MIN,
  GIT_COMMIT_SIDE_BY_SIDE_MIN,
  GIT_GRAPH_LIST_DEFAULT,
  GIT_GRAPH_LIST_MAX,
  GIT_GRAPH_LIST_MIN,
  isCommitFilesSideBySide,
  loadGitCommitFilesHeight,
  loadGitCommitFilesWidth,
  loadGitGraphListWidth,
  saveGitCommitFilesHeight,
  saveGitCommitFilesWidth,
  saveGitGraphListWidth,
} from "./graph-layout.ts";

test("isCommitFilesSideBySide switches to stacked below threshold or in narrow mode", () => {
  expect(isCommitFilesSideBySide(GIT_COMMIT_SIDE_BY_SIDE_MIN, false)).toBe(true);
  expect(isCommitFilesSideBySide(GIT_COMMIT_SIDE_BY_SIDE_MIN + 200, false)).toBe(true);
  expect(isCommitFilesSideBySide(GIT_COMMIT_SIDE_BY_SIDE_MIN - 1, false)).toBe(false);
  expect(isCommitFilesSideBySide(800, true)).toBe(false);
});

test("clamp helpers enforce min, max, and container ratios", () => {
  expect(clampGitGraphListWidth(50, 1000)).toBe(GIT_GRAPH_LIST_MIN);
  expect(clampGitGraphListWidth(900, 1000)).toBe(Math.floor(1000 * 0.45));
  expect(clampGitGraphListWidth(900, 1400)).toBe(GIT_GRAPH_LIST_MAX);

  expect(clampGitCommitFilesWidth(50, 700)).toBe(GIT_COMMIT_FILES_WIDTH_MIN);
  expect(clampGitCommitFilesWidth(900, 700)).toBe(Math.floor(700 * 0.5));
  expect(clampGitCommitFilesWidth(900, 1200)).toBe(GIT_COMMIT_FILES_WIDTH_MAX);

  expect(clampGitCommitFilesHeight(20, 500)).toBe(GIT_COMMIT_FILES_HEIGHT_MIN);
  expect(clampGitCommitFilesHeight(900, 500)).toBe(Math.floor(500 * 0.5));
  expect(clampGitCommitFilesHeight(900, 1000)).toBe(GIT_COMMIT_FILES_HEIGHT_MAX);
});

test("persisted graph layout sizes round-trip through storage", () => {
  if (typeof window === "undefined" || !window.localStorage) {
    expect(loadGitGraphListWidth()).toBe(GIT_GRAPH_LIST_DEFAULT);
    expect(loadGitCommitFilesWidth()).toBe(GIT_COMMIT_FILES_WIDTH_DEFAULT);
    expect(loadGitCommitFilesHeight()).toBe(GIT_COMMIT_FILES_HEIGHT_DEFAULT);
    return;
  }
  saveGitGraphListWidth(380);
  expect(loadGitGraphListWidth()).toBe(380);
  window.localStorage.removeItem("real-bot-git-graph-list-width");
  expect(loadGitGraphListWidth()).toBe(GIT_GRAPH_LIST_DEFAULT);

  saveGitCommitFilesWidth(290);
  expect(loadGitCommitFilesWidth()).toBe(290);
  window.localStorage.removeItem("real-bot-git-commit-files-width");
  expect(loadGitCommitFilesWidth()).toBe(GIT_COMMIT_FILES_WIDTH_DEFAULT);

  saveGitCommitFilesHeight(240);
  expect(loadGitCommitFilesHeight()).toBe(240);
  window.localStorage.removeItem("real-bot-git-commit-files-height");
  expect(loadGitCommitFilesHeight()).toBe(GIT_COMMIT_FILES_HEIGHT_DEFAULT);
});
