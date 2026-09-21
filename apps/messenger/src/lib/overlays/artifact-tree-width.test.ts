import { expect, test } from "bun:test";
import {
  ARTIFACT_TREE_DEFAULT,
  ARTIFACT_TREE_MAX,
  ARTIFACT_TREE_MIN,
  clampArtifactTreeWidth,
  loadArtifactTreeWidth,
  saveArtifactTreeWidth,
} from "./artifact-tree-width.ts";

test("clampArtifactTreeWidth stays between the min and 42% of the pane", () => {
  expect(clampArtifactTreeWidth(10, 800)).toBe(ARTIFACT_TREE_MIN);
  expect(clampArtifactTreeWidth(900, 800)).toBe(Math.floor(800 * 0.42));
  expect(clampArtifactTreeWidth(ARTIFACT_TREE_DEFAULT, 800)).toBe(ARTIFACT_TREE_DEFAULT);
  expect(clampArtifactTreeWidth(900)).toBe(ARTIFACT_TREE_MAX);
});

test("loadArtifactTreeWidth restores a saved width instead of shrinking to a default pane", () => {
  if (typeof window === "undefined" || !window.localStorage) {
    expect(loadArtifactTreeWidth()).toBe(ARTIFACT_TREE_DEFAULT);
    return;
  }
  saveArtifactTreeWidth(280);
  expect(loadArtifactTreeWidth()).toBe(280);
  window.localStorage.removeItem("real-bot-artifact-tree-width");
  expect(loadArtifactTreeWidth()).toBe(ARTIFACT_TREE_DEFAULT);
});
