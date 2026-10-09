import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "模型阶梯",
  hint: "从弱到强排几个模型。一件活连着没过、它的模型思考档已经到顶（或测过提档没用）时，下一轮换到阶梯上往上一个模型；活通过后回到原来的。你钉的模型和任务上指定的模型不会被换。",
  empty: "还没排。不排的话，到顶时只告诉你一次，换不换由你定。",
  unset: "还没排",
  add: "加一个模型",
  up: (model: string) => `把 ${model} 往前挪`,
  down: (model: string) => `把 ${model} 往后挪`,
  remove: (model: string) => `从阶梯上拿掉 ${model}`,
  weaker: "弱",
  stronger: "强",
  failed: "没存上，再试一次"
};

export const en: CopyShape<typeof zh> = {
  title: "Model ladder",
  hint: "Order a few models from weaker to stronger. When a job keeps failing and its model is at its top thinking level (or measured to gain nothing from thinking), its next turn moves one model up the ladder; the job's approval puts it back. Your pin and a ticket's model are never switched.",
  empty: "Not ordered yet. Without a ladder you are told once at the top, and switching models is yours.",
  unset: "Not ordered yet",
  add: "Add a model",
  up: (model: string) => `Move ${model} up`,
  down: (model: string) => `Move ${model} down`,
  remove: (model: string) => `Take ${model} off the ladder`,
  weaker: "Weaker",
  stronger: "Stronger",
  failed: "Not saved; try again"
};
