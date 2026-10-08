import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "项目共享技能",
  hint: "共享出去的是这条技能现在的一份副本，所有 Bot 都能在技能目录里看到、按它做，但改不了；这个 Bot 之后再改，要你再共享一次才更新。技能里可能有它记下的关于你的事，共享前看一眼。",
  ownTitle: "这个 Bot 的技能",
  othersTitle: "其他 Bot 共享的",
  share: "共享给所有 Bot",
  confirm: "确认共享",
  confirmHint: "所有 Bot 都会看到全文",
  cancel: "取消",
  sharedState: "已共享",
  changedSince: "共享后又改过",
  update: "更新共享副本",
  updateHint: "共享副本会换成下面这份，所有 Bot 都会读到：",
  confirmUpdate: "确认更新",
  sharedOff: "已共享 · 停用中",
  unshare: "停止共享",
  turnOff: "停用",
  turnOn: "启用",
  from: (name: string) => `来自 ${name}`,
  fromGone: "来自已删除的 Bot",
  failed: "没改成，再试一次"
};

export const en: CopyShape<typeof zh> = {
  title: "Project skills",
  hint: "What is shared is a copy of the skill as it is now: every Bot sees it in its catalog and follows it, but cannot change it; this Bot's later edits reach the others only when you share it again. A skill may hold what the Bot noted about you; look before sharing.",
  ownTitle: "This Bot's skills",
  othersTitle: "Shared by other Bots",
  share: "Share with every Bot",
  confirm: "Share it",
  confirmHint: "Every Bot will see all of it",
  cancel: "Cancel",
  sharedState: "Shared",
  changedSince: "Changed since shared",
  update: "Update the shared copy",
  updateHint: "The shared copy becomes this, and every Bot reads it:",
  confirmUpdate: "Update it",
  sharedOff: "Shared · off",
  unshare: "Stop sharing",
  turnOff: "Turn off",
  turnOn: "Turn on",
  from: (name: string) => `from ${name}`,
  fromGone: "from a deleted Bot",
  failed: "Not changed; try again"
};
