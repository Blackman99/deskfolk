/**
 * Words a message uses when the work is still going: 「结论随后」, 「正在编写…」, 「接下来开始写分镜」,
 * "results to follow". A model reads a Bot's line for that first (ADR 0055, `reader.ts`); this list
 * is what the app goes by when no model can, and is not to be widened to fix a miss — a miss is the
 * reading's to fix. A match only means "check this reply too"; the closing check
 * (`closing-check.ts`) and the end contract (`store/end-contract.ts`) decide whether anything is
 * actually left hanging, so a storyboard line that happens to say 随后 costs nothing more than
 * that check. A work verb after 正在, or a start announced now, never 正在 alone — 「埼玉正在超市买
 * 菜」 is a scene, not a promise.
 */
const LATER_WORK = new RegExp(
  [
    "随后", "稍后", "稍候", "回头", "待会", "过会", "晚些", "晚点", "结论后补", "后续再", "马上(?:就)?(?:给|发|补|出)",
    "正在(?:逐|进行|核|检|审|处理|生成|渲染|排查|分析|比对|确认|整理|跑|编写|撰写|编排|起草|草拟|写|制作|准备|筹备|设计|绘制|搭建|规划|策划|调研|研究|梳理|修改|赶|着手|推进|执行)",
    "(?:这就|马上|立刻|立即|现在就?|接下来(?:就|我)?|下面(?:就|我)?)(?:去|开始|着手|动手)",
    "我(?:将|会)(?:先|立即|马上|开始|着手|按照?|继续|接着)",
    "\\b(?:to follow|shortly|in a (?:moment|bit|few minutes)|stay tuned)\\b",
    "\\bI(?:'ll| will) (?:follow up|get back|report back|post|share|send|start|begin)\\b",
    "\\bI'm (?:now )?(?:checking|reviewing|verifying|comparing|working on|drafting|writing|preparing|building|generating|rendering)\\b",
  ].join("|"),
  "i",
);

/** How much of a "still going" sentence is kept: what a bounce and your line quote. */
export const LATER_QUOTE_MAX = 60;

/** Whether a message says it is still working on something it has not handed over. */
export function promisesLaterWork(text: string): boolean {
  return LATER_WORK.test(text);
}

/** The sentence of `text` that says the work is still going, for quoting it back; null when none does. */
export function laterWorkSentence(text: string): string | null {
  const sentence = (text.match(/[^。.!！?？\n]+[。.!！?？]?/g) ?? []).find((part) => LATER_WORK.test(part));
  return sentence ? sentence.trim() : null;
}
