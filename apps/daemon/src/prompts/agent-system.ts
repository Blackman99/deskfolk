/**
 * What a Claude Agent turn is told on top of Claude Code's own system prompt (ADR 0061). The app's
 * own system text goes in unchanged, so the collaboration rules — endings, hand-overs, reviews,
 * delegation, the inbox, how to talk in a group — are the ones every other Bot follows; a short
 * preface maps them onto this turn: the app's tools are under `mcp__deskfolk__`, and files and
 * commands go through Claude Code's own tools.
 */
import type { Locale } from "@real-bot/protocol";
import {
  formatMcpGuides,
  formatMemoryDigest,
  formatSkillCatalog,
  systemText,
  type McpPromptGuide,
  type TurnPromptTexts,
  type MemoryPromptEntry,
  type SkillPromptEntry,
} from "./system";
import { fill } from "./fill";

/** The in-process MCP server the app's tools are offered under; Claude sees `mcp__deskfolk__<tool>`. */
export const AGENT_MCP_SERVER = "deskfolk";

export function agentToolName(name: string): string {
  return `mcp__${AGENT_MCP_SERVER}__${name}`;
}

/** The Claude Agent preface (built-in prompt `agent.preface`, ADR 0064); `{workspace}` and `{cwd}` are filled per turn. */
const PREFACE_ZH = `# 在这一轮里

这一轮由用户自己的 Claude Code 运行。下面「系统指令」里写的 Deskfolk 工具都在 mcp__deskfolk__ 下：send_message 就是 mcp__deskfolk__send_message，end_turn、ask_user、check_back、work_on、delegate、submit、review、plan_items、remember、read_skill 等同理。

- 这一轮没有 read_file、write_file、delete_file、list_dir 和 shell。读写文件、找文件、跑命令用 Claude Code 自己的 Read、Write、Edit、Glob、Grep、Bash，路径写绝对路径。工作区根目录是 {workspace}；Bash 从 {cwd} 开始，它就是系统指令里说的本轮工作目录。系统指令里「相对工作区根」的路径，就是相对 {workspace} 的路径；在消息里提到文件时也这样写，应用才认得出、挂得上。
- 看图用 Read，应用会记下你看过；审查图片类交付时要先这样看过，才能给通过。
- 问用户只能用 mcp__deskfolk__ask_user，这里没有 AskUserQuestion。
- 这一轮最后一条不调用工具的回复，就是你发到会话里的消息，和系统指令说的一样会先过收尾检查；和工具调用写在同一条消息里的文字（包括 mcp__deskfolk__end_turn、mcp__deskfolk__submit 旁边的）不会发出。
- 不要读、改或打印 Claude Code 自己的设置和凭据（~/.claude、~/.claude.json、钥匙串），不要运行 claude 命令，也不要用后台任务：命令和子任务都在前台跑完。`;

const PREFACE_EN = `# In this turn

This turn is run by the user's own Claude Code. Every Deskfolk tool the System section below names is under mcp__deskfolk__: send_message is mcp__deskfolk__send_message, and the same goes for end_turn, ask_user, check_back, work_on, delegate, submit, review, plan_items, remember, read_skill and the rest.

- This turn has no read_file, write_file, delete_file, list_dir or shell. Read, write and find files and run commands with Claude Code's own Read, Write, Edit, Glob, Grep and Bash, using absolute paths. The workspace root is {workspace}; Bash starts in {cwd}, which is what the System section calls this turn's work dir. A path "relative to the workspace root" there is relative to {workspace}; write file paths in your messages that way too, or the app cannot recognize and attach them.
- Look at pictures with Read; the app records that you looked, which a review approving pictures needs.
- Ask the user only with mcp__deskfolk__ask_user; there is no AskUserQuestion here.
- Your last reply in this turn that calls no tool is the message you post, and it passes the closing check the System section describes; text in the same message as a tool call (beside mcp__deskfolk__end_turn or mcp__deskfolk__submit too) is never sent.
- Never read, change or print Claude Code's own settings or credentials (~/.claude, ~/.claude.json, the keychain), never run the claude command, and do not use background tasks: run commands and subtasks to the end in the foreground.`;

export const AGENT_PREFACE: Record<Locale, string> = { zh: PREFACE_ZH, en: PREFACE_EN };

export function agentSystemPrompt(input: {
  locale: Locale;
  name: string;
  duties: string;
  boundaries: string;
  workspace: string;
  cwd: string;
  engineLevel: number;
  skills?: SkillPromptEntry[];
  memories?: MemoryPromptEntry[];
  mcpGuides?: McpPromptGuide[];
  /** Built-in prompts you edited (ADR 0064): the System section and the section notes, and this preface. */
  texts?: TurnPromptTexts & { preface?: string };
}): string {
  const en = input.locale === "en";
  const texts = input.texts ?? {};
  const profile = en
    ? `# Profile\n\n## Name\n\n${input.name}\n\n## Duties\n\n${input.duties}\n\n## Boundaries\n\n${input.boundaries}`
    : `# 人设\n\n## 名字\n\n${input.name}\n\n## 职责\n\n${input.duties}\n\n## 边界\n\n${input.boundaries}`;
  const preface = fill(texts.preface ?? AGENT_PREFACE[input.locale], { workspace: input.workspace, cwd: input.cwd });
  const systemBody = texts.system ?? systemText(input.locale, "sh", input.engineLevel);
  const system = en ? `# System\n\n${systemBody}` : `# 系统指令\n\n${systemBody}`;
  const skills = formatSkillCatalog(input.locale, input.skills ?? [], texts.skills);
  // The shared MCP servers' tools are reached under the deskfolk MCP server here.
  const guides = (input.mcpGuides ?? []).map((guide) => ({
    ...guide,
    tools: guide.tools.map((tool) => ({ ...tool, modelName: agentToolName(tool.modelName) })),
  }));
  const mcp = formatMcpGuides(input.locale, guides, texts.mcp);
  const memory = formatMemoryDigest(input.locale, input.memories ?? [], texts.memory);
  // Memory changes most often, so it goes last, as in the app's own prompt.
  return [profile, skills, preface, system, mcp, memory].filter(Boolean).join("\n\n");
}
