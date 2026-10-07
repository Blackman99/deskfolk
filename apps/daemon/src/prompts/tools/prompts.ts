import type { ToolDef } from "../tool-schema";

/** The built-in prompt tools (ADR 0064): reading them is free; changing one waits for your approval card. */

export const LIST_PROMPTS: ToolDef = {
  name: "list_prompts",
  description: {
    zh: "列出内置提示词（系统指令和各段开头、Claude Agent 前言、工具说明、应用自己的调用）：默认还是改过、谁改的、有无冲突、改后读不懂几次。",
    en: "List the built-in prompts (System section and section notes, Claude Agent preface, tool descriptions, the app's own calls): default or edited, by whom, any conflict with a newer default, unreadable answers since.",
  },
  properties: {
    group: {
      type: "string",
      enum: ["turn", "agent", "tool", "call"],
      description: {
        zh: "只看一组：turn、agent、tool、call。不填时工具说明汇成一行。",
        en: "One group only: turn, agent, tool or call. Left out, tool descriptions are summed in one line.",
      },
    },
  },
};

export const READ_PROMPT: ToolDef = {
  name: "read_prompt",
  description: {
    zh: "读一条内置提示词：生效的可改部分（{…} 是应用填的占位符）、固定的输出格式、占位符说明、最近的修改。太长时先给目录，再用 part / find 按段读。",
    en: "Read one built-in prompt: the editable text in force ({…} are placeholders the app fills), the fixed answer format, the placeholders, recent changes. A long one answers with an outline; read it with part or find.",
  },
  properties: {
    id: { type: "string", description: { zh: "提示词 id，如 turn.system、tool.send_message、call.organizer。", en: "The prompt's id, e.g. turn.system, tool.send_message, call.organizer." } },
    locale: { type: "string", enum: ["zh", "en"], description: { zh: "语言版本；不填用应用的语言。", en: "Which language; the app's when left out." } },
    with_default: { type: "boolean", description: { zh: "附上默认原文。", en: "Include the default text." } },
    part: { type: "array", items: { type: "integer" }, description: { zh: "段号，最多 5 个。", en: "Paragraph numbers, up to 5." } },
    find: { type: "string", description: { zh: "只读含这段原文的段落。", en: "Only the paragraphs holding this exact text." } },
  },
  required: ["id"],
};

export const EDIT_PROMPT: ToolDef = {
  name: "edit_prompt",
  description: {
    zh: "提出改一条所有 Bot 共用的内置提示词，用户在批准卡上同意才生效，能撤销。先问：每个 Bot 的每类活都该这样吗？只关于某类活或某几个 Bot 的别改这里，那是它们自己的技能（完工复盘会写），告诉用户。edits：old + new 替换恰好出现一次的原文；after + add 在它后面补；只给 add 追加到末尾。保留占位符；reason 写依据。",
    en: "Propose a change to a built-in prompt every Bot shares; it applies once the user approves the card, and can be undone. First ask: should every Bot do this in every kind of work? If it is about one kind of work or a few Bots, do not change it here — it belongs in their own skills (retrospectives write those); tell the user. Edits: old + new replaces a passage occurring exactly once; after + add inserts after one; add alone appends at the end. Keep the placeholders; reason gives the evidence.",
  },
  properties: {
    id: { type: "string", description: { zh: "提示词 id。", en: "The prompt's id." } },
    locale: { type: "string", enum: ["zh", "en"], description: { zh: "语言版本；不填用应用的语言。", en: "Which language; the app's when left out." } },
    edits: {
      type: "array",
      description: { zh: "1 到 10 处，按顺序套用。", en: "1 to 10 changes, applied in order." },
      items: {
        type: "object",
        properties: {
          old: { type: "string", description: { zh: "要换掉的原文（恰好出现一次）。", en: "Exact text to replace (occurs once)." } },
          new: { type: "string", description: { zh: "换成什么。", en: "What replaces it." } },
          after: { type: "string", description: { zh: "在这段原文后补（恰好出现一次）。", en: "Exact text to insert after (occurs once)." } },
          add: { type: "string", description: { zh: "要补的文字；单独给就追加到末尾。", en: "Text to insert, or to append when alone." } },
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
    zh: "提出把改过的内置提示词恢复默认；同样等批准卡，能撤销。",
    en: "Propose restoring an edited built-in prompt's default; it waits for the approval card too, and can be undone.",
  },
  properties: {
    id: { type: "string", description: { zh: "提示词 id。", en: "The prompt's id." } },
    locale: { type: "string", enum: ["zh", "en"], description: { zh: "语言版本；不填用应用的语言。", en: "Which language; the app's when left out." } },
    reason: { type: "string", description: { zh: "为什么。", en: "Why." } },
  },
  required: ["id", "reason"],
};
