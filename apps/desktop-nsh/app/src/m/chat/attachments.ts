export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

import { isRasterImageName } from "../overlays/artifacts.ts";

export function isImageFileName(name: string): boolean {
  return isRasterImageName(name) || /\.svg$/i.test(name);
}
