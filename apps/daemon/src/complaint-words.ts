/**
 * Whether a line of yours complains about the work: a fixed list of words for something being
 * wrong with it (太假, 不对, 跳跃, 穿帮, 反了, 太短, 重做, 作废, 从头再做, 不行, 有问题, 错乱…), read with no
 * model. The ledger's fallback capture (store/scribe-patch.ts) uses it to keep a complaint about a
 * delivered job as a proposed entry when the scribe filed nothing for it; ADR 0040's rework rule
 * for a complaint about an approved part (P4e) is meant to read the same list.
 *
 * It errs towards catching: what it catches is only proposed, shown to you and never a gate, while
 * a complaint it misses is lost from the ledger if the scribe missed it too.
 */

const ZH = new RegExp(
  [
    "太假", "假的", "不真实", "不对", "不太对", "跳跃", "跳变", "跳帧", "穿帮", "穿模", "穿地", "反了", "颠倒", "镜像了",
    "太短", "太长", "短了", "偏短", "有点短", "好短", "长了", "偏长", "有点长", "好长", "太慢", "太快", "太暗", "太亮", "好假", "很假", "好丑", "很丑", "重做", "重来", "返工", "作废", "推翻", "推倒", "从头(?:再)?(?:做|来|开始|拍|写)", "再做一遍", "重新(?:做|来|拍|写|生成)", "不行", "不好(?!意思)", "有问题", "问题很大",
    "错乱", "错了", "搞错", "弄错", "不像", "难看", "变形", "畸形", "模糊", "糊了", "卡顿", "闪烁", "不连贯", "不一致",
    "对不上", "没按", "不符合", "不满意", "失败", "崩了", "糟糕", "差劲", "违和", "别扭", "奇怪", "不自然",
  ].join("|"),
);

const EN =
  /\b(?:wrong|broken|redo|re-do|fake|glitch(?:y|es)?|jumpy|jumps|mismatch(?:ed)?|blurry|flicker(?:s|ing)?|off-model|too (?:short|long|slow|fast|dark|bright)|(?:doesn'?t|does not|don'?t|do not) (?:match|work|look right)|not (?:right|good|what i asked)|looks? (?:off|bad|weird))\b/i;

export function soundsLikeComplaint(text: string): boolean {
  return ZH.test(text) || EN.test(text);
}

/**
 * Praise or a go-ahead. A bare 好 is not one: 「好假」「好短」 are complaints, so only the forms that
 * praise count; "不好", "不太好", "不满意" and the like are taken out first, so they never read as praise.
 */
const PRAISE = /很好|挺好|真好|太好了|好的|好看|好棒|好多了|可以|不错|棒|完美|满意|通过|没问题|赞|喜欢|就这样|👍|\b(?:ok(?:ay)?|nice|great|good|perfect|love|lgtm|approved?)\b/i;
const NOT_PRAISE = /不太?好|不够好|没那么好|不可以|不满意|不通过|不喜欢|not (?:good|great|ok(?:ay)?)/gi;

/** Whether a piece of what you said praises the work or lets it go ahead. */
export function soundsLikePraise(text: string): boolean {
  return PRAISE.test(text.replace(NOT_PRAISE, " "));
}

/** A redo turned down rather than asked for: 「别重做了」「不用改」「无需返工」「不用从头再做」. */
const DECLINED_REDO = /(?:别|不要|不用|无需|不必)再?(?:从头|重新|推翻|推倒|作废|重做|重来|返工|重剪|重渲|改|动)|\b(?:don'?t|no need to) (?:redo|re-do|change)/i;

/**
 * Not about the work as it stands now: a condition (「如果太短就告诉我」), another time or version
 * (「上次失败的那版」「下集别再这么长」), something already settled (「已经解决了」), an offer
 * (「有问题随时找我」), or saying nothing is wrong.
 */
const ELSEWHERE = /^(?:如果|要是|假如|万一|if\b)|已经?解决|解决了|下集|下次|以后|上次|上一版|之前那版|旧版|随时|nothing(?: is)? wrong|no (?:problem|issue)s?\b/i;

/**
 * Whether one clause of a line of yours objects to the work as it stands (§6.6): a complaint word,
 * with no praise in the same clause, no redo turned down, not a question, and not about another time,
 * version or condition (`ELSEWHERE`).
 */
export function clauseObjects(clause: string): boolean {
  const body = clause.trim();
  if (/[?？]$/.test(body)) return false;
  return soundsLikeComplaint(body) && !soundsLikePraise(body) && !DECLINED_REDO.test(body) && !ELSEWHERE.test(body);
}

/** A line cut into its clauses, each keeping a closing question mark: what a complaint word and a part's number have to share to go together. */
export function clausesOf(text: string): string[] {
  return (text.match(/[^，,。.;；！!？?\n]+[？?]?/g) ?? []).map((clause) => clause.trim()).filter(Boolean);
}

