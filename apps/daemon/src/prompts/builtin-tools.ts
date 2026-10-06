import type { Locale } from "@real-bot/protocol";
import type { ToolShellKind } from "../platform";
import type { ChatTool, Localized, ToolDef } from "./tool-schema";
import { toChatTools } from "./tool-schema";
import { READ_FILE, WRITE_FILE, DELETE_FILE, LIST_DIR, SHELL, readFileTool, writeFileTool, deleteFileTool, listDirTool, shellTool } from "./tools/files";
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
import { UPDATE_PROFILE, LIST_SKILLS, READ_SKILL, CREATE_SKILL, UPDATE_SKILL, DELETE_SKILL, updateProfileTool } from "./tools/profile";
import { REMEMBER, FORGET } from "./tools/memory";
import { LIST_ANNOTATIONS, RESOLVE_ANNOTATION } from "./tools/annotations";
import { EDIT_PROMPT, LIST_PROMPTS, READ_PROMPT, RESET_PROMPT } from "./tools/prompts";
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
import { DESCRIBE_DATA, QUERY_DATA, READ_DATA_LOG } from "./tools/data";

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
  LIST_PROMPTS,
  READ_PROMPT,
  EDIT_PROMPT,
  RESET_PROMPT,
  DESCRIBE_DATA,
  QUERY_DATA,
  READ_DATA_LOG,
];

/** What send_message and end_turn say from level 3 (ADR 0044): segments end only through end_turn. */
const LEVEL3_DESCRIPTIONS: Record<string, Localized> = {
  send_message: {
    en: "Post progress without ending this segment. At most three progress lines to the user; answers to a quoted user question do not count. Group mentions may wake a teammate, but plain words and @ in a Bot pair's thread never wake anyone. To give another teammate work use delegate. Keep working after sending; end explicitly with end_turn(reason).",
    zh: "发送进度，不结束本段。对用户最多三条进度，引用回复用户提问不计数。群里点名可叫醒；Bot 对线程里普通发言和 @ 从不叫醒。要让队友干活用 delegate。发送后接着干，最后 end_turn(reason) 明确收尾。",
  },
  end_turn: {
    en: "End this segment with done, answered, nothing_new, blocked or gave_up. done cannot claim an unfinished obligation away; blocked is only for what the user alone can give, never for an OK to go on with work they asked for: needs_from_user is required and reaches the user as a question. Waiting on another Bot is not blocked: delegate to it, or end with nothing_new. gave_up requires note. Answer a request for an answer, or for a review with nothing submitted to review, with reason answered and your reply in answer: what you post in the thread does not reach the Bot that asked. Record every user inbox disposition; a refused ending returns a bounded correction instead of ending.",
    zh: "结束本段，reason 是 done/answered/nothing_new/blocked/gave_up。done 不能把没交出的义务说没；blocked 只用于只有用户能给的东西，不用来请用户点头让你接着做他要的事，必填 needs_from_user，会作为提问发给用户；等别的 Bot 不算 blocked，要么 delegate 给它，要么用 nothing_new 结束。gave_up 必填 note。回答委派（要回答的，或没有提交可审的审查请求）用 answered，回复写进 answer：线程里发的话传不到委派你的 Bot。用户收件逐条写处置，拒绝的收尾会有限退回，不会直接结束。",
  },
};

/** Tools whose description is written for the shell behind `shell` (see `tools/files.ts`). */
const SHELL_TOOLS: Record<string, (shell: ToolShellKind) => ToolDef> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  delete_file: deleteFileTool,
  list_dir: listDirTool,
  shell: shellTool,
  update_profile: updateProfileTool,
};

/** Every app tool a Bot can be offered, at any level. */
export const ALL_TOOL_DEFS: readonly ToolDef[] = [...TOOLS, DELEGATE, SUBMIT, REVIEW, PLAN_ITEMS];

/**
 * A tool's description as the app ships it (built-in prompt `tool.<name>`, ADR 0064), for a level and
 * a shell: what a Bot reads when nobody has edited it. Its parameters are described in code.
 */
export function toolDescription(name: string, locale: Locale, env: { level: number; shell: ToolShellKind }): string {
  const level3 = env.level >= 3 ? LEVEL3_DESCRIPTIONS[name] : undefined;
  if (level3) return level3[locale];
  const def = SHELL_TOOLS[name]?.(env.shell) ?? ALL_TOOL_DEFS.find((tool) => tool.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def.description[locale];
}

/**
 * The app's tools for one hop. `edited` gives the description you wrote for a tool (ADR 0064), or
 * undefined to keep the one shipped; parameters are never edited.
 */
export function builtinTools(locale: Locale, engineLevel = 0, edited?: (name: string) => string | undefined): ChatTool[] {
  // Level 5 (ADR 0046): work is handed over with submit and judged with review.
  // plan_items (ADR 0053): the lead lays the plan out as tickets, owners, reviewers, dependencies and parts.
  const defs = engineLevel >= 3 ? [...TOOLS.filter((tool) => tool.name !== "create_direct"), DELEGATE, ...(engineLevel >= 5 ? [SUBMIT, REVIEW, PLAN_ITEMS] : [])] : TOOLS;
  const tools = toChatTools(defs, locale);
  if (engineLevel >= 3) {
    for (const tool of tools) {
      if (tool.function.name === "send_message") {
        tool.function.description = LEVEL3_DESCRIPTIONS.send_message![locale];
      } else if (tool.function.name === "end_turn") {
        tool.function.description = LEVEL3_DESCRIPTIONS.end_turn![locale];
        tool.function.parameters.properties.reason = { type: "string", enum: ["done", "answered", "nothing_new", "blocked", "gave_up"] };
        for (const key of ["note", "needs_from_user", "answer"]) tool.function.parameters.properties[key] = { type: "string" };
        tool.function.parameters.required = ["reason"];
      }
    }
  }
  if (edited) {
    for (const tool of tools) {
      const text = edited(tool.function.name);
      if (text !== undefined) tool.function.description = text;
    }
  }
  return tools;
}

export const COLLAB_TOOL_NAMES = ALL_TOOL_DEFS.map((t) => t.name);
