const STORAGE_KEY = "real-bot-artifact-tree-width";
export const ARTIFACT_TREE_MIN = 120;
export const ARTIFACT_TREE_DEFAULT = 168;
export const ARTIFACT_TREE_MAX = 360;

export function loadArtifactTreeWidth(): number {
  if (typeof window === "undefined" || !window.localStorage) return ARTIFACT_TREE_DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return ARTIFACT_TREE_DEFAULT;
    return clampArtifactTreeWidth(n);
  } catch {
    return ARTIFACT_TREE_DEFAULT;
  }
}

export function saveArtifactTreeWidth(width: number): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // ignore
  }
}

export function clampArtifactTreeWidth(
  width: number,
  paneWidth: number = Number.POSITIVE_INFINITY,
): number {
  const max = Math.min(ARTIFACT_TREE_MAX, Math.max(ARTIFACT_TREE_MIN, Math.floor(paneWidth * 0.42)));
  return Math.min(max, Math.max(ARTIFACT_TREE_MIN, Math.round(width)));
}
