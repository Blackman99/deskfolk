import type { CopyShape } from "./shape.ts";

export const zh = {
  you: "你",
  close: "关闭",
  back: "返回",
  copyImage: "复制图片",
  copyImageFailed: "没能复制图片",
  updateReady: "有新版本",
  updateReload: "刷新",
};

export const en: CopyShape<typeof zh> = {
  you: "You",
  close: "Close",
  back: "Back",
  copyImage: "Copy image",
  copyImageFailed: "Couldn’t copy the image",
  updateReady: "A new version is ready",
  updateReload: "Reload",
};
