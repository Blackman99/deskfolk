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
} from "./tools/collab";
import { UPDATE_PROFILE, LIST_SKILLS, READ_SKILL, CREATE_SKILL, UPDATE_SKILL, DELETE_SKILL } from "./tools/profile";
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
  LIST_ROUTINES,
  CREATE_ROUTINE,
  UPDATE_ROUTINE,
  DELETE_ROUTINE,
  LIST_SKILLS,
  READ_SKILL,
  CREATE_SKILL,
  UPDATE_SKILL,
  DELETE_SKILL,
  LIST_ENDPOINTS,
  ADD_ENDPOINT,
  UPDATE_ENDPOINT,
  DELETE_ENDPOINT,
  LIST_MCP_SERVERS,
  ADD_MCP_SERVER,
  UPDATE_MCP_SERVER,
  DELETE_MCP_SERVER,
];

export function builtinTools(locale: Locale): ChatTool[] {
  return toChatTools(TOOLS, locale);
}

export const COLLAB_TOOL_NAMES = TOOLS.map((t) => t.name);
