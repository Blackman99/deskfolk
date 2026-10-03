/**
 * A bare status: a line that is nothing more than an acknowledgement, a claim of being done, a wait
 * or a short promise, however it is dressed up — the word lists' reading of it. A model reads it
 * first (`line-reading.ts`, ADR 0055); these lists are what the app goes by when no model can.
 */

/** A bare acknowledgement, in Chinese or English — never a hand-over by itself, however short or long. */
const ACK_SIGNAL = "好的|好嘞|嗯+|收到|明白|了解|知道了|没问题|^(?:行|好)[。！!~～]*$"
  + "|\\bok(?:ay)?\\b|\\bsure\\b|\\balright\\b|\\bgot it\\b|\\bunderstood\\b|\\bnoted\\b";

/**
 * Chinese/English fragments that only ever report status — done, mid-progress, can't do it — never
 * the deliverable itself ("母带剪好了" is not a master cut). `完成` needs no 已/已经 prefix ("任务完成，
 * 请查收" is as bare a claim as "已完成"), but 完成度 / 完成率 are content.
 */
const CLAIM_SIGNAL =
  "做完了|剪完了|弄完了|渲染完了|导出好了|传好了|剪好了|弄好了|办好了|处理好了|做好[了啦]|搞好了|搞定了?|(?:已经?)?完成(?![度率稿])"
  + "|已经?(?:提交|上传|发你)|发你了|正在做|在做(?:着)?|在弄了?|弄着呢|还没好|快好了|马上就?好|做不了|弄不了|搞不了"
  + "|\\bdone\\b|\\bfinished\\b|\\bcompleted\\b|\\bworking on (?:it|this)\\b|\\ball set\\b|\\bit'?s ready\\b|\\bhere you go\\b|\\bon it\\b";

/**
 * Waiting on someone or something. 等 inside a title or a line is content (「等风来」「等级：A」
 * 「《等待戈多》」「我们等你回来」): it reads as a wait only after 在/还在/正在, or opening a clause and
 * naming what it waits for within the clause.
 */
const WAIT_SIGNAL =
  "(?:还在|正在|在)等(?![》」”\"'])[^，。！？.!?：:—《》]{0,20}|稍等|等我一下|还在路上"
  + "|(?:^|[\\s，,。.!！；;])等[^，。！？.!?：:—《》]{0,20}?(?:那边|回复|回音|确认|审|结果|通知|反馈|处理|跑完|生成|出来|到了|一下|下载|上传|好了|完了)"
  + "|(?:^|\\b(?:i'?m|we'?re|still|am|are)\\s+)waiting\\b(?:\\s+(?:for|on)\\s+[^.!?]*)?";

/** A short, concrete promise of something still to come, beyond `promisesLaterWork`'s own vocabulary (a time-boxed "I'll get it to you", "let me just look first"). */
const SHORT_PROMISE_SIGNAL = "[一二三四五六七八九十0-9]+\\s*分钟(?:内|后)|我先[^，。！？.!?]{0,8}(?:看|核|查|检|搞|弄|处理|跑)|先看一下|先看看"
  + "|(?:让我|我去|去)?看看(?=[^\\p{L}]|素材|$)|我看[看下]|我瞅瞅|我想想|我(?:研究|查|核对|确认)一下|^看一?下[。！!~～]*$|^看看[。！!~～]*$"
  + "|我这就去|这就去|开始干|(?:^|[，,。！!])(?:我来(?:吧|了)?|交给我吧?|安排(?:上|一下)?)[。！!~～]*$";

/** Padding that dresses a status line up without adding content: thanks, a file's location, "go check it yourself". */
const STATUS_FILLER = "请查收|请查阅|请验收|请过目|放在[^，。！？.!?]{0,20}(?:里|目录|文件夹|下)|给你|没有素材|没有(?:文件|资料|原始素材)";

const STATUS_SIGNAL = `${ACK_SIGNAL}|${CLAIM_SIGNAL}|${WAIT_SIGNAL}|${SHORT_PROMISE_SIGNAL}`;

/**
 * Whether `text` is nothing more than an ack, a claim or a short promise (however it is dressed up):
 * once those and their filler are stripped out, only a few stray characters are left. The card every
 * `answer`/`organizer` hand-over ends on regardless is the real safeguard, so this
 * only has to catch the common case — a Bot's reflexive "好的" or "母带剪好了" — not every way of
 * saying nothing; a long real answer that happens to open with "已经做完了" keeps the rest of its
 * content and so keeps a remainder well past the threshold.
 */
export function isBareStatus(text: string): boolean {
  if (!new RegExp(STATUS_SIGNAL, "iu").test(text)) return false;
  const remainder = text
    .replace(new RegExp(STATUS_SIGNAL, "giu"), " ")
    .replace(new RegExp(STATUS_FILLER, "giu"), " ")
    .replace(/[\s,，.。!！;；:：、'"“”‘’~～…—\-–`]+/g, " ")
    .trim();
  return [...remainder].length <= 8;
}
