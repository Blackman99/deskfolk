import { persistedWidth } from "../storage.ts";

export const ARTIFACT_TREE_MIN = 120;
export const ARTIFACT_TREE_DEFAULT = 168;
export const ARTIFACT_TREE_MAX = 360;

const width = persistedWidth({
  key: "real-bot-artifact-tree-width",
  min: ARTIFACT_TREE_MIN,
  default: ARTIFACT_TREE_DEFAULT,
  max: ARTIFACT_TREE_MAX,
  ratio: 0.42,
});

export function loadArtifactTreeWidth(): number {
  return width.load();
}

export function saveArtifactTreeWidth(w: number): void {
  width.save(w);
}

export function clampArtifactTreeWidth(w: number, paneWidth?: number): number {
  return width.clamp(w, paneWidth);
}
