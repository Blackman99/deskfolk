import type { CopyShape } from "./shape.ts";

export const zh = {
  groupSettings: "群组设置",
  botSettings: "Bot 设置",
  pickSession: "选择一个会话",
  pickSessionHint: "从列表里挑一个群或 Bot，或者新建一个。",
  emptyRoster: "名册是空的。点名册那一行的 + 建 Bot。",
  members: "在场",
  presenceOpen: "可打开（只读）",
  profile: "人设",
  archived: "已归档",
  deleted: "已删除",
  pin: "置顶",
  pinned: "已置顶",
  unpin: "取消置顶",
  moreActions: "更多会话操作",
};

export const en: CopyShape<typeof zh> = {
  groupSettings: "Group settings",
  botSettings: "Bot settings",
  pickSession: "Pick a session",
  pickSessionHint: "Pick a group or a Bot from the list, or start a new one.",
  emptyRoster: "The roster is empty. Use + on the roster row to create a bot.",
  members: "Here",
  presenceOpen: "open, read-only",
  profile: "Profile",
  archived: "Archived",
  deleted: "Deleted",
  pin: "Pin",
  pinned: "Pinned",
  unpin: "Unpin",
  moreActions: "More conversation actions",
};
