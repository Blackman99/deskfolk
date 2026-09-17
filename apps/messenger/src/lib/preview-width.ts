const STORAGE_KEY = "real-bot-preview-width";
export const PREVIEW_MIN = 280;
export const PREVIEW_DEFAULT = 420;

export function loadPreviewWidth(): number {
  if (typeof window === "undefined" || !window.localStorage) return PREVIEW_DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return PREVIEW_DEFAULT;
    return clampPreviewWidth(n, 1600);
  } catch {
    return PREVIEW_DEFAULT;
  }
}

export function savePreviewWidth(width: number): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // ignore
  }
}

export function clampPreviewWidth(width: number, shellWidth: number): number {
  const max = Math.max(PREVIEW_MIN, Math.floor(shellWidth * 0.62));
  return Math.min(max, Math.max(PREVIEW_MIN, Math.round(width)));
}
