import type { ToolDef, ToolProp } from "../tool-schema";

export const SCHEDULE_KIND: ToolProp = {
  type: "string",
  enum: ["daily", "weekly"],
  description: { zh: "daily 或 weekly。", en: "daily or weekly." },
};

export const SCHEDULE_TIME: ToolProp = {
  type: "string",
  description: {
    zh: "本机本地时区的时刻，HH:MM（24 小时）。",
    en: "Local-machine time of day, HH:MM (24-hour).",
  },
};

export const SCHEDULE_WEEKDAYS: ToolProp = {
  type: "array",
  items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
  description: {
    zh: "仅 weekly 必填，且非空。取值为 mon、tue、wed、thu、fri、sat、sun。",
    en: "Required and non-empty for weekly only. Values: mon, tue, wed, thu, fri, sat, sun.",
  },
};

export const SCHEDULE_OBJECT: ToolProp = {
  type: "object",
  description: {
    zh: "日历日程，不是 cron，不是事件触发。",
    en: "A calendar routine, not cron, not event-triggered.",
  },
  properties: {
    kind: SCHEDULE_KIND,
    time: SCHEDULE_TIME,
    weekdays: SCHEDULE_WEEKDAYS,
  },
  required: ["kind", "time"],
};

export const LIST_ROUTINES: ToolDef = {
  name: "list_routines",
  description: {
    zh: "列出某个 Bot 的日程。省略 name 则列出你自己的。",
    en: "List a Bot's routines. Omit name for your own.",
  },
  properties: {
    name: { type: "string", description: { zh: "Bot 的名字。省略则你自己。", en: "Bot name. Omit for yourself." } },
  },
};

export const CREATE_ROUTINE: ToolDef = {
  name: "create_routine",
  description: {
    zh: "新建一条日历日程。省略 name 则挂到你自己。",
    en: "Create a calendar routine. Omit name to attach it to yourself.",
  },
  properties: {
    title: { type: "string", description: { zh: "日程标题。", en: "Routine title." } },
    instruction: { type: "string", description: { zh: "到点喂给该 Bot 的文本。", en: "Text fed to that Bot when it fires." } },
    schedule: SCHEDULE_OBJECT,
    name: { type: "string", description: { zh: "挂到这个 Bot。省略则你自己。", en: "Bot to attach to. Omit for yourself." } },
    enabled: { type: "boolean", description: { zh: "是否启用。默认 true。", en: "Whether it is enabled. Default true." } },
  },
  required: ["title", "instruction", "schedule"],
};

export const UPDATE_ROUTINE: ToolDef = {
  name: "update_routine",
  description: {
    zh: "修改一条日程。不能换到另一个 Bot。",
    en: "Change a routine. You cannot move it to another Bot.",
  },
  properties: {
    id: { type: "string", description: { zh: "日程 id。", en: "Routine id." } },
    title: { type: "string", description: { zh: "新标题。", en: "New title." } },
    instruction: { type: "string", description: { zh: "新的到点文本。", en: "New text fed on fire." } },
    schedule: {
      type: "object",
      description: { zh: "新的日历", en: "New calendar" },
      properties: {
        kind: SCHEDULE_KIND,
        time: SCHEDULE_TIME,
        weekdays: SCHEDULE_WEEKDAYS,
      },
      required: ["kind", "time"],
    },
    enabled: { type: "boolean", description: { zh: "是否启用。", en: "Whether it is enabled." } },
  },
  required: ["id"],
};

export const DELETE_ROUTINE: ToolDef = {
  name: "delete_routine",
  description: {
    zh: "删除一条日程。",
    en: "Delete a routine.",
  },
  properties: {
    id: { type: "string", description: { zh: "日程 id。", en: "Routine id." } },
  },
  required: ["id"],
};
