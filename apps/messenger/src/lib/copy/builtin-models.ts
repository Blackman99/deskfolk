import type { BuiltinModelRole } from "@real-bot/protocol";
import type { CopyShape } from "./shape.ts";

type RoleCopy = { name: string; hint: string };

export const zh = {
  followDefault: (model: string | null) => (model ? `跟随默认模型（${model}）` : "跟随默认模型"),
  followBot: "跟随 Bot 自己的模型",
  claudeModel: (model: string) => `${model} · Claude Agent`,
  claudeNote: "选 Claude 模型，每调用一次就用掉一点你 Claude 套餐的额度。",
  agentNote: (agent: string) => `选 ${agent} 的模型，每调用一次就用掉一点你在 ${agent} 上的额度。`,
  failed: "没存上，再试一次",
  roles: {
    reader: { name: "读句", hint: "你和 Bot 的每句话先用它读一遍：是不是叫停或继续、是不是只问进度、在挑哪处交付的毛病、Bot 是不是说着还在做就收尾了。读不了时退回固定词表。你的话要等它读完才叫醒 Bot，选个快的。" },
    organizer: { name: "整理器", hint: "把这件事整理成看板上的任务和要点里的进展。要读整份规划、写回整份规划，用强模型；在 opus 上一次整理大约输入 20k、输出 6k token。" },
    scribe: { name: "书记员", hint: "把你的话记成要点里的要求。每句话都跑，Bot 不等它。" },
    judge: { name: "看图判定", hint: "对照样片、检查前后衔接。端点上的模型没标「能看图」时，看图仍用默认模型；Claude 模型都能看图。" },
    composer: { name: "输入建议", hint: "按 ✨ 时替你拟下一句。你在等它，选个快的。" },
    judgement: { name: "判断下场", hint: "群里一句没点名的话，各个 Bot 先判断要不要接。" },
    reflection: { name: "反思", hint: "你推翻了一次放行后，负责审查的 Bot 想想下回该多查什么。" },
    retrospective: { name: "完工复盘", hint: "一件事交付后，Bot 回看全程，提出要记住的经验和技能的改动。" },
    compaction: { name: "压缩上下文", hint: "一轮快写满模型的上下文时，把前面的步骤写成摘要接着做。" },
  } satisfies Record<BuiltinModelRole, RoleCopy>,
};

export const en: CopyShape<typeof zh> = {
  followDefault: (model: string | null) => (model ? `Follow the default model (${model})` : "Follow the default model"),
  followBot: "Follow the Bot's own model",
  claudeModel: (model: string) => `${model} · Claude Agent`,
  claudeNote: "A Claude model spends a little of your Claude plan's usage on each call.",
  agentNote: (agent: string) => `A ${agent} model spends a little of your usage on ${agent} on each call.`,
  failed: "Not saved; try again",
  roles: {
    reader: { name: "Reading lines", hint: "Every line you and the Bots write is read with it first: whether it tells the Bots to stop or go on, whether it only asks where the work stands, what it objects to in delivered work, whether a Bot is ending while saying it is still at it. When it cannot read, the fixed word lists do. Your line wakes no Bot until it is read, so pick a fast one." },
    organizer: { name: "Organizer", hint: "Turns the job into the board's tasks and the plan's progress. It reads and writes back the whole plan, so use a strong model; on Opus one settle is about 20k tokens in and 6k out." },
    scribe: { name: "Scribe", hint: "Writes your lines down as the plan's requirements. It runs on every line; no Bot waits for it." },
    judge: { name: "Picture checks", hint: "Checks against the sample and between parts. An endpoint's model not marked as reading images leaves the pictures on the default model; every Claude model reads them." },
    composer: { name: "Composer suggestions", hint: "Drafts your next line when you press ✨. You are waiting on it, so pick a fast one." },
    judgement: { name: "Joining in", hint: "On a group line that names nobody, each Bot first judges whether to take it up." },
    reflection: { name: "Reflection", hint: "After you overturn an approval, the reviewing Bot works out what to check next time." },
    retrospective: { name: "Retrospective", hint: "After a job is delivered, the Bot looks back over it and proposes what to remember and how to change its skills." },
    compaction: { name: "Context compaction", hint: "When a turn nears the model's context window, the steps so far are summed up so it can go on." },
  },
};
