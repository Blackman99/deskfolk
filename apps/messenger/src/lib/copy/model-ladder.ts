import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "模型阶梯",
  hint: "从弱到强排几个模型。一件活连着没过、它的模型思考档已经到顶（或测过提档没用）时，下一轮换到阶梯上往上一个模型；活通过后回到原来的。你钉的模型和任务上指定的模型不会被换。Claude Code 装好并登录后，也能把 Claude 模型排上来，各自选思考强度和账号；换到这一级时，那一轮由你的 Claude Code 来做。",
  empty: "还没排。不排的话，到顶时只告诉你一次，换不换由你定。",
  unset: "还没排",
  add: "加一个模型",
  move: (model: string) => `拖动调整 ${model} 的位置，或按上下方向键`,
  remove: (model: string) => `从阶梯上拿掉 ${model}`,
  effort: (level: string) => `思考强度 ${level}`,
  effortOf: (model: string) => `${model} 的思考强度`,
  accountOf: (model: string) => `${model} 用的 Claude 账号`,
  weaker: "弱",
  stronger: "强",
  failed: "没存上，再试一次"
};

export const en: CopyShape<typeof zh> = {
  title: "Model ladder",
  hint: "Order a few models from weaker to stronger. When a job keeps failing and its model is at its top thinking level (or measured to gain nothing from thinking), its next turn moves one model up the ladder; the job's approval puts it back. Your pin and a ticket's model are never switched. With Claude Code installed and signed in, Claude models can be rungs too, each with its own effort and account; a turn on such a rung is worked by your Claude Code.",
  empty: "Not ordered yet. Without a ladder you are told once at the top, and switching models is yours.",
  unset: "Not ordered yet",
  add: "Add a model",
  move: (model: string) => `Drag to move ${model}, or use the up and down arrow keys`,
  remove: (model: string) => `Take ${model} off the ladder`,
  effort: (level: string) => `Effort: ${level}`,
  effortOf: (model: string) => `Effort for ${model}`,
  accountOf: (model: string) => `Claude account for ${model}`,
  weaker: "Weaker",
  stronger: "Stronger",
  failed: "Not saved; try again"
};
