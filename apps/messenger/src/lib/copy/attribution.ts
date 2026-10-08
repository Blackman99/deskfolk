import type { CopyShape } from "./shape.ts";

export const zh = {
  filed: (name: string) => `归到：${name}`, undetermined: "未归属", choose: "选择归属", chipHint: "点击修改归属", unknownPlan: "一件事", more: (count: number) => `另 ${count} 件`,
  menuItem: "改归属…", title: "归到哪件事", message: "这条消息", noText: "（没有文字）",
  usedAt: (time: string) => `最近用过 ${time}`, ticketCount: (count: number) => `${count} 个任务`,
  search: "搜索事情或任务", chosen: "已选", here: "这个会话里的", others: (count: number) => `其他事情（${count}）`, showOthers: (count: number) => `显示其他 ${count} 件`, noMatch: "没有匹配的事情",
  ticket: "任务", part: "分件", wholePlan: "整件事", partPlaceholder: "分件（可选），如 Shot 01", addFiling: "再加一个任务", addPart: "指定分件", removeFiling: "移除这项",
  unfile: "不归到任何事", unfiled: "这句话不归到任何事。", cancel: "取消", save: "保存", saving: "正在保存…", failed: "未能保存，归属未改。你的选择已保留。",
  loading: "正在载入…", loadFailed: "未能载入事情列表。", retry: "重试", noPlans: "还没有可选的事情。",
  newJob: "新开一件事", newJobHint: "用这句话开一件新事，原来那件不受影响",
};

export const en: CopyShape<typeof zh> = {
  filed: (name: string) => `Filed under: ${name}`, undetermined: "Unfiled", choose: "Choose", chipHint: "Click to change", unknownPlan: "A job", more: (count: number) => `+${count} more`,
  menuItem: "Change attribution…", title: "Which job is this about?", message: "This message", noText: "(no text)",
  usedAt: (time: string) => `Last used ${time}`, ticketCount: (count: number) => (count === 1 ? "1 ticket" : `${count} tickets`),
  search: "Search jobs or tickets", chosen: "Chosen", here: "In this conversation", others: (count: number) => `Other jobs (${count})`, showOthers: (count: number) => `Show ${count} other jobs`, noMatch: "No job matches",
  ticket: "Ticket", part: "Part", wholePlan: "Whole job", partPlaceholder: "Part (optional), e.g. Shot 01", addFiling: "Add another ticket", addPart: "Set a part", removeFiling: "Remove this one",
  unfile: "File under no job", unfiled: "This is not filed under any job.", cancel: "Cancel", save: "Save", saving: "Saving…", failed: "Could not save; attribution unchanged. Your selection is preserved.",
  loading: "Loading…", loadFailed: "Could not load the list of jobs.", retry: "Retry", noPlans: "There are no jobs to choose from yet.",
  newJob: "A new job", newJobHint: "Open a new job from this line; the other job is left as it is",
};
