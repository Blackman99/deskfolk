import { persistedWidth } from "../storage.ts";

export const PREVIEW_MIN = 280;
export const PREVIEW_DEFAULT = 420;

const width = persistedWidth({
  key: "real-bot-preview-width",
  min: PREVIEW_MIN,
  default: PREVIEW_DEFAULT,
  ratio: 0.62,
});

export function loadPreviewWidth(): number {
  return width.load();
}

export function savePreviewWidth(w: number): void {
  width.save(w);
}

export function clampPreviewWidth(w: number, shellWidth?: number): number {
  return width.clamp(w, shellWidth);
}
