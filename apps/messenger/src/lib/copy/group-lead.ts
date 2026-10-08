import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "群负责人", badge: "负责人", badgeHint: "群里没点名的消息，优先交给这位 Bot",
  set: "设为负责人", clear: "取消负责人",
  confirmed: "没点名的消息优先交给负责人。", unconfirmed: "还没有负责人；没点名的消息仍按参与判断。",
  suggested: (count: number) => `建议：近 7 天有 ${count} 次交接`,
  failed: "未能保存，负责人未改。", loading: "正在载入负责人…", loadFailed: "未能载入负责人。", retry: "重试",
};

export const en: CopyShape<typeof zh> = {
  title: "Group lead", badge: "Lead", badgeHint: "Messages that name no one go to this Bot first",
  set: "Make lead", clear: "Remove lead",
  confirmed: "Messages that name no one go to the lead first.", unconfirmed: "No lead yet; messages that name no one still use participation judgement.",
  suggested: (count: number) => `Suggested: ${count} handoffs in the last 7 days`,
  failed: "Could not save; lead unchanged.", loading: "Loading group lead…", loadFailed: "Could not load group lead.", retry: "Retry",
};
