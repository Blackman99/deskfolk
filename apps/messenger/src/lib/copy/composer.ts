import type { CopyShape } from "./shape.ts";

export const zh = {
  idle: "没有进行中的轮。",
  fork: "另开一轮",
  send: "发送",
  /** The empty input in a group: what goes here, and that @ calls on one Bot. */
  groupPrompt: "发消息，@ 可点名某个 Bot",
  /** The empty input anywhere without a better prompt. */
  messagePrompt: "发消息…",
  /** The send button while the message is on its way; remotely that can take a while. */
  sending: "发送中…",
  /** Beside a staged file's size while it uploads. */
  uploaded: (percent: number) => `已传 ${percent}%`,
  stopGeneration: "停止回复",
  waitingHint: "回复结束后可发送 · Shift+Enter 换行",
  /** A direct whose Bot is at work, or still reading your last line: what you send now reaches it at its next step. */
  workingHint: "Enter ↵ 发送，它下一步就读到 · Shift+Enter 换行",
  attach: "添加附件",
  removeAttachment: "移除附件",
  /** On a file dragged in from the workspace tree: it goes out as its path. */
  workspaceRef: "工作区里的原文件，发出时不复制",
  /** Over the composer while files from the tree are dragged onto it. */
  dropWorkspaceItems: "松开即附上 · 不复制",
  removeMention: "移除提及",
  /** The ✨ beside send. Each press is one model call on the spend ledger. */
  suggest: "建议下一步（调用一次模型）",
  suggestStop: "停止起草建议",
  suggestHide: "收起建议",
  suggestWait: "等回复结束再建议下一步",
  /** The daemon answers an empty list both when there is nothing to suggest and when the call failed. */
  suggestNone: "这次没有起草出建议",
  redirect: (name: string) => `发送会改道眼前这轮（${name}）。已做完的不回滚。`,
  forkLive: (name: string) => `发送会另开一轮；${name} 当前轮继续。`,
};

export const en: CopyShape<typeof zh> = {
  idle: "No live turn.",
  fork: "Fork a turn",
  send: "Send",
  groupPrompt: "Message the group, @ to call on a Bot",
  messagePrompt: "Message…",
  sending: "Sending…",
  uploaded: (percent: number) => `${percent}% sent`,
  stopGeneration: "Stop reply",
  waitingHint: "Send after the reply ends · Shift+Enter for newline",
  workingHint: "Enter to send — it reads it at its next step · Shift+Enter for newline",
  attach: "Add attachment",
  removeAttachment: "Remove attachment",
  workspaceRef: "The file in the workspace itself; nothing is copied",
  dropWorkspaceItems: "Drop to attach · nothing is copied",
  removeMention: "Remove mention",
  suggest: "Suggest what to send next (one model call)",
  suggestStop: "Stop drafting suggestions",
  suggestHide: "Hide suggestions",
  suggestWait: "Suggestions wait until the reply ends",
  suggestNone: "No suggestions this time",
  redirect: (name: string) => `Send redirects the live turn (${name}). Done work is not rolled back.`,
  forkLive: (name: string) => `Send forks a new turn; ${name}'s current turn keeps running.`,
};
