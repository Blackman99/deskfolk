import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "整理模型",
  hint: "整理看板、流程和要点的模型：整理器、书记员，以及照样片和衔接的看图判定都用它（判定需要能看图的模型，选的看不了图时仍用默认模型）。这里要用强模型；在 opus 上一次整理大约输入 20k、输出 6k token。",
  followDefault: (model: string | null) => (model ? `跟随默认模型（${model}）` : "跟随默认模型"),
  failed: "没存上，再试一次"
};

export const en: CopyShape<typeof zh> = {
  title: "Organizing model",
  hint: "The model that keeps the board, trace and plan in order: the organizer, the scribe, and the picture checks against the sample and between parts (those need a model that reads images; one that cannot leaves them on the default model). Use a strong one here; on Opus one settle is about 20k tokens in and 6k out.",
  followDefault: (model: string | null) => (model ? `Follow the default model (${model})` : "Follow the default model"),
  failed: "Not saved; try again"
};
