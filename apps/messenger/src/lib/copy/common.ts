import type { CopyShape } from "./shape.ts";

export const zh = {
  you: "你",
  close: "关闭",
  back: "返回",
  copyImage: "复制图片",
  copyImageFailed: "没能复制图片",
  updateReady: "有新版本",
  updateReload: "刷新",
  deleting: "正在删除…",
  clearing: "正在清空…",
};

export const en: CopyShape<typeof zh> = {
  you: "You",
  close: "Close",
  back: "Back",
  copyImage: "Copy image",
  copyImageFailed: "Couldn’t copy the image",
  updateReady: "A new version is ready",
  updateReload: "Reload",
  deleting: "Deleting…",
  clearing: "Clearing…",
};
