/** Spend view strings. `zh` is the default, `en` the other. */
import type { Locale, SpendCategory, SpendKind } from "@real-bot/protocol";

export type SpendCopy = {
  subtitle: string;
  overview: string;
  period: string;
  refresh: string;
  refreshing: string;
  clearAll: string;
  usageDetails: string;
  coverage: string;
  recordedCalls: (n: number) => string;
  coveredCalls: (n: number) => string;
  breakdownHint: string;
  distribution: string;
  sort: string;
  ascending: string;
  descending: string;
  inspect: string;
  openTrigger: string;
  detailHint: string;
  loadedCalls: (n: number) => string;
  loadingMore: string;
  title: string;
  open: string;
  loading: string;
  error: string;
  retry: string;
  empty: string;
  emptyHint: string;
  ranges: { today: string; last7: string; last30: string; all: string; custom: string };
  from: string;
  to: string;
  rangeBlank: string;
  rangeInvalid: string;
  rangeReversed: string;
  totals: string;
  input: string;
  cached: string;
  output: string;
  reasoning: string;
  totalTokens: string;
  calls: string;
  reported: string;
  estimated: string;
  estimatedHint: string;
  estimateCoverage: (reported: number, estimated: number) => string;
  estimateUnavailable: string;
  /** Shown when a missing amount could be an unset rate, short usage, or both. */
  estimateUnknown: string;
  estimateUnconfigured: string;
  estimateIncompleteUsage: string;
  missingUsage: (n: number) => string;
  missingAmount: (n: number) => string;
  categories: string;
  expand: string;
  collapse: string;
  category: Record<SpendCategory, string>;
  kind: Record<SpendKind, string>;
  trend: string;
  metricTokens: string;
  metricMoney: string;
  reportedStack: string;
  estimatedStack: string;
  dayAmount: (day: string, category: string, amount: string) => string;
  dayTokens: (day: string, category: string, tokens: string) => string;
  dimension: string;
  dimensions: { model: string; session: string; bot: string };
  unrecordedModel: string;
  unassignedBot: string;
  deleted: string;
  sortBy: (column: string) => string;
  clearFilter: (label: string) => string;
  filters: string;
  openSession: string;
  details: string;
  time: string;
  session: string;
  bot: string;
  model: string;
  amount: string;
  loadMore: string;
  dash: string;
};

const zh: SpendCopy = {
  subtitle: "用量与调用成本",
  overview: "概览",
  period: "时间范围",
  refresh: "刷新花费",
  refreshing: "更新中…",
  clearAll: "清除全部",
  usageDetails: "用量分项",
  coverage: "金额与用量说明",
  recordedCalls: (n) => `${n.toLocaleString('zh-CN')} 次调用`,
  coveredCalls: (n) => `${n.toLocaleString('zh-CN')} 次调用有记录`,
  breakdownHint: "选择一项，查看它的全部用量",
  distribution: "用量分布",
  sort: "排序",
  ascending: "升序",
  descending: "降序",
  inspect: "查看用量分项",
  openTrigger: "查看触发消息",
  detailHint: "逐次查看调用的归属、用量和金额",
  loadedCalls: (n) => `已载入 ${n.toLocaleString('zh-CN')} 次调用`,
  loadingMore: "正在载入…",
  title: "花费",
  open: "花费",
  loading: "正在读取花费…",
  error: "花费没有读出来。",
  retry: "重试",
  empty: "这段时间没有花费。",
  emptyHint: "试试其他时间范围，或清除当前筛选。",
  ranges: { today: "今天", last7: "近 7 天", last30: "近 30 天", all: "全部", custom: "自定义" },
  from: "从",
  to: "到",
  rangeBlank: "请填写开始和结束日期。",
  rangeInvalid: "日期无效。",
  rangeReversed: "结束日期不能早于开始日期。",
  totals: "总计",
  input: "输入",
  cached: "缓存",
  output: "输出",
  reasoning: "推理",
  totalTokens: "总 token",
  calls: "调用",
  reported: "实报",
  estimated: "估算",
  estimatedHint: "端点没报金额，按模型单价估算。实报和估算分开合计。",
  estimateCoverage: (reported, estimated) => `${reported} 次实报，${estimated} 次估算`,
  estimateUnavailable: "没有可估算的金额。",
  estimateUnknown: "未配置单价或输入/输出用量不足",
  estimateUnconfigured: "没有实报，模型也没配计费单价，所以没有估算。",
  estimateIncompleteUsage: "没有实报，用量也不全，所以没有估算。",
  missingUsage: (n) => `${n} 次调用端点没给用量`,
  missingAmount: (n) => `${n} 次调用没有金额`,
  categories: "调用类别",
  expand: "展开细分",
  collapse: "收起细分",
  category: { turn: "轮次", judgement: "判断", decision: "决策路由", feedback: "反馈路由", other: "其他" },
  kind: {
    turn: "轮次补全",
    judgement: "判断",
    route_pick: "选路",
    route_review: "复盘",
    route_learn: "学习跳",
    composer_suggest: "输入建议",
  },
  trend: "按日趋势",
  metricTokens: "Token",
  metricMoney: "金额",
  reportedStack: "实报",
  estimatedStack: "估算",
  dayAmount: (day, category, amount) => `${day} ${category} ${amount}`,
  dayTokens: (day, category, tokens) => `${day} ${category} ${tokens}`,
  dimension: "用量分布",
  dimensions: { model: "模型", session: "会话", bot: "Bot" },
  unrecordedModel: "未记录模型",
  unassignedBot: "未归属 Bot",
  deleted: "已删除",
  sortBy: (column) => `按${column}排序`,
  clearFilter: (label) => `清除${label}`,
  filters: "当前筛选",
  openSession: "打开会话",
  details: "调用明细",
  time: "时间",
  session: "会话",
  bot: "Bot",
  model: "模型",
  amount: "金额",
  loadMore: "载入更多调用",
  dash: "—",
};

const en: SpendCopy = {
  subtitle: "Usage and call costs",
  overview: "Overview",
  period: "Date range",
  refresh: "Refresh spend",
  refreshing: "Updating…",
  clearAll: "Clear all",
  usageDetails: "Token breakdown",
  coverage: "About amounts and usage",
  recordedCalls: (n) => `${n.toLocaleString('en-US')} calls`,
  coveredCalls: (n) => `${n.toLocaleString('en-US')} calls recorded`,
  breakdownHint: "Choose a row to explore its usage",
  distribution: "Usage breakdown",
  sort: "Sort",
  ascending: "Ascending",
  descending: "Descending",
  inspect: "View token breakdown",
  openTrigger: "View trigger message",
  detailHint: "Inspect the attribution, usage and amount of each call",
  loadedCalls: (n) => `${n.toLocaleString('en-US')} calls loaded`,
  loadingMore: "Loading more…",
  title: "Spend",
  open: "Spend",
  loading: "Loading spend…",
  error: "Spend could not be loaded.",
  retry: "Retry",
  empty: "No spend in this range.",
  emptyHint: "Try another date range or clear the active filters.",
  ranges: { today: "Today", last7: "Last 7 days", last30: "Last 30 days", all: "All", custom: "Custom" },
  from: "From",
  to: "To",
  rangeBlank: "Enter both a start and an end date.",
  rangeInvalid: "That date is not valid.",
  rangeReversed: "The end date cannot be earlier than the start date.",
  totals: "Totals",
  input: "Input",
  cached: "Cached",
  output: "Output",
  reasoning: "Reasoning",
  totalTokens: "Total tokens",
  calls: "Calls",
  reported: "Reported",
  estimated: "Estimated",
  estimatedHint: "The endpoint did not report an amount, so this is priced from the model. Reported and estimated stay separate.",
  estimateCoverage: (reported, estimated) => `${reported} reported, ${estimated} estimated`,
  estimateUnavailable: "No amount could be estimated.",
  estimateUnknown: "No billing rate is set, or the input and output usage is incomplete.",
  estimateUnconfigured: "Nothing was reported, and the model has no billing rate, so there is no estimate.",
  estimateIncompleteUsage: "Nothing was reported, and the usage is incomplete, so there is no estimate.",
  missingUsage: (n) => `${n} ${n === 1 ? "call" : "calls"} came back without usage`,
  missingAmount: (n) => `${n} ${n === 1 ? "call has" : "calls have"} no amount`,
  categories: "By category",
  expand: "Show kinds",
  collapse: "Hide kinds",
  category: { turn: "Turns", judgement: "Judgement", decision: "Decision routing", feedback: "Feedback routing", other: "Other" },
  kind: {
    turn: "Turn completion",
    judgement: "Judgement",
    route_pick: "Route pick",
    route_review: "Review",
    route_learn: "Learning hop",
    composer_suggest: "Composer suggestion",
  },
  trend: "Daily trend",
  metricTokens: "Tokens",
  metricMoney: "Amount",
  reportedStack: "Reported",
  estimatedStack: "Estimated",
  dayAmount: (day, category, amount) => `${day} ${category} ${amount}`,
  dayTokens: (day, category, tokens) => `${day} ${category} ${tokens}`,
  dimension: "Dimension",
  dimensions: { model: "Model", session: "Session", bot: "Bot" },
  unrecordedModel: "Unrecorded model",
  unassignedBot: "Unassigned bot",
  deleted: "Deleted",
  sortBy: (column) => `Sort by ${column}`,
  clearFilter: (label) => `Clear ${label}`,
  filters: "Filters",
  openSession: "Open session",
  details: "Call details",
  time: "Time",
  session: "Session",
  bot: "Bot",
  model: "Model",
  amount: "Amount",
  loadMore: "Load more calls",
  dash: "—",
};

export function spendCopyFor(locale: Locale): SpendCopy {
  return locale === "en" ? en : zh;
}
