import { expect, test } from "bun:test";
import {
  ARTIFACT_TREE_DEFAULT,
  ARTIFACT_TREE_MIN,
  clampArtifactTreeWidth,
} from "./artifact-tree-width.ts";

test("clampArtifactTreeWidth stays between the min and 42% of the pane", () => {
  expect(clampArtifactTreeWidth(10, 800)).toBe(ARTIFACT_TREE_MIN);
  expect(clampArtifactTreeWidth(900, 800)).toBe(Math.floor(800 * 0.42));
  expect(clampArtifactTreeWidth(ARTIFACT_TREE_DEFAULT, 800)).toBe(ARTIFACT_TREE_DEFAULT);
});
