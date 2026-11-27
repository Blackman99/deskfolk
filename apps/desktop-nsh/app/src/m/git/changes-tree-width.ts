import { persistedWidth } from "../storage.ts";

export const GIT_CHANGES_TREE_MIN = 180;
export const GIT_CHANGES_TREE_DEFAULT = 250;
export const GIT_CHANGES_TREE_MAX = 520;

const width = persistedWidth({
  key: "real-bot-git-changes-tree-width",
  min: GIT_CHANGES_TREE_MIN,
  default: GIT_CHANGES_TREE_DEFAULT,
  max: GIT_CHANGES_TREE_MAX,
  ratio: 0.55,
});

export function loadGitChangesTreeWidth(): number {
  return width.load();
}

export function saveGitChangesTreeWidth(w: number): void {
  width.save(w);
}

export function clampGitChangesTreeWidth(w: number, viewWidth?: number): number {
  return width.clamp(w, viewWidth);
}
