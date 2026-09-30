/**
 * Whether a line of yours complains about the work: a fixed list of words for something being
 * wrong with it (太假, 不对, 跳跃, 穿帮, 反了, 太短, 重做, 不行, 有问题, 错乱…), read with no
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
    "太短", "太长", "短了", "偏短", "有点短", "长了", "偏长", "有点长", "太慢", "太快", "太暗", "太亮", "重做", "重来", "返工", "不行", "不好(?!意思)", "有问题", "问题很大",
    "错乱", "错了", "搞错", "弄错", "不像", "难看", "变形", "畸形", "模糊", "糊了", "卡顿", "闪烁", "不连贯", "不一致",
    "对不上", "没按", "不符合", "不满意", "失败", "崩了", "糟糕", "差劲", "违和", "别扭", "奇怪", "不自然",
  ].join("|"),
);

const EN =
  /\b(?:wrong|broken|redo|re-do|fake|glitch(?:y|es)?|jumpy|jumps|mismatch(?:ed)?|blurry|flicker(?:s|ing)?|off-model|too (?:short|long|slow|fast|dark|bright)|(?:doesn'?t|does not|don'?t|do not) (?:match|work|look right)|not (?:right|good|what i asked)|looks? (?:off|bad|weird))\b/i;

export function soundsLikeComplaint(text: string): boolean {
  return ZH.test(text) || EN.test(text);
}
