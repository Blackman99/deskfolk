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
  MEASURE_MODEL,
  UPDATE_MODEL_SETTINGS,
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
  MEASURE_MODEL,
  UPDATE_MODEL_SETTINGS,
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
    en: "Post progress without ending this segment. At most three progress lines to the user; answers to a quoted user question do not count. Group mentions may wake a teammate, but plain words and @ in a Bot pair's thread never wake anyone. To give another teammate work use delegate. Keep working after sending; finish with a reply that calls no tool, which is your reply to the user, or with end_turn(reason) when there is nothing to say.",
    zh: "发送进度，不结束本段。对用户最多三条进度，引用回复用户提问不计数。群里点名可叫醒；Bot 对线程里普通发言和 @ 从不叫醒。要让队友干活用 delegate。发送后接着干；做完时用一段不调工具的回复收尾，那就是给用户的回复，没话可说时才用 end_turn(reason)。",
  },
  end_turn: {
    en: "End this segment without posting anything. To reply to the user, do not use it: write a reply that calls no tool, which ends the segment by itself; words written beside end_turn are never sent. Reasons: done, answered, nothing_new, blocked or gave_up. done cannot claim an unfinished obligation away; blocked is only for what the user alone can give, never for an OK to go on with work they asked for: needs_from_user is required and reaches the user as a question. Waiting on another Bot is not blocked: delegate to it, or end with nothing_new. gave_up requires note. Answer a request for an answer, or for a review with nothing submitted to review, with reason answered and your reply in answer: what you post in the thread does not reach the Bot that asked. Record every user inbox disposition; a refused ending returns a bounded correction instead of ending.",
    zh: "结束本段，不发任何消息。要回复用户就不要用它：直接写一段不调工具的回复，它本身就结束本段；写在 end_turn 旁边的话不会发出。reason 是 done/answered/nothing_new/blocked/gave_up。done 不能把没交出的义务说没；blocked 只用于只有用户能给的东西，不用来请用户点头让你接着做他要的事，必填 needs_from_user，会作为提问发给用户；等别的 Bot 不算 blocked，要么 delegate 给它，要么用 nothing_new 结束。gave_up 必填 note。回答委派（要回答的，或没有提交可审的审查请求）用 answered，回复写进 answer：线程里发的话传不到委派你的 Bot。用户收件逐条写处置，拒绝的收尾会有限退回，不会直接结束。",
  },
};

/**
 * What end_turn's `answer` is for, from level 3. Parameters are described in code, never edited (ADR
 * 0064). A Bot read 「回答…用 answered，回复写进 answer」 as the way to answer you, and the words went
 * nowhere: they reach only a Bot that asked, or a ticket whose work is words (2026-10-07).
 */
const END_TURN_ANSWER: Localized = {
  zh: "回答委派你的 Bot（请你回答，或没有提交可审的审查）的话，或在成果是文字的任务上用 done 交出的那段话。它不会作为回复出现在对话里：回复用户就直接在对话里写。",
  en: "Your reply to a Bot that asked you through delegate (for an answer, or a review with nothing submitted to review), or, with done, the words you hand over on a ticket whose work is words. It never shows in the conversation as a reply: to reply to the user, write in the conversation.",
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
        for (const key of ["note", "needs_from_user"]) tool.function.parameters.properties[key] = { type: "string" };
        tool.function.parameters.properties.answer = { type: "string", description: END_TURN_ANSWER[locale] };
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

/** The app's own tools Claude Code has its own versions of: never offered to a Bot it runs (agent-runner.ts). */
export const OWN_FILE_TOOLS: ReadonlySet<string> = new Set(["read_file", "write_file", "delete_file", "list_dir", "shell"]);

export const COLLAB_TOOL_NAMES = ALL_TOOL_DEFS.map((t) => t.name);
