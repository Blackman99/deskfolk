import type { Locale } from "@real-bot/protocol";
import type { ChatTool, ToolDef } from "./tool-schema";
import { toChatTools } from "./tool-schema";
import { READ_FILE, WRITE_FILE, DELETE_FILE, LIST_DIR, SHELL } from "./tools/files";
import {
  SEND_MESSAGE,
  CREATE_BOT,
  LIST_BOTS,
  LIST_SESSIONS,
  CREATE_GROUP,
  CREATE_DIRECT,
  ADD_MEMBER,
  REMOVE_MEMBER,
  ASK_USER,
  CHECK_BACK,
  END_TURN,
  WORK_ON,
  DELEGATE,
  SUBMIT,
  REVIEW,
  PLAN_ITEMS,
} from "./tools/collab";
import { UPDATE_PROFILE, LIST_SKILLS, READ_SKILL, CREATE_SKILL, UPDATE_SKILL, DELETE_SKILL } from "./tools/profile";
import { REMEMBER, FORGET } from "./tools/memory";
import { LIST_ANNOTATIONS, RESOLVE_ANNOTATION } from "./tools/annotations";
import { LIST_ROUTINES, CREATE_ROUTINE, UPDATE_ROUTINE, DELETE_ROUTINE } from "./tools/routines";
import {
  LIST_ENDPOINTS,
  ADD_ENDPOINT,
  UPDATE_ENDPOINT,
  DELETE_ENDPOINT,
  LIST_MCP_SERVERS,
  ADD_MCP_SERVER,
  UPDATE_MCP_SERVER,
  DELETE_MCP_SERVER,
} from "./tools/catalog";

export const TOOLS: ToolDef[] = [
  READ_FILE,
  WRITE_FILE,
  DELETE_FILE,
  LIST_DIR,
  SHELL,
  SEND_MESSAGE,
  CREATE_BOT,
  LIST_BOTS,
  UPDATE_PROFILE,
  LIST_SESSIONS,
  CREATE_GROUP,
  CREATE_DIRECT,
  ADD_MEMBER,
  REMOVE_MEMBER,
  ASK_USER,
  CHECK_BACK,
  WORK_ON,
  END_TURN,
  LIST_ROUTINES,
  CREATE_ROUTINE,
  UPDATE_ROUTINE,
  DELETE_ROUTINE,
  LIST_SKILLS,
  READ_SKILL,
  CREATE_SKILL,
  UPDATE_SKILL,
  DELETE_SKILL,
  REMEMBER,
  FORGET,
  LIST_ENDPOINTS,
  ADD_ENDPOINT,
  UPDATE_ENDPOINT,
  DELETE_ENDPOINT,
  LIST_MCP_SERVERS,
  ADD_MCP_SERVER,
  UPDATE_MCP_SERVER,
  DELETE_MCP_SERVER,
  LIST_ANNOTATIONS,
  RESOLVE_ANNOTATION,
];

export function builtinTools(locale: Locale, engineLevel = 0): ChatTool[] {
  // Level 5 (ADR 0046): work is handed over with submit and judged with review.
  // plan_items (ADR 0053): the lead lays the plan out as tickets, owners, reviewers, dependencies and parts.
  const defs = engineLevel >= 3 ? [...TOOLS.filter((tool) => tool.name !== "create_direct"), DELEGATE, ...(engineLevel >= 5 ? [SUBMIT, REVIEW, PLAN_ITEMS] : [])] : TOOLS;
  const tools = toChatTools(defs, locale);
  if (engineLevel >= 3) {
    for (const tool of tools) {
      if (tool.function.name === "send_message") {
        tool.function.description = locale === "en"
          ? "Post progress without ending this segment. At most three progress lines to the user; answers to a quoted user question do not count. Group mentions may wake a teammate, but plain words and @ in a Bot pair's thread never wake anyone. To give another teammate work use delegate. Keep working after sending; end explicitly with end_turn(reason)."
          : "发送进度，不结束本段。对用户最多三条进度，引用回复用户提问不计数。群里点名可叫醒；Bot 对线程里普通发言和 @ 从不叫醒。要让队友干活用 delegate。发送后接着干，最后 end_turn(reason) 明确收尾。";
      } else if (tool.function.name === "end_turn") {
        tool.function.description = locale === "en"
          ? "End this segment with done, answered, nothing_new, blocked or gave_up. done cannot claim an unfinished obligation away; blocked requires needs_from_user and gave_up requires note. Return an answer delegation with reason answered and answer. Record every user inbox disposition; a refused ending returns a bounded correction instead of ending."
          : "结束本段，reason 是 done/answered/nothing_new/blocked/gave_up。done 不能把没交出的义务说没；blocked 必填 needs_from_user，gave_up 必填 note。回答委派用 answered 和 answer。用户收件逐条写处置，拒绝的收尾会有限退回，不会直接结束。";
        tool.function.parameters.properties.reason = { type: "string", enum: ["done", "answered", "nothing_new", "blocked", "gave_up"] };
        for (const key of ["note", "needs_from_user", "answer"]) tool.function.parameters.properties[key] = { type: "string" };
        tool.function.parameters.required = ["reason"];
      }
    }
  }
  return tools;
}

export const COLLAB_TOOL_NAMES = [...TOOLS.map((t) => t.name), DELEGATE.name, SUBMIT.name, REVIEW.name, PLAN_ITEMS.name];
