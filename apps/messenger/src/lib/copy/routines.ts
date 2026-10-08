import { enHost, zhHost } from "./platform-words.ts";
import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "日程", add: "新建日程", edit: "编辑日程", empty: "这个 Bot 还没有日程。",
  emptyHint: "日程到点会叫它自己开工。",
  owner: "归属 Bot", name: "标题", instruction: "任务指令", frequency: "重复", daily: "每天", weekly: "每周",
  time: "时间（24 小时制）", weekdays: "星期", days: { mon: "周一", tue: "周二", wed: "周三", thu: "周四", fri: "周五", sat: "周六", sun: "周日" },
  daysShort: { mon: "一", tue: "二", wed: "三", thu: "四", fri: "五", sat: "六", sun: "日" },
  workdays: "工作日", weekend: "周末", allDays: "全选", daySeparator: "、",
  zone: `按执行${zhHost}的本地时区运行，不按此浏览器的时区换算。`,
  availability: `执行${zhHost}需醒着且运行时可用；恢复时只补最近一次，不逐次补跑。归档 Bot 不执行日程。`,
  enabled: "启用", active: "已启用", paused: "已暂停", pause: "暂停", resume: "恢复", save: "保存日程", cancel: "取消", busy: "正在保存…",
  remove: "删除日程", deleteBody: "删除后不会再触发此日程；已开始的任务不会因此停止。", confirm: "确认删除",
  nameRequired: "请填写标题。", timeInvalid: "请输入有效的 HH:MM 时间（00:00–23:59）。", daysRequired: "每周日程至少选择一天。",
  failed: "未能保存日程，请重试。", invalid: "日程字段无效，请检查标题、时间和星期。", missing: "此日程已被删除。", conflict: "日程已在别处更新。你的草稿未覆盖它；载入最新版本后再编辑。",
  reload: "载入最新版本", disconnected: "连接已变化，未确认保存结果。重连后请核对日程，不会自动重试。",
  unknown: "原请求结果未知，可能已保存。不会自动重试。",
  pending: "原请求仍待确认，未发送修改后的草稿。这不是版本冲突。",
  retry: "重试原请求", retryHint: "重试使用原请求的内容和编号，不会发送后来修改的草稿。",
  retired: "原请求已结束待确认状态。重试未发送后来修改的草稿；请先核对列表，重新打开日程后再保存保留的草稿。",
};

export const en: CopyShape<typeof zh> = {
  title: "Routines", add: "Add routine", edit: "Edit routine", empty: "This Bot has no routines yet.",
  emptyHint: "A routine wakes it at the set time to start on its own.",
  owner: "Owning Bot", name: "Title", instruction: "Task instruction", frequency: "Repeat", daily: "Daily", weekly: "Weekly",
  time: "Time (24-hour)", weekdays: "Weekdays", days: { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" },
  daysShort: { mon: "Mo", tue: "Tu", wed: "We", thu: "Th", fri: "Fr", sat: "Sa", sun: "Su" },
  workdays: "Workdays", weekend: "Weekend", allDays: "All", daySeparator: ", ",
  zone: `Runs in the execution ${enHost}’s local time zone, not this browser’s time zone.`,
  availability: `The ${enHost} must be awake with the runtime available. On recovery, only the latest missed occurrence is caught up. Archived Bots do not run routines.`,
  enabled: "Enabled", active: "Enabled", paused: "Paused", pause: "Pause", resume: "Resume", save: "Save routine", cancel: "Cancel", busy: "Saving…",
  remove: "Delete routine", deleteBody: "This routine will no longer trigger. Deleting it does not stop work already started.", confirm: "Confirm delete",
  nameRequired: "Enter a title.", timeInvalid: "Enter a valid HH:MM time (00:00–23:59).", daysRequired: "Choose at least one weekday.",
  failed: "Could not save the routine. Please retry.", invalid: "Invalid routine fields. Check the title, time and weekdays.", missing: "This routine has been deleted.", conflict: "This routine changed elsewhere. Your draft has not overwritten it; load the latest version before editing again.",
  reload: "Load latest version", disconnected: "The connection changed; the save result is unconfirmed. Check routines after reconnecting. Nothing is retried automatically.",
  unknown: "The original request result is unknown; it may already be saved. Nothing is retried automatically.",
  pending: "The original request is still pending. Your edited draft was not sent. This is not a revision conflict.",
  retry: "Retry original request", retryHint: "Retry uses the original request’s content and ID, not your later draft edits.",
  retired: "The original request is no longer pending. Retry did not send later draft edits; check the list and reopen the routine before saving a retained draft.",
};
