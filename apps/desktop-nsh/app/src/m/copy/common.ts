import type { CopyShape } from "./shape.ts";

export const zh = {
  you: "你",
  system: "系统",
  close: "关闭",
  back: "返回",
  copyImage: "复制图片",
  copyImageFailed: "没能复制图片",
  updateReady: "有新版本",
  updateReload: "刷新",
  deleting: "正在删除…",
  creating: "正在创建…",
  clearing: "正在清空…",
  viewLoadFailed: "这部分没能加载出来。",
  viewLoadReload: "重新载入页面",
  viewLoadRetry: "重试",
  noOptions: "暂无选项",
};

export const en: CopyShape<typeof zh> = {
  you: "You",
  system: "System",
  close: "Close",
  back: "Back",
  copyImage: "Copy image",
  copyImageFailed: "Couldn’t copy the image",
  updateReady: "A new version is ready",
  updateReload: "Reload",
  deleting: "Deleting…",
  creating: "Creating…",
  clearing: "Clearing…",
  viewLoadFailed: "This part didn’t load.",
  viewLoadReload: "Reload the page",
  viewLoadRetry: "Try again",
  noOptions: "No options",
};
