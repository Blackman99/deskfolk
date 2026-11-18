import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "应用记下的教训",
  subtitle: "递归搜索跑满超时被杀后，应用把这一类调用记成教训：先警告一次，Bot 坚持再跑又超时就拦下，对所有 Bot 生效。误放行或卡在能力天花板之后，Bot 的反思提出的清单和检查，你在卡片上采用后也列在这里。停用后不再起作用。",
  warn: "先警告",
  block: "拦下",
  retired: "已停用",
  toWarn: "改成先警告",
  toBlock: "改成拦下",
  retire: "停用",
  restore: "恢复",
  failed: "没改成，再试一次",
  stats: (hits: number, prevented: number, recurrences: number) => `命中 ${hits} 次 · 拦住 ${prevented} 次 · 复犯 ${recurrences} 次`,
  lastSeen: (time: string) => `最近一次 ${time}`,
  candidate: "待你在卡片上确认",
  adopted: "已采用",
  checkProposal: "检查提议",
  checklistAt: { before_review: "审查前的清单", before_submit: "交付前的清单", before_generate: "生成前的清单" },
  fromReflection: "来自一次反思：误放行或卡在能力天花板之后",
  checkKind: { exists: "文件存在", contains: "文件里有", matches: "文件匹配正则" }
};

export const en: CopyShape<typeof zh> = {
  title: "Lessons the app learned",
  subtitle: "When the timeout kills a search that walks a tree, the app keeps that kind of call as a lesson: a warning first, and a block once a Bot insists and it times out again, for every Bot. After an overturned approval or a capability ceiling, what a Bot's reflection proposes is listed here too once you adopt it on its card. A retired lesson no longer applies.",
  warn: "Warns",
  block: "Blocks",
  retired: "Retired",
  toWarn: "Warn instead",
  toBlock: "Block instead",
  retire: "Retire",
  restore: "Bring back",
  failed: "Not changed; try again",
  stats: (hits: number, prevented: number, recurrences: number) => `${hits} hits · ${prevented} held back · ${recurrences} recurrences`,
  lastSeen: (time: string) => `last ${time}`,
  candidate: "Waiting on your card",
  adopted: "Adopted",
  checkProposal: "Check proposal",
  checklistAt: { before_review: "Checklist before reviewing", before_submit: "Checklist before handing over", before_generate: "Checklist before generating" },
  fromReflection: "From a reflection after an overturned approval or a capability ceiling",
  checkKind: { exists: "File exists", contains: "File contains", matches: "File matches" }
};
