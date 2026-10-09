import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "读句用的模型",
  hint: "你和 Bot 的每句话，应用先用这个模型读一遍：是不是叫停或继续、是不是只问进度、哪里在挑已交付成果的毛病、Bot 是不是说着还在做就收尾了。你的话要等它读完才会叫醒 Bot，所以选个快的。读不了（没配、出错、超时）时退回固定词表。",
  followDefault: (model: string | null) => (model ? `跟随默认模型（${model}）` : "跟随默认模型"),
  claudeModel: (model: string) => `${model} · Claude Agent`,
  claudeNote: "选 Claude 模型读句，每读一次就用掉一点你 Claude 套餐的额度。",
  failed: "没存上，再试一次"
};

export const en: CopyShape<typeof zh> = {
  title: "Model that reads lines",
  hint: "Every line you and the Bots write is first read with this model: whether it tells the Bots to stop or go on, whether it only asks where the work stands, what it objects to in delivered work, whether a Bot is ending while saying it is still at it. Your line wakes no Bot until it is read, so pick a fast one. When it cannot read (none set, an error, too slow), the fixed word lists do.",
  followDefault: (model: string | null) => (model ? `Follow the default model (${model})` : "Follow the default model"),
  claudeModel: (model: string) => `${model} · Claude Agent`,
  claudeNote: "Reading with a Claude model spends a little of your Claude plan's usage each time.",
  failed: "Not saved; try again"
};
