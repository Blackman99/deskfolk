import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "工作需要你的回答",
  context: (bot: string, plan: string, ticket: string | null) => `${bot} · ${plan}${ticket ? ` · ${ticket}` : ""}`,
  hint: "回答后，它会照你的回答接着做；叫停着的话，等你解除才接着做。",
  answer: "你的回答",
  submit: "保存回答",
  saving: "正在保存…",
  saved: "回答已保存",
  held: "回答已保存；工作仍处于叫停状态，不会自动继续。",
  failed: "回答未保存。工作可能已关闭、规划已删除或 Bot 已归档；你的草稿已保留。",
  unknown: "保存结果尚未确认；请用原回答重试，不会自动发送。",
  readOnly: "这个会话只能查看；请到有你在场的未归档会话中回答。",
  lapsedTitle: "工作曾等你回答",
  lapsed: "这件事没等这个回答就往下走了，这张卡不再收回答。",
};

export const en: CopyShape<typeof zh> = {
  title: "This work needs your answer",
  context: (bot: string, plan: string, ticket: string | null) => `${bot} · ${plan}${ticket ? ` · ${ticket}` : ""}`,
  hint: "Once you answer, it goes on with your answer; if a stop covers it, once you lift the stop.",
  answer: "Your answer",
  submit: "Save answer",
  saving: "Saving…",
  saved: "Answer saved",
  held: "Answer saved; the work remains stopped. It will not resume automatically.",
  failed: "Answer not saved. The work may be closed, the plan deleted, or the Bot archived; your draft is kept.",
  unknown: "The save is unconfirmed; retry the original answer explicitly. Nothing is sent automatically.",
  readOnly: "This conversation is read-only; answer in an active conversation where you are present.",
  lapsedTitle: "This work was waiting for your answer",
  lapsed: "The work went on without this answer; this card no longer takes one.",
};
