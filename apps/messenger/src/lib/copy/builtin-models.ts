import type { BuiltinModelRole } from "@real-bot/protocol";
import type { CopyShape } from "./shape.ts";

type RoleCopy = { name: string; hint: string };

export const zh = {
  title: "内置模型",
  hint: "应用自己发起的模型调用，每个都可以换一个模型：端点上的模型，或者走你本机 Claude Code 的 Claude 模型。不单独设就和以前一样：前三组跟默认模型，以 Bot 身份的跟这个 Bot 自己的模型。",
  unsetSummary: "全部照旧",
  chosenSummary: (count: number) => `单独设了 ${count} 项`,
  followDefault: (model: string | null) => (model ? `跟随默认模型（${model}）` : "跟随默认模型"),
  followBot: "跟随 Bot 自己的模型",
  claudeModel: (model: string) => `${model} · Claude Agent`,
  claudeNote: "选 Claude 模型，每调用一次就用掉一点你 Claude 套餐的额度。",
  failed: "没存上，再试一次",
  groups: {
    reading: { title: "读你的话", hint: "你的话要等它读完才会叫醒 Bot，选个快的。" },
    organizing: { title: "整理与检查", hint: "看板、流程和要点靠这几个调用整理，要用强模型；在 opus 上一次整理大约输入 20k、输出 6k token。" },
    composing: { title: "输入", hint: "你按下 ✨ 在等它，选个快的。" },
    asBot: { title: "以 Bot 身份", hint: "这几个调用替某个 Bot 做，不单独设时用这个 Bot 自己的模型。" },
  },
  roles: {
    reader: { name: "读句", hint: "你和 Bot 的每句话先用它读一遍：是不是叫停或继续、是不是只问进度、在挑哪处交付的毛病、Bot 是不是说着还在做就收尾了。读不了时退回固定词表。" },
    organizer: { name: "整理器", hint: "把这件事整理成看板上的任务和要点里的进展。" },
    scribe: { name: "书记员", hint: "把你的话记成要点里的要求。每句话都跑，Bot 不等它。" },
    judge: { name: "看图判定", hint: "对照样片、检查前后衔接。端点上的模型没标「能看图」时，看图仍用默认模型；Claude 模型都能看图。" },
    composer: { name: "输入建议", hint: "按 ✨ 时替你拟下一句。" },
    judgement: { name: "判断下场", hint: "群里一句没点名的话，各个 Bot 先判断要不要接。" },
    reflection: { name: "反思", hint: "你推翻了一次放行后，负责审查的 Bot 想想下回该多查什么。" },
    retrospective: { name: "完工复盘", hint: "一件事交付后，Bot 回看全程，提出要记住的经验和技能的改动。" },
    compaction: { name: "压缩上下文", hint: "一轮快写满模型的上下文时，把前面的步骤写成摘要接着做。" },
  } satisfies Record<BuiltinModelRole, RoleCopy>,
};

export const en: CopyShape<typeof zh> = {
  title: "Built-in models",
  hint: "The model calls the app makes on its own, each of which can run on a model of its own: one an endpoint lists, or a Claude model run through your Claude Code. Left unset, a call runs as before: the first three groups on the default model, the calls made as a Bot on that Bot's own model.",
  unsetSummary: "All as before",
  chosenSummary: (count: number) => (count === 1 ? "1 set apart" : `${count} set apart`),
  followDefault: (model: string | null) => (model ? `Follow the default model (${model})` : "Follow the default model"),
  followBot: "Follow the Bot's own model",
  claudeModel: (model: string) => `${model} · Claude Agent`,
  claudeNote: "A Claude model spends a little of your Claude plan's usage on each call.",
  failed: "Not saved; try again",
  groups: {
    reading: { title: "Reading your lines", hint: "Your line wakes no Bot until it is read, so pick a fast one." },
    organizing: { title: "Organizing and checking", hint: "These keep the board, trace and plan in order; use a strong model. On Opus one settle is about 20k tokens in and 6k out." },
    composing: { title: "Composer", hint: "You pressed ✨ and are waiting, so pick a fast one." },
    asBot: { title: "As a Bot", hint: "These are made on a Bot's behalf; left unset, they run on that Bot's own model." },
  },
  roles: {
    reader: { name: "Reading lines", hint: "Every line you and the Bots write is read with it first: whether it tells the Bots to stop or go on, whether it only asks where the work stands, what it objects to in delivered work, whether a Bot is ending while saying it is still at it. When it cannot read, the fixed word lists do." },
    organizer: { name: "Organizer", hint: "Turns the job into the board's tasks and the plan's progress." },
    scribe: { name: "Scribe", hint: "Writes your lines down as the plan's requirements. It runs on every line; no Bot waits for it." },
    judge: { name: "Picture checks", hint: "Checks against the sample and between parts. An endpoint's model not marked as reading images leaves the pictures on the default model; every Claude model reads them." },
    composer: { name: "Composer suggestions", hint: "Drafts your next line when you press ✨." },
    judgement: { name: "Joining in", hint: "On a group line that names nobody, each Bot first judges whether to take it up." },
    reflection: { name: "Reflection", hint: "After you overturn an approval, the reviewing Bot works out what to check next time." },
    retrospective: { name: "Retrospective", hint: "After a job is delivered, the Bot looks back over it and proposes what to remember and how to change its skills." },
    compaction: { name: "Context compaction", hint: "When a turn nears the model's context window, the steps so far are summed up so it can go on." },
  },
};
