/**
 * `isAnswerText` (ADR 0046): what `end_turn(done, answer)` may hand over as a ticket's words. The 24
 * samples below are lines a verbal hand-over used to approve tickets on, from a plain-text closing
 * reply alone — every one must still be refused. The length floor is 2 code points: an `answer`
 * hand-over always ends on your approve/reject card, so a short real deliverable reaching that card
 * is the actual safeguard, and the claim/ack/promise/question filters do the real work of keeping
 * Bots from spamming it with "好的".
 */
import { expect, test } from "bun:test";
import { isAnswerText } from "./submissions";

/** The review's 24 samples: acks, bare claims, promises and one question — none is the deliverable. */
const NOT_ANSWERS = [
  "好的，收到",
  "收到",
  "好的",
  "明白",
  "OK",
  "了解，我看看",
  "收到，正在处理",
  "已经在做了",
  "我先看一下素材",
  "做完了",
  "已完成",
  "任务完成，请查收",
  "母带已经剪好了",
  "母带剪好了，放在 assets 里",
  "我这边搞定了",
  "这个我做不了，没有素材",
  "等视频导演那边",
  "我会在十分钟内给你",
  "稍等，正在渲染",
  "正在渲染中，大约还要 5 分钟",
  "Done.",
  "Working on it.",
  "I'll get back to you",
] as const;

for (const line of NOT_ANSWERS) {
  test(`isAnswerText: ${JSON.stringify(line)} is not the deliverable`, () => {
    expect(isAnswerText(line)).toBe(false);
  });
}

test("isAnswerText: also refuses a question, a promise of more to come, and empty text", () => {
  expect(isAnswerText("三个选题要哪三个方向？")).toBe(false);
  expect(isAnswerText("三个选题，稍后发给你，我再核一遍")).toBe(false);
  expect(isAnswerText("")).toBe(false);
  expect(isAnswerText("   ")).toBe(false);
});

test("isAnswerText: accepts real short deliverables — a title, a line, a list, a short conclusion", () => {
  for (const answer of [
    "海边的灯塔",
    "让每一帧都值得被记住",
    "片名：《潮汐》",
    "选题：海、山、城",
    "三个选题：雪原上的孤灯、海底的旧城、云端的列车",
    "结论：方案 B 更好，成本低 30%，工期短一周。",
    // 等 and 看看 inside a title or a line are content, not a wait or a promise
    "片名：《等风来》",
    "看看这片海",
    "平等与自由",
  ]) {
    expect(isAnswerText(answer)).toBe(true);
  }
});

test("isAnswerText: accepts a real answer — a 3-point outline in Chinese", () => {
  const answer = "三个选题：一是海洋保护纪录片，聚焦珊瑚礁退化和渔业冲突；二是城市夜生活，记录年轻人深夜故事；三是乡村留守老人日常生活。";
  expect(isAnswerText(answer)).toBe(true);
});

test("isAnswerText: accepts a real answer — a paragraph of ad copy, in Chinese and in English", () => {
  const zh = "这支广告的文案：清晨六点，城市还没醒，第一缕光先照见你。我们的咖啡，陪你把这一天，过成自己想要的样子。限时上市，门店与线上同步开售。";
  const en = "Here is the ad copy: wake before the city does, and let the first light find you first. Our coffee keeps you company while the day becomes yours. Limited release, in stores and online now.";
  expect(isAnswerText(zh)).toBe(true);
  expect(isAnswerText(en)).toBe(true);
});

test("isAnswerText: a claim phrase embedded in a real answer does not disqualify it", () => {
  // "已经做完了" opens the line, but the rest is the actual deliverable, not padding around the claim.
  const answer = "已经做完了：母带时长 118 秒，字幕按要求配好，配乐用的是《潮汐》，已经导出为 EP01_MASTER.mp4，放在母带目录里，随时可以拿去审。";
  expect(isAnswerText(answer)).toBe(true);
});

test("isAnswerText: a padded ack may pass the filter — that is accepted, because it still lands on the approve/reject card", () => {
  // Long enough, and no single claim/ack/promise phrase dominates what is left over, so the filter
  // lets it through; the card — not this check — is what keeps it from approving on its own.
  const padded = "母带已经剪辑完毕并导出了，整体时长和节奏都符合你的要求，可以直接拿去使用了。";
  expect(isAnswerText(padded)).toBe(true);
});

test("isAnswerText: status lines of every kind are refused — looking, promising, waiting, claiming, in Chinese and English", () => {
  for (const line of [
    "看一下", "看看", "我去看看素材", "让我看看", "我看下", "我瞅瞅", "稍等，我看下", "我这就去剪", "马上就好", "快好了", "在弄了", "弄着呢", "还没好",
    "我研究一下", "我想想", "我查一下", "我核对一下", "好嘞", "嗯嗯", "行", "可以的，我来", "没问题，交给我", "OK，开始干", "收到收到", "明白，安排",
    "等我一下", "等素材到了再说", "我在等素材", "素材还在路上", "已提交", "已上传", "已发你", "发你了", "传好了", "渲染完了", "导出好了", "剪完了",
    "做好啦", "搞好了", "Done!", "All set.", "It's ready.", "Here you go.", "Waiting for the director.",
  ]) {
    expect({ line, answer: isAnswerText(line) }).toEqual({ line, answer: false });
  }
});

test("isAnswerText: 等, 看看, 完成, 我来 and waiting inside a real answer are content, not a status", () => {
  for (const line of [
    "等级：A", "等宽字体：JetBrains Mono", "等比缩放到 1080p", "完成度 80%", "可以", "不行，预算不够", "给你三个选题：海、山、城", "看看海",
    "先看海，再看山", "B 方案", "《等待戈多》", "等风来", "片名：等风来", "等风来——一部关于等待的短片", "我们等你回来", "建议片名：《在等》",
    "结论：先完成脚本，再做分镜", "Title: Waiting for the Tide", "我来自海边的小镇", "一直在路上", "安排三场发布会：北京、上海、深圳",
  ]) {
    expect({ line, answer: isAnswerText(line) }).toEqual({ line, answer: true });
  }
});
