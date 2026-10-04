/**
 * 读句 (ADR 0055): the short tool-less calls that read a line for what the app acts on — one for a
 * line of yours, one for a Bot's, and one for which job a line of yours is about (ADR 0057). The
 * prompts, the payloads and the reading of the answers live here; the engine side is `reader.ts`,
 * what a reading is and how an answer is checked `line-reading.ts`.
 *
 * Each prompt asks only what a fixed word list or rule used to guess, says what does not count (a
 * scene in a script, a condition, a quote, praise beside a fault, an opening word…), and asks for
 * the line's own words, or the refs it was shown, where the app acts on them, so a reading can be
 * checked before anything acts on it.
 */
import { extractJsonObject } from "../route-agent";
import {
  checkBotReading,
  checkFilingReading,
  checkUserReading,
  type BotLineReading,
  type FilingReading,
  type FilingRefs,
  type UserLineReading,
} from "../line-reading";
import type { LineToFile } from "../store";
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

要判断五件事：

1. later：消息里说「这件事还在做 / 马上做 / 稍后给」的那一句，原样摘自 said（不改写、不拼接，可以只摘一部分）。例如「正在编写全新第 1 集设定集与剧本分镜方案」「结论随后」「接下来开始写分镜」「我将按照这个方案执行」「稍后发你」「I'm now drafting the outline」「results to follow」。不算：故事、剧本、画面里的人在做什么（「埼玉正在超市买菜」）；说别的 Bot 在做什么；说已经做完的事；只是问用户要不要做。没有就写 null。
2. claims_verified：消息是不是说自己跑过、测试过、验证过、构建过某样东西并且通过了（「测试全部通过」「已验证」「build succeeded」）。同时说了没验证、没跑的，是 false。
3. no_work：消息是不是只说「这一轮没有要做的 / 没什么要补充 / 不需要回复 / 已经回答过了」，此外什么内容都没有。
4. bare_status：消息是不是只有一句应答（「好的」「收到」）、一句完成的说法（「母带剪好了」「已完成，请查收」）、一句在等（「在等审片员」）或一句很短的「我看看」「马上弄」，除此之外没有任何实质内容。带着真正的内容（一段文字、一份清单、一个标题、具体结论）就是 false。
5. go_ahead：消息是不是只在请用户点头，好接着做用户已经要它做的事：请用户确认、批准、过目做到一半的东西（「请确认关键帧板是否符合预期，确认后将正式启动视频生成」「方案没问题的话我就开始做」「要我继续吗」「可以开始剪辑了吗」）。不算（是 false）：要用户给只有用户有的东西（账号、密码、密钥、授权、只有用户知道的信息）；要用户在几个具体方案里选一个、而选哪个是用户的取舍（「横版还是竖版」「先做第 3 话还是第 5 话」）；指出做不下去的具体障碍；没有在问用户。

只输出一个 JSON 对象，不要 markdown 围栏，不要前言后语：
{"later": null, "claims_verified": false, "no_work": false, "bare_status": false, "go_ahead": false}`;

export const READ_FILING_SYSTEM = `你在替一个多 Bot 协作应用判断用户刚说的一句话是在说哪件事，好把它交给做那件事的 Bot。不是回答用户，也不能发言；没有工具。

输入是一个 JSON：
- said 是这句话；where 是 group（群）或 direct（用户和一个 Bot 的私聊）。
- before 是这句之前的几句，从早到晚：author 是 user 或 Bot 的名字，ago 是多久以前说的，job 是那一句归在哪件事（没归的不写）。
- jobs 是此刻可选的事：ref 是它的编号，title 是名字，goal 是目标，stage 是进行中或已交付（交了、等用户看），home 是它开在哪个会话（开在这里的不写），last_active 是多久以前有过动静，tickets 是它的任务（ref、title、state 状态、owner 谁在做、parts 它的分件），recent_files 是最近交出的文件，user_last_said 是用户最近对它说的一句。

回答 about：
- "jobs"：这句话在说 jobs 里的一件或几件——接着做、补充或改要求、指出问题、要求返工、问它的细节、回应 Bot 刚说的那件事。jobs 里每件写 {"job": "<ref>", "ticket": "<ref 或 null>", "parts": ["<key>"]}：明确落到其中某张任务时才写 ticket；明确说到其中几个分件（「第三镜」「C07」「片尾」）时才写 parts，用它列出的 key，只写这句话要求改、指出问题或问到的，只是夸一句的不写。拿不准就写 null 和 []。
- "new"：不是在说其中任何一件。要做一件新的事（哪怕别的事还开着，哪怕和某件是同一类：又一张海报、另一篇文章），或者和这些事都无关（问候、闲聊、问别的问题、一次性的小忙）。
- "unclear"：像是在说其中某件，但看不出是哪一件。

怎么判断：
- 看说的是什么、接在什么后面，不看措辞：「另外」「再」「顺便」开头的也可能是在改原来那件，「继续」也可能说的是另一件。
- 只开着一件事，不等于这句话就在说它。
- 紧接在 Bot 的一句之后说的，多半是在回应那一句（before 里它的 job）；内容明显是另一件新要求时仍是 new。
- 一件事目标之内的下一步（同一部片子的下一个镜头、同一份报告的下一节）算那件事；目标之外的新成果是 new。

只输出一个 JSON 对象，不要 markdown 围栏，不要前言后语：
{"about": "jobs", "jobs": [{"job": "J1", "ticket": null, "parts": []}]}`;

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

/** As much of a job's goal, or of what you last said about it, as a reading of where a line belongs sends. */
const JOB_TEXT_MAX = 300;

const TICKET_STAGE_WORDS: Record<string, string> = {
  todo: "待做", doing: "进行中", submitted: "已交付", in_review: "审查中", rework: "返工", approved: "已通过",
};

/** How long before `now` something happened, in words a reading reads at a glance. */
export function agoWords(at: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

export type FilingPayload = {
  said: string;
  where: "group" | "direct";
  before: Array<{ author: string; text: string; ago: string; job?: string }>;
  jobs: Array<{
    ref: string;
    title: string;
    goal?: string;
    stage: string;
    home?: string;
    last_active: string;
    tickets: Array<{ ref: string; title: string; state: string; owner?: string; parts?: Array<{ key: string; title: string }> }>;
    recent_files?: string[];
    user_last_said?: string;
  }>;
};

/**
 * What a reading of where a line belongs is sent, and the refs its answer names the jobs, tickets
 * and parts by: `J1`… for jobs, `T1`… for tickets across them, parts by their key. Times are said
 * relative to the line, so the reading sees how long ago the Bot's last line or a job's last move was.
 */
export function filingPayload(input: LineToFile): { payload: FilingPayload; refs: FilingRefs } {
  const now = Date.parse(input.at);
  const refs: FilingRefs = [];
  let tickets = 0;
  const jobs = input.jobs.map((job, index): FilingPayload["jobs"][number] => {
    const ref = `J${index + 1}`;
    const listed = job.tickets.map((ticket) => ({ ...ticket, ref: `T${++tickets}` }));
    refs.push({ ref, taskId: job.taskId, tickets: listed.map((ticket) => ({ ref: ticket.ref, ticketId: ticket.ticketId, parts: ticket.parts.map((part) => part.key) })) });
    return {
      ref,
      title: job.title,
      ...(job.goal && job.goal !== job.title ? { goal: head(job.goal, JOB_TEXT_MAX) } : {}),
      stage: job.stage === "delivered" ? "已交付" : "进行中",
      ...(job.home ? { home: job.home } : {}),
      last_active: agoWords(job.lastActivityAt, now),
      tickets: listed.map((ticket) => ({
        ref: ticket.ref,
        title: ticket.title,
        state: TICKET_STAGE_WORDS[ticket.stage] ?? ticket.stage,
        ...(ticket.owner ? { owner: ticket.owner } : {}),
        ...(ticket.parts.length > 0 ? { parts: ticket.parts } : {}),
      })),
      ...(job.recentArtifacts.length > 0 ? { recent_files: job.recentArtifacts } : {}),
      ...(job.lastUserQuote ? { user_last_said: head(job.lastUserQuote, JOB_TEXT_MAX) } : {}),
    };
  });
  const jobRef = new Map(refs.map((job) => [job.taskId, job.ref]));
  return {
    payload: {
      said: takeCodePoints(input.said, READ_TEXT_MAX).text,
      where: input.where,
      before: input.before.map((line) => {
        const job = line.taskId ? jobRef.get(line.taskId) : undefined;
        return { author: line.author, text: head(line.text, RECENT_TEXT_MAX), ago: agoWords(line.at, now), ...(job ? { job } : {}) };
      }),
      jobs,
    },
    refs,
  };
}

/** The answer about where a line of yours belongs as a checked reading; null when it is not one. */
export function parseFilingAnswer(raw: string, refs: FilingRefs): FilingReading | null {
  const parsed = extractJsonObject(raw);
  return parsed ? checkFilingReading(parsed, refs) : null;
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
