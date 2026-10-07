import type { ToolDef } from "../tool-schema";

/** The built-in prompt tools (ADR 0064): reading them is free; changing one waits for your approval card. */

export const LIST_PROMPTS: ToolDef = {
  name: "list_prompts",
  description: {
    zh: "列出内置提示词：每一轮的系统指令和技能 / 记忆 / MCP 段的开头、Claude Agent 前言、工具说明、应用自己的调用（整理跳、读句、书记员、参与判断、复盘、衔接检查……）。每条写明是默认还是改过、谁改的、新默认和改过的版本有没有冲突、改动以来回答读不懂几次。只读。",
    en: "List the built-in prompts: the System section and the notes that open the Skills, Memory and MCP sections, the Claude Agent preface, tool descriptions, and the app's own calls (organizer, line readings, scribe, join judgement, retrospective, seams checks…). Each says whether it is the default or edited, who changed it, whether a newer default conflicts with the edit, and how many answers failed to read since. Read-only.",
  },
  properties: {
    group: {
      type: "string",
      enum: ["turn", "agent", "tool", "call"],
      description: {
        zh: "只看一组：turn（每一轮）、agent（Claude Agent）、tool（工具说明）、call（应用自己的调用）。不填时工具说明只列一行汇总。",
        en: "Only one group: turn, agent, tool (tool descriptions) or call (the app's own calls). Left out, tool descriptions are summed up in one line.",
      },
    },
  },
};

export const READ_PROMPT: ToolDef = {
  name: "read_prompt",
  description: {
    zh: "读一条内置提示词：现在生效的可改部分（花括号里的 {…} 是应用填进去的占位符）、应用固定的输出格式（改不了）、占位符说明和最近几次修改。with_default 为 true 时附上默认原文。只读。",
    en: "Read one built-in prompt: the editable part in force (a word in braces, {…}, is a placeholder the app fills in), the app's fixed answer format (not editable), what each placeholder is, and its recent changes. with_default adds the default text. Read-only.",
  },
  properties: {
    id: { type: "string", description: { zh: "提示词的 id，如 turn.system、tool.send_message、call.organizer（见 list_prompts）。", en: "The prompt's id, e.g. turn.system, tool.send_message, call.organizer (see list_prompts)." } },
    locale: { type: "string", enum: ["zh", "en"], description: { zh: "哪个语言的版本；不填用应用的语言（只有一种语言的就用那一种）。", en: "Which language's version; left out, the app's language (or the only one it comes in)." } },
    with_default: { type: "boolean", description: { zh: "附上默认原文。", en: "Include the default text." } },
    part: { type: "array", items: { type: "integer" }, description: { zh: "按段号读，最多 5 段（很长的提示词先给目录）。", en: "Paragraph numbers to read, up to 5 (a long prompt answers with an outline first)." } },
    find: { type: "string", description: { zh: "只读含这段原文的段落。", en: "Read only the paragraphs holding this exact text." } },
  },
  required: ["id"],
};

export const EDIT_PROMPT: ToolDef = {
  name: "edit_prompt",
  description: {
    zh: "提出修改一条内置提示词；所有 Bot 都会受影响。edits 里每一处是一种改法：old + new 把正文里恰好出现一次的原文换掉（new 为空就是删掉）；after + add 在恰好出现一次的原文后面紧接着补上；只给 add 就作为新的一段追加到末尾。reason 写为什么改、依据是什么（查到的记录、用户的原话）。不会立刻生效：用户在批准卡上同意了才改，之后能撤销；拒绝就是 denied。占位符要保留，输出格式改不了。只改每个 Bot 都该照做的；只关于你自己的做法写进你的技能，学到的事实用 remember，用户的要求不要写进提示词。",
    en: "Propose a change to one built-in prompt; every Bot is affected. Each item in edits is one change: old + new replaces a passage that occurs exactly once (an empty new deletes it); after + add inserts right after a passage that occurs exactly once; add alone appends a new paragraph at the end. reason says why and on what evidence (records you queried, the user's words). It does not take effect at once: it changes when the user approves the card, and can be undone; a refusal comes back as denied. Keep the placeholders; the answer format cannot be changed. Change only what every Bot should do: how you yourself work goes into your skills, a fact you learned into remember, and the user's requirements never into a prompt.",
  },
  properties: {
    id: { type: "string", description: { zh: "提示词的 id。", en: "The prompt's id." } },
    locale: { type: "string", enum: ["zh", "en"], description: { zh: "改哪个语言的版本；不填用应用的语言。", en: "Which language's version; left out, the app's language." } },
    edits: {
      type: "array",
      description: { zh: "1 到 10 处改动，按顺序套用。", en: "1 to 10 changes, applied in order." },
      items: {
        type: "object",
        properties: {
          old: { type: "string", description: "Exact text to replace (occurs once)." },
          new: { type: "string", description: "What replaces it." },
          after: { type: "string", description: "Exact text to insert after (occurs once)." },
          add: { type: "string", description: "Text to insert, or to append when alone." },
        },
      },
    },
    reason: { type: "string", description: { zh: "一两句：为什么改、依据是什么。", en: "A sentence or two: why, and on what evidence." } },
  },
  required: ["id", "edits", "reason"],
};

export const RESET_PROMPT: ToolDef = {
  name: "reset_prompt",
  description: {
    zh: "提出把一条改过的内置提示词恢复成默认；同样要用户在批准卡上同意，之后能撤销。",
    en: "Propose putting an edited built-in prompt back on its default; it waits for the user's approval card too, and can be undone.",
  },
  properties: {
    id: { type: "string", description: { zh: "提示词的 id。", en: "The prompt's id." } },
    locale: { type: "string", enum: ["zh", "en"], description: { zh: "哪个语言的版本；不填用应用的语言。", en: "Which language's version; left out, the app's language." } },
    reason: { type: "string", description: { zh: "为什么恢复。", en: "Why." } },
  },
  required: ["id", "reason"],
};
