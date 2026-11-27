import { expect, test } from "bun:test";
import {
  clampGitChangesTreeWidth,
  GIT_CHANGES_TREE_DEFAULT,
  GIT_CHANGES_TREE_MAX,
  GIT_CHANGES_TREE_MIN,
  loadGitChangesTreeWidth,
  saveGitChangesTreeWidth,
} from "./changes-tree-width.ts";

test("clampGitChangesTreeWidth stays within min, max, and 55% of the view", () => {
  expect(clampGitChangesTreeWidth(40, 800)).toBe(GIT_CHANGES_TREE_MIN);
  expect(clampGitChangesTreeWidth(900, 800)).toBe(Math.floor(800 * 0.55));
  expect(clampGitChangesTreeWidth(GIT_CHANGES_TREE_DEFAULT, 800)).toBe(GIT_CHANGES_TREE_DEFAULT);
  expect(clampGitChangesTreeWidth(900, 1200)).toBe(GIT_CHANGES_TREE_MAX);
  expect(clampGitChangesTreeWidth(900)).toBe(GIT_CHANGES_TREE_MAX);
});

test("loadGitChangesTreeWidth restores a saved width and falls back to default", () => {
  if (typeof window === "undefined" || !window.localStorage) {
    expect(loadGitChangesTreeWidth()).toBe(GIT_CHANGES_TREE_DEFAULT);
    return;
  }
  saveGitChangesTreeWidth(320);
  expect(loadGitChangesTreeWidth()).toBe(320);
  window.localStorage.removeItem("real-bot-git-changes-tree-width");
  expect(loadGitChangesTreeWidth()).toBe(GIT_CHANGES_TREE_DEFAULT);
});
