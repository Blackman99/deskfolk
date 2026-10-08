import { enHost, zhHost } from "./platform-words.ts";
import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "日程图",
  open: "日程图",
  empty: "名册上还没有日程。",
  phoneReadOnly: "这里可以看。改时间请到桌面拖动，或打开 Bot 的日程。",
  projectionHint: `格子是规则展开，不是每次运行的记录。标出的应跑点只在这台${zhHost}上可信。`,
  lastFiredHostOnly: `应跑点标记只在执行${zhHost}上显示。格子上的钟点就是那台${zhHost}的本地时间。`,
  detail: "日程详情",
  lastFired: "这是最近一次应跑点。",
  noInstruction: "没有任务指令。",
  filter: "名册",
  filterAll: "全部",
  filterSearch: "搜索名字或职责",
  filterNoMatch: "没有匹配的 Bot。",
  filterShow: "显示",
  filterHide: "隐藏",
  filterReset: "重置",
  agendaEmpty: "这一段没有日程。",
};

export const en: CopyShape<typeof zh> = {
  title: "Routine calendar",
  open: "Routine calendar",
  empty: "No routines on the roster yet.",
  phoneReadOnly: "You can look here. To change a time, drag it on the desktop, or open the Bot’s routines.",
  projectionHint: `A block is the rule unfolded, not a record of each run. A marked due time is only trustworthy on this ${enHost}.`,
  lastFiredHostOnly: `Due marks show only on the execution ${enHost}. The clock on a block is that ${enHost}’s local time.`,
  detail: "Routine",
  lastFired: "This is the latest time it was due.",
  noInstruction: "No task instruction.",
  filter: "Roster",
  filterAll: "All",
  filterSearch: "Search name or duties",
  filterNoMatch: "No matching Bots.",
  filterShow: "Show",
  filterHide: "Hide",
  filterReset: "Show all",
  agendaEmpty: "Nothing in this range.",
};
