/**
 * 读句 (ADR 0055): the two short tool-less calls that read a line for what the app acts on — one
 * for a line of yours, one for a Bot's. The prompts, the payload and the reading of the answer live
 * here; the engine side is `reader.ts`, what a reading is and how an answer is checked
 * `line-reading.ts`.
 *
 * Each prompt asks only what a fixed word list used to guess, says what does not count (a scene in
 * a script, a condition, a quote, praise beside a fault…), and asks for the line's own words where
 * the app quotes them back, so a reading can be checked against the line before anything acts on it.
 */
import { extractJsonObject } from "../route-agent";
import { checkBotReading, checkUserReading, type BotLineReading, type UserLineReading } from "../line-reading";
import { takeCodePoints } from "../text";

export const READ_USER_LINE_SYSTEM = `你在替一个多 Bot 协作应用读用户说的一句话，判断应用该怎么处理它。不是回答用户，也不能发言；没有工具。

输入是一个 JSON：said 是这句话；where 是 group（群）或 direct（和一个 Bot 的私聊）；replying_to 是它回复的那句（可能没有）；recent 是这句之前的几句（author 是 user 或 Bot 的名字）。

要判断四件事：

1. control：这句话是不是在要求 Bot 现在停下或继续手头的工作。
   - stop：叫停、暂停、打住、先别做了、别弄了、收手、停掉私聊里的活，或者指出它们还没停（「你私聊里的没停」）。
   - go_on：叫它们继续、恢复、接着做被停下的工作。
   - both：一句里两样都有（「今天先停，明天继续」「停了的接着做」）。
   - none：都不是。下面这些都是 none：剧本、台词、画面里的「停」（「角色停下脚步」「审片员：停」）；条件（「卡住了就停」）；问它停没停、能不能停；说已经发生的事（「渲染停了」「已恢复」）；对作品内容的要求（「别再用冻帧补时长」「继续保持这个画风」）；「恢复文件」这类别的意思的「恢复」。
2. control_only：control 不是 none 时，这句话是不是除了这个指令就没别的了（称呼、语气词、「麻烦」「赶紧」这类不算别的）。还带着新的要求、问题或别的内容（「停一下，先把第二集分镜改了」「继续做第二集」）就是 false。
3. status_only：这句话是不是只在问工作进行到哪了（「怎么样了」「进度呢」「做完了吗」「到哪一步了」），没有别的要求。带着要求、催促做某事、或问的是具体某个东西的细节，就是 false。
4. objections：这句话里对已经交出来的成果「现在这样」不满意的分句，原样摘自 said（不改写、不拼接，可以只摘一部分）。包括：指出毛病（太假、不对、穿帮、太短、跳帧、和要求对不上）、不满意、要求重做或从头再做、说之前的作废。不算：夸奖（「C07 很好」）；不用重做（「别重做了」「不用从头再做」）；条件（「如果太短就告诉我」）；说的是别的版本或别的时候（「上一版那个问题已经解决了」「下集别这么长」）；提问；客套（「有问题随时找我」）；只是提一个新要求而没说现在的成果哪里不好。没有就输出 []。

只输出一个 JSON 对象，不要 markdown 围栏，不要前言后语：
{"control": "none", "control_only": false, "status_only": false, "objections": []}`;

export const READ_BOT_LINE_SYSTEM = `你在替一个多 Bot 协作应用读一个 Bot 发出的一条消息，判断应用该怎么处理它。不是回答，也不能发言；没有工具。

输入是一个 JSON：said 是这条消息。

要判断四件事：

1. later：消息里说「这件事还在做 / 马上做 / 稍后给」的那一句，原样摘自 said（不改写、不拼接，可以只摘一部分）。例如「正在编写全新第 1 集设定集与剧本分镜方案」「结论随后」「接下来开始写分镜」「我将按照这个方案执行」「稍后发你」「I'm now drafting the outline」「results to follow」。不算：故事、剧本、画面里的人在做什么（「埼玉正在超市买菜」）；说别的 Bot 在做什么；说已经做完的事；只是问用户要不要做。没有就写 null。
2. claims_verified：消息是不是说自己跑过、测试过、验证过、构建过某样东西并且通过了（「测试全部通过」「已验证」「build succeeded」）。同时说了没验证、没跑的，是 false。
3. no_work：消息是不是只说「这一轮没有要做的 / 没什么要补充 / 不需要回复 / 已经回答过了」，此外什么内容都没有。
4. bare_status：消息是不是只有一句应答（「好的」「收到」）、一句完成的说法（「母带剪好了」「已完成，请查收」）、一句在等（「在等审片员」）或一句很短的「我看看」「马上弄」，除此之外没有任何实质内容。带着真正的内容（一段文字、一份清单、一个标题、具体结论）就是 false。

只输出一个 JSON 对象，不要 markdown 围栏，不要前言后语：
{"later": null, "claims_verified": false, "no_work": false, "bare_status": false}`;

/** As much of a line as a reading sends; past it the line is cut, and what matters is near the start or the end. */
export const READ_TEXT_MAX = 2000;
/** As much of each earlier line as a reading of yours sends. */
const RECENT_TEXT_MAX = 200;

function head(text: string, max: number): string {
  return takeCodePoints(text.replace(/\s+/g, " ").trim(), max).text;
}

/** A Bot's line, as much of it as is sent: its start and its end when it is long, since a promise closes a reply. */
function botText(text: string): string {
  const points = [...text];
  if (points.length <= READ_TEXT_MAX) return text;
  const half = Math.floor(READ_TEXT_MAX / 2);
  return `${points.slice(0, half).join("")}\n…\n${points.slice(points.length - half).join("")}`;
}

export type UserLinePayload = {
  said: string;
  where: "group" | "direct";
  replying_to?: { author: string; text: string };
  recent: Array<{ author: string; text: string }>;
};

export function userLinePayload(input: {
  body: string;
  where: "group" | "direct";
  replyingTo: { author: string; text: string } | null;
  recent: Array<{ author: string; text: string }>;
}): UserLinePayload {
  return {
    said: takeCodePoints(input.body, READ_TEXT_MAX).text,
    where: input.where,
    ...(input.replyingTo ? { replying_to: { author: input.replyingTo.author, text: head(input.replyingTo.text, RECENT_TEXT_MAX) } } : {}),
    recent: input.recent.map((line) => ({ author: line.author, text: head(line.text, RECENT_TEXT_MAX) })),
  };
}

export function botLinePayload(body: string): { said: string } {
  return { said: botText(body) };
}

/** The answer about a line of yours as a checked reading; null when it is not one. */
export function parseUserLineAnswer(raw: string, body: string): UserLineReading | null {
  const parsed = extractJsonObject(raw);
  return parsed ? checkUserReading(parsed, body) : null;
}

/** The answer about a Bot's line as a checked reading; null when it is not one. */
export function parseBotLineAnswer(raw: string, body: string): BotLineReading | null {
  const parsed = extractJsonObject(raw);
  return parsed ? checkBotReading(parsed, body) : null;
}
