import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "委派记录", request: "委派：", result: "交回：", waitingSuffix: "（等结果）", heldSuffix: "（被叫停）",
  waiting: (name: string) => `等待：${name}交回结果`, held: "等待已挂起：被叫停",
  open: "未交回", replied: "已交回", cancelled: "已取消", since: "开始等待", due: "约定时间",
  expects: { deliverable: "交付", review: "审查", answer: "答复" },
  loadFailed: "未能载入委派记录。", retry: "重试",
};

export const en: CopyShape<typeof zh> = {
  title: "Delegation records", request: "Delegated: ", result: "Returned: ", waitingSuffix: " (waiting for result)", heldSuffix: " (held)",
  waiting: (name: string) => `Waiting: result from ${name}`, held: "Wait suspended: held",
  open: "Open", replied: "Replied", cancelled: "Cancelled", since: "Waiting since", due: "Due",
  expects: { deliverable: "Deliverable", review: "Review", answer: "Answer" },
  loadFailed: "Could not load delegation records.", retry: "Retry",
};
