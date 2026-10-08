/**
 * The built-in prompts (ADR 0064): every text the app ships to a model that you, or a Bot with your
 * approval, can rewrite. Each slot names what its text is for, the languages it comes in, the
 * placeholders the code fills in, and — for the app's own calls, whose answers code parses — the
 * fixed answer format, which is never part of what you edit: your text carries `{format}` where it
 * goes.
 *
 * A slot's default is rendered for an engine level and a shell, the way the text has always been
 * built; what you write replaces that rendered text whole. The texts themselves stay in their own
 * modules; this one only lists them.
 */
import type { Locale } from "@real-bot/protocol";
import type { ToolShellKind } from "../platform";
import { ENGINE_LEVELS } from "../store/schema-gate";
import { seamsJudgeFormat, seamsJudgeTemplate, type SeamJudgeMode } from "../seams-check";
import { standardJudgeFormat, standardJudgeTemplate } from "../standard-check";
import { AGENT_PREFACE } from "./agent-system";
import { ALL_TOOL_DEFS, toolDescription } from "./builtin-tools";
import { COMPACT_TEMPLATE } from "./compaction";
import { COMPOSER_SUGGEST_FORMAT, COMPOSER_SUGGEST_TEMPLATE } from "./composer-suggestions";
import type { Placeholder } from "./fill";
import { JUDGEMENT_FORMAT, JUDGEMENT_TEMPLATE } from "./judgement";
import { ORGANIZER_FORMAT, ORGANIZER_TEMPLATE, ORGANIZER_TEMPLATE_UNDER_HOLDS } from "./organizer";
import {
  READ_BOT_LINE_FORMAT,
  READ_BOT_LINE_TEMPLATE,
  READ_FILING_FORMAT,
  READ_FILING_TEMPLATE,
  READ_SCALE_FORMAT,
  READ_SCALE_TEMPLATE,
  READ_USER_LINE_FORMAT,
  READ_USER_LINE_TEMPLATE,
} from "./reader";
import { reflectionFormat, reflectionTemplate } from "./reflection";
import { retrospectiveFormat, retrospectiveTemplate } from "./retrospective";
import { SCRIBE_FORMAT, SCRIBE_TEMPLATE } from "./scribe";
import { MCP_INTRO, MEMORY_INTRO, SKILLS_INTRO, systemText } from "./system";
import type { Localized } from "./tool-schema";

/** Where a slot sits in the settings tab: every turn, the Claude Agent preface, tools, the app's own calls. */
export type PromptGroup = "turn" | "agent" | "tool" | "call";

/** What a default is rendered for: the engine level and the shell behind `shell`. */
export type PromptEnv = { level: number; shell: ToolShellKind };

/** Which built-in prompt a call ran on, and which revision of yours (null: the default). */
export type PromptRef = { id: string; locale: Locale; revision_id: string | null };

export type SlotDef = {
  id: string;
  group: PromptGroup;
  /** The languages it comes in; a slot in one language is used whatever the app's language is. */
  locales: readonly Locale[];
  title: Localized;
  summary: Localized;
  /** Placeholders the code fills in; `format` must appear exactly once, the others at least once. */
  placeholders: readonly Placeholder[];
  /**
   * The fixed answer format filled in at `{format}`, for a call whose answer code parses. A call
   * whose answer is read as plain text (the context compaction, ADR 0068) has none.
   */
  format?: (locale: Locale, env: PromptEnv) => string;
  /** The text once filled must hold no `{`: its answer is read from the first `{…}` (ADR 0012). */
  noBrace?: true;
  /** The editable text as shipped, rendered for a level and a shell. */
  defaultText: (locale: Locale, env: PromptEnv) => string;
};

export const PLACEHOLDER_MEANING: Record<Placeholder, Localized> = {
  format: { zh: "应用固定的输出格式插在这里", en: "where the app's fixed answer format goes" },
  item: { zh: "这条验收的原文", en: "the acceptance line" },
  rules: { zh: "这个规划定过的规则", en: "the plan's rules" },
  workspace: { zh: "工作区根目录的绝对路径", en: "the workspace root's absolute path" },
  cwd: { zh: "这一轮的工作目录", en: "this turn's work dir" },
};

const BOTH: readonly Locale[] = ["zh", "en"];
const ZH: readonly Locale[] = ["zh"];

function call(
  id: string,
  title: Localized,
  summary: Localized,
  locales: readonly Locale[],
  template: (locale: Locale, env: PromptEnv) => string,
  format: (locale: Locale, env: PromptEnv) => string,
  extra: Partial<Pick<SlotDef, "placeholders" | "noBrace">> = {},
): SlotDef {
  return { id, group: "call", locales, title, summary, placeholders: extra.placeholders ?? ["format"], format, defaultText: template, ...(extra.noBrace ? { noBrace: true } : {}) };
}

function seams(mode: SeamJudgeMode, title: Localized, summary: Localized): SlotDef {
  return call(`call.seams_${mode}`, title, summary, BOTH, (l) => seamsJudgeTemplate(l, mode), (l) => seamsJudgeFormat(l, mode), {
    placeholders: ["item", "rules", "format"],
  });
}

const TURN_SLOTS: SlotDef[] = [
  {
    id: "turn.system",
    group: "turn",
    locales: BOTH,
    title: { zh: "系统指令", en: "System instructions" },
    summary: {
      zh: "每个 Bot 每一跳都读的工作守则：遇到障碍怎么办、怎么交接、怎么说话、批准和边界。",
      en: "The rules every Bot reads on every hop: obstacles, hand-overs, how to talk, approvals and boundaries.",
    },
    placeholders: [],
    defaultText: (l, env) => systemText(l, env.shell, env.level),
  },
  {
    id: "turn.skills",
    group: "turn",
    locales: BOTH,
    title: { zh: "技能段的开头", en: "Skills section opening" },
    summary: { zh: "技能目录前的说明：先读匹配的技能再动手，技能和 MCP 怎么分工。", en: "The note before the skills catalog: read a matching skill first; how skills and MCP divide the work." },
    placeholders: [],
    defaultText: (l) => SKILLS_INTRO[l],
  },
  {
    id: "turn.memory",
    group: "turn",
    locales: BOTH,
    title: { zh: "记忆段的开头", en: "Memory section opening" },
    summary: { zh: "记忆列表前的说明：记忆是以前的结论，和转录冲突时以转录为准，怎么记、怎么删。", en: "The note before the memories: a memory is an earlier conclusion, the transcript wins, how to remember and forget." },
    placeholders: [],
    defaultText: (l) => MEMORY_INTRO[l],
  },
  {
    id: "turn.mcp",
    group: "turn",
    locales: BOTH,
    title: { zh: "本轮 MCP 段的开头", en: "MCP section opening" },
    summary: { zh: "MCP 服务器列表前的说明：用法备注优先，怎么挑工具，怎么把工作区里的图片交给工具。", en: "The note before the MCP servers: usage notes first, how to pick tools, how to hand a workspace picture to one." },
    placeholders: [],
    defaultText: (l) => MCP_INTRO[l],
  },
];

const AGENT_SLOTS: SlotDef[] = [
  {
    id: "agent.preface",
    group: "agent",
    locales: BOTH,
    title: { zh: "Claude Agent 前言", en: "Claude Agent preface" },
    summary: {
      zh: "由你的 Claude Code 跑的 Bot 每一轮多读的一段：应用的工具在 mcp__deskfolk__ 下，文件和命令用 Claude Code 自己的工具。",
      en: "What a Bot run by your Claude Code reads on top: the app's tools are under mcp__deskfolk__, files and commands go through Claude Code's own tools.",
    },
    placeholders: ["workspace", "cwd"],
    defaultText: (l) => AGENT_PREFACE[l],
  },
];

const TOOL_SLOTS: SlotDef[] = ALL_TOOL_DEFS.map((tool) => ({
  id: `tool.${tool.name}`,
  group: "tool" as const,
  locales: BOTH,
  title: { zh: tool.name, en: tool.name },
  summary: { zh: "模型看到的这个工具是做什么的；参数的说明不在这里。", en: "What the model is told this tool does; its parameters are described elsewhere." },
  placeholders: [],
  defaultText: (l: Locale, env: PromptEnv) => toolDescription(tool.name, l, env),
}));

const CALL_SLOTS: SlotDef[] = [
  call(
    "call.organizer",
    { zh: "整理跳", en: "Organizer" },
    { zh: "替会话记录规划要点和任务交接的后台调用。", en: "The background call that keeps a conversation's plan and its tickets." },
    ZH,
    (_l, env) => (env.level >= ENGINE_LEVELS.holds ? ORGANIZER_TEMPLATE_UNDER_HOLDS : ORGANIZER_TEMPLATE),
    () => ORGANIZER_FORMAT,
  ),
  call(
    "call.read_user_line",
    { zh: "读句：你的话", en: "Line reading: your line" },
    { zh: "读你的一句话：是不是叫停或继续、是不是只问进度、哪几句在挑已交付成果的毛病。", en: "Reads a line of yours: a stop or a go-on, only a status question, which parts object to delivered work." },
    ZH,
    () => READ_USER_LINE_TEMPLATE,
    () => READ_USER_LINE_FORMAT,
  ),
  call(
    "call.read_bot_line",
    { zh: "读句：Bot 的话", en: "Line reading: a Bot's line" },
    { zh: "读 Bot 的一句话：是不是许诺稍后给、是不是声称测过、是不是只有一句状态、是不是只在请你点头。", en: "Reads a Bot's line: a promise of later, a claim of testing, a bare status, a request for your OK." },
    ZH,
    () => READ_BOT_LINE_TEMPLATE,
    () => READ_BOT_LINE_FORMAT,
  ),
  call(
    "call.read_filing",
    { zh: "读句：说的是哪件事", en: "Line reading: which job" },
    { zh: "读你的一句话在说哪件事，好交给做那件事的 Bot。", en: "Reads which job a line of yours is about, so it reaches the Bot doing it." },
    ZH,
    () => READ_FILING_TEMPLATE,
    () => READ_FILING_FORMAT,
  ),
  call(
    "call.read_scale",
    { zh: "读句：是不是大活", en: "Line reading: a large job" },
    { zh: "判断一件事是不是要拆开、先做样片的大活。", en: "Judges whether a job is a large one, to be split and sampled first." },
    ZH,
    () => READ_SCALE_TEMPLATE,
    () => READ_SCALE_FORMAT,
  ),
  call(
    "call.scribe",
    { zh: "书记员", en: "Scribe" },
    { zh: "把你话里的要求记进需求台账的补丁。", en: "Turns the requirements in your line into a patch for the requirements ledger." },
    ZH,
    () => SCRIBE_TEMPLATE,
    () => SCRIBE_FORMAT,
  ),
  call(
    "call.judgement",
    { zh: "参与判断", en: "Join judgement" },
    { zh: "群里没点名时，Bot 判断要不要下场。", en: "In a group, whether a Bot nobody mentioned joins in." },
    ZH,
    () => JUDGEMENT_TEMPLATE,
    () => JUDGEMENT_FORMAT,
    { noBrace: true },
  ),
  call(
    "call.composer",
    { zh: "输入建议", en: "Composer suggestions" },
    { zh: "给你下一句要发的话起草建议。", en: "Drafts of what you might send next." },
    ZH,
    () => COMPOSER_SUGGEST_TEMPLATE,
    () => COMPOSER_SUGGEST_FORMAT,
    { noBrace: true },
  ),
  call(
    "call.reflection",
    { zh: "收窄的反思", en: "Narrowed reflection" },
    { zh: "放行被你推翻、或卡在能力天花板之后，当事的 Bot 提一条清单项或检查。", en: "After an approval you overturned or a capability ceiling, the Bot involved proposes one checklist item or check." },
    BOTH,
    (l) => reflectionTemplate(l),
    (l) => reflectionFormat(l),
  ),
  call(
    "call.retrospective",
    { zh: "完工复盘", en: "Retrospective" },
    { zh: "你接受的一件事交付后，做过它的 Bot 回看一次，改进自己的记忆和技能。", en: "After a job you accepted is delivered, each Bot that made it looks back and improves its own memories and skills." },
    BOTH,
    (l) => retrospectiveTemplate(l),
    (l) => retrospectiveFormat(l),
  ),
  // Its answer is the summary itself, handed back to the Bot as written: no format to lock (ADR 0068).
  {
    id: "call.compact",
    group: "call",
    locales: BOTH,
    title: { zh: "上下文压缩", en: "Context compaction" },
    summary: {
      zh: "一轮的工作在上下文里快放不下时，把前面的工具调用和结果压成摘要，Bot 从摘要接着做。",
      en: "When a turn's work nears the model's context limit, condenses its earlier tool calls and results into a summary the Bot carries on from.",
    },
    placeholders: [],
    defaultText: (l) => COMPACT_TEMPLATE[l],
  },
  seams(
    "image",
    { zh: "衔接检查：画面", en: "Seams check: pictures" },
    { zh: "对照相邻两部分的画面，看衔接是否一致。", en: "Compares the pictures at each seam between two parts." },
  ),
  seams(
    "text",
    { zh: "衔接检查：文字", en: "Seams check: text" },
    { zh: "对照相邻两部分的文字，看衔接是否一致。", en: "Compares the text at each seam between two parts." },
  ),
  seams(
    "digest",
    { zh: "衔接检查：通篇", en: "Seams check: whole" },
    { zh: "通篇看各部分的名字、编号、数字和单位是否前后一致。", en: "Checks names, numbers and units across the whole deliverable." },
  ),
  call(
    "call.standard",
    { zh: "照样片检查", en: "Sample standard check" },
    { zh: "大活里交上来的一部分有没有达到你放行的样片的水准。", en: "Whether a part of a large job keeps the standard of the sample you approved." },
    BOTH,
    (l) => standardJudgeTemplate(l),
    (l) => standardJudgeFormat(l),
    { placeholders: ["item", "rules", "format"] },
  ),
];

export const SLOTS: readonly SlotDef[] = [...TURN_SLOTS, ...AGENT_SLOTS, ...TOOL_SLOTS, ...CALL_SLOTS];

const BY_ID = new Map(SLOTS.map((slot) => [slot.id, slot]));

export function slotDef(id: string): SlotDef | undefined {
  return BY_ID.get(id);
}

/** The language a slot is used in: the one asked for when it has it, else its only one. */
export function slotLocale(slot: SlotDef, locale: Locale): Locale {
  return slot.locales.includes(locale) ? locale : slot.locales[0]!;
}

/** A slot's editable text as shipped, for a level and a shell. */
export function renderDefault(slot: SlotDef, locale: Locale, env: PromptEnv): string {
  return slot.defaultText(slotLocale(slot, locale), env);
}
