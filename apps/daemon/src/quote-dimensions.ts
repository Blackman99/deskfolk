/**
 * Numbers in your words (ADR 0040 P3): a running time, a resolution, an aspect ratio or a frame
 * rate, read by fixed rules, with no model and no store. The requirements ledger keeps what this
 * reads on each entry, so that a later line of yours giving the same thing a new number
 * («约 2 分钟» → «改成 3 分钟») is offered as a replacement for the old entry, and the same number
 * again only raises it. Only these four, because a number for one of them means the same whoever
 * reads it.
 *
 * The same readings are where the app's checks from your words start (`derived-checks.ts`), which
 * only ever proposes them: a wrong reading costs a wrong card, never a gate.
 *
 * Conservative on purpose. A phrase the rules do not know is no number at all ("两分多钟"), and a
 * line naming the same dimension twice ("C09 8 秒，总长 3 分钟") is read as both, which the ledger
 * takes as unclear. A number that is a moment or a place in the picture rather than a length
 * ("第 3 秒", "12 秒处", "前 3 秒", "logo 放在 3 秒"), a range ("3-5 分钟", "一两分钟"), a
 * deadline or a time budget ("请在 5 分钟内回复", "限你 3 分钟弄完"), how long something else
 * takes ("等 5 分钟", "渲染要 20 分钟", "3 分钟前"), a count of words ("2k 字") or of frames ("淡出
 * 24 帧"), a decade ("90s 港风"), a ratio with no word for a picture's shape near it or after a
 * score ("比分 2:1"), or something you said no to ("不要 4K", "不是 3 分钟") is no number either. A missed number only means you say it
 * again, or a person confirms the change instead.
 *
 * What this reads is a number, not yet a request: 「上一版 107 秒太短了」 reads as 107 seconds.
 * Whether a line states what the work should be is `derived-checks.ts`'s question.
 */

/** How the number is meant: 约 / 左右, 超过 / 以上, 不超过 / 以内, or exactly. */
export type Bound = "about" | "at_least" | "at_most" | "exact";

export type DimensionValue =
  | { dimension: "duration"; seconds: number; bound: Bound }
  /** Lines of the picture's short side: 1080p, 1920x1080 and 1080x1920 are all 1080. */
  | { dimension: "resolution"; lines: number; bound: Bound }
  /**
   * Width to height, in lowest terms ("16:9", "2.35:1"); or only which side is longer, when you
   * said 竖屏 / 横屏 and no ratio: "portrait" (taller than wide) or "landscape".
   */
  | { dimension: "aspect"; ratio: string }
  | { dimension: "fps"; fps: number; bound: Bound };

export type Dimension = DimensionValue["dimension"];

/** A reading and where its number stands in the line (NFKC-normalized, as `readDimensionSpans` reads it). */
export type DimensionSpan = { value: DimensionValue; start: number; end: number };

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_NUM = "[零〇一二两三四五六七八九十百]+";
const NUM = `(?:\\d+(?:\\.\\d+)?|${CN_NUM})`;

/** 一百零五, 二十五, 十二, 两; null for anything else, «一两» and «两三» (a guess, not a number) among them. */
function cnNumber(text: string): number | null {
  let total = 0;
  let current = 0;
  let previous = "";
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      // Two digits in a row are a range, but for the zero in 一百零五.
      if (previous in CN_DIGITS && CN_DIGITS[previous] !== 0) return null;
      current = CN_DIGITS[ch]!;
    } else if (ch === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (ch === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else return null;
    previous = ch;
  }
  return total + current;
}

function numberOf(text: string): number | null {
  if (text === "半") return 0.5;
  if (/^\d/.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  return cnNumber(text);
}

// Words before or after a number that say how it is meant. Longest first where one contains another.
// A no in front turns a bound over, and is tested first: 不要超过 / 别超过 / 不能长于 and "not more
// than" are at most, 不少于 / 不能少于 / 别短于 and "no less than" at least.
const NO = "(?:不要|不能|不可以|不可|不得|不许|不准|不应该|不应|不用|千万别|别|勿|莫|不)";
const ABOUT_BEFORE = /(?:大约|大概|差不多|将近|约莫|约|about|around|roughly|approximately|approx\.?|~|≈)\s*$/i;
const NO_MORE_BEFORE = new RegExp(
  `(?:${NO}\\s*(?:超过|超出|多于|长于|高于|大于)|(?:not|no)\\s+(?:more|longer|greater)(?:\\s+than)?|(?:not|never)\\s+(?:to\\s+)?exceed(?:ing)?|not\\s+over)\\s*$`,
  "i",
);
const NO_LESS_BEFORE = new RegExp(`(?:${NO}\\s*(?:少于|低于|短于|小于)|(?:not|no)\\s+(?:less|shorter|fewer)(?:\\s+than)?|not\\s+under)\\s*$`, "i");
// 至少要 2 分钟, 最多得 90 秒: the bound still holds across 要 / 得.
// 最低 1080p, 最短 60 秒, 下限 30 帧; 最长 90 秒, 上限 90 秒, 顶多 2 分钟, 不超 / 别超 3 分钟, max 90s.
const AT_LEAST_BEFORE = /(?:超过|超出|多于|长于|高于|大于|(?:至少|起码|最少|最短|最低|下限|起步)(?:也?(?:要|得|是))?|at least|more than|longer than|over|minimum|min\.?)\s*:?\s*$/i;
const AT_MOST_BEFORE = /(?:不到|少于|低于|短于|(?:最多|至多|最长|上限|顶多|不超(?!过)|别超(?!过))(?:也?(?:要|得|是))?|控制在|at most|less than|shorter than|within|under|up to|maximum|max\.?)\s*:?\s*$/i;
const ABOUT_AFTER = /^\s*(?:左右|上下|前后)/;
const AT_LEAST_AFTER = /^\s*(?:及以上|以上|打底|起步|起(?![来码])|or more|\+)/i;
const AT_MOST_AFTER = /^\s*(?:以内|之内|以下|内|or less|or under)/i;

function boundAround(text: string, start: number, end: number): Bound {
  // Wide enough for "should not exceed ", the longest word for a bound there is.
  const before = text.slice(Math.max(0, start - 24), start);
  const after = text.slice(end, end + 8);
  // A bound written after the number is the closer one: «超过约 2 分钟» is rare, «约 2 分钟以上» reads as at least.
  if (AT_LEAST_AFTER.test(after)) return "at_least";
  if (AT_MOST_AFTER.test(after)) return "at_most";
  if (ABOUT_AFTER.test(after)) return "about";
  if (NO_MORE_BEFORE.test(before)) return "at_most";
  if (NO_LESS_BEFORE.test(before)) return "at_least";
  if (AT_MOST_BEFORE.test(before)) return "at_most";
  if (AT_LEAST_BEFORE.test(before)) return "at_least";
  if (ABOUT_BEFORE.test(before)) return "about";
  return "exact";
}

type Span = { start: number; end: number };

// A moment, a stretch or a place in the picture, not a length: 第 3 秒, 从 3 秒, 播到 12 秒, 前 3
// 秒, 最后 5 秒, 挪到 3 秒, 卡在 3 秒. 改到 / 缩短到 / 压到 3 分钟 are lengths, so 到 alone is not here.
const MOMENT_BEFORE = /(?:第|从|(?:播|看|拖|快进|跳|挪|移|插|切)到|前面|后面|前|最后|开头|结尾|(?:卡|出现|插|切)在)\s*$/;
// 12 秒处, 3 秒时 (not 时长 or 时间), 12 秒左右的地方, 3 秒后, 3 秒开始.
const MOMENT_AFTER = /^\s*(?:左右|上下)?\s*(?:处(?!理)|时(?![长间])|那里|那儿|那块|的时候|的地方|的位置|位置|之后|以后|后(?!期)|开始|切到|切入|切换|进入|出现|亮出|引出|转到|揭晓|消失)/;
// A bare 在 is a moment or a place too (在 3 秒穿帮, logo 放在 3 秒, 字幕定在 5 秒, 压在 3 秒), unless a
// bound follows (最好在 90 秒以内, 压在 90 秒以内, 在两分钟左右), it follows a word for keeping a
// length (时长在, 控制在), or the clause names a running time before it (时长定在 90 秒).
const AT_BEFORE = /(?<!长|控制|保持|维持|限制|限定)在\s*$/;
const BOUND_AFTER = /^\s*(?:以内|之内|内|左右|上下|前后|以上|以下|及以上)/;
// 5 分钟内回复我: a time to answer in, not a length of the work.
const DEADLINE_AFTER = /^\s*(?:以内|之内|内)\s*(?:回复|回我|答复|完成|做完|做好|做出来|弄完|弄好|弄出来|搞完|搞定|搞出来|剪完|剪好|剪出来|给我|发我|交|出来|出结果)/;
// 3-5 分钟, 2 到 3 分钟, 2 or 3 minutes: the number read would be the top of a range, not a length
// asked for. After a Chinese numeral only when the number is one too (两到三分钟), so that 统一到 3
// 分钟 still reads.
const RANGE_BEFORE = /\d\s*(?:-|~|～|—|–|至|到|或者?|、|\/|or|to|and)\s*$/i;
const CN_RANGE_BEFORE = /[零〇一二两三四五六七八九十百]\s*(?:-|~|～|—|–|至|到|或者?|、)\s*$/;

// 不要 4K, 不是 3 分钟, 别做成竖屏, not in 4K: a number you said no to. A bound in between (不要超过
// 3 分钟) is a bound, not a no, and is read above. 能不能改成 90 秒 and 要不要 4K ask, not say no.
const SAID_NO_BEFORE =
  /(?:(?<!要)不要|(?<!用)不用|(?<!能)不能|(?<!是)不是|(?<!想)不想|(?<!需)不需要|不必|别|勿|禁止|避免|拒绝|没有|(?<![a-z])(?:don't|do not|not|no|avoid|never|without))\s*(?:再)?\s*(?:用|做成|做|搞成|弄成|改成|出成|出|是|要|成|use|make it|in|be|at|as)?\s*$/i;

// 不要剪成 90 秒, 千万别剪成 90 秒那种, 片长别压到 60 秒以下: a no before a word for setting the work
// to a number says no to that number, whatever bound follows.
const NO_SETTING_BEFORE =
  /(?:(?<!要)不要|(?<!能)不能|(?<!用)不用|不许|不准|别|千万别|勿|避免)\s*(?:再|给我|把[^，。,;；!?！？\n]{0,10})?\s*(?:剪|压|缩|改|调|做|弄|搞|砍|控制|出|拉|延|减|降|升)[^，。,;；!?！？\n\d]{0,3}$/;

/** Whether what comes right before `start` says no to it. */
function saidNo(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 16), start);
  return SAID_NO_BEFORE.test(before.slice(-12)) || NO_SETTING_BEFORE.test(before);
}

/**
 * Whether the number at `start`–`end` is a moment, a deadline or the end of a range rather than a
 * length; `cn` when the number is written in Chinese numerals.
 */
function notALength(text: string, start: number, end: number, cn = false): boolean {
  const before = text.slice(Math.max(0, start - 12), start);
  const after = text.slice(end, end + 8);
  if (MOMENT_BEFORE.test(before) || MOMENT_AFTER.test(after) || DEADLINE_AFTER.test(after)) return true;
  if (AT_BEFORE.test(before) && !BOUND_AFTER.test(after) && !RUNNING_TIME_BEFORE.test(before)) return true;
  return RANGE_BEFORE.test(before) || (cn && CN_RANGE_BEFORE.test(before));
}

// A number and its unit. 一个半小时 and 一小时半 are an hour and a half. A bare 分 or m is minutes
// only right before a number of seconds («1分30秒», «2m30s») or after a word for a running time
// («时长 3 分», «duration 3m»): alone, 分 is as often a score or 十分 ("very"), and m metres.
const DURATION_PART = new RegExp(
  `(${NUM}|半)\\s*(?:个\\s*)?(半\\s*(?:个\\s*)?(?:小时|钟头)|小时半|钟头半|小时|钟头|分钟|分半钟|分半|分(?![钟半])|秒钟|秒|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)(?![a-z])`,
  "gi",
);
const RUNNING_TIME_BEFORE = /(?:片长|时长|总长|全长|duration|runtime|running time|run time)[^，。,.;；!?！？\n]{0,6}$/i;
const SCORING = /打分|评分|分数|得分|给分|满分|几分|(?<![a-z])(?:score|scores|rating|rated)(?![a-z])/i;

// How long something else takes, not how long the work runs: 等 5 分钟, 渲染要 20 分钟, 每隔 10
// 分钟, 给我 5 分钟, 限你 3 分钟, 给你 10 分钟, 过了 3 分钟, 预计 30 分钟, 还要 10 分钟, 我开会大概 1
// 小时, wait 5 minutes, the
// render took about 3 hours, back in 10 minutes, reply within 5 minutes, ETA 30 minutes;
// after the number, 3 分钟前, 5 分钟再看, 10 分钟一次, 3 小时能渲染完, 10 分钟就回来, 半小时左右能好吗,
// 30 分钟出片, 20 分钟能看到, 10 分钟交给我, 5 minutes ago. 超过 and 不过 ("but") are not 过.
const TAKES_BEFORE = new RegExp(
  "(?:(?<![超不])过|等|等待|再等|隔|每隔|每|花|花了|用了|耗时|耗了|跑了|看了|听了|给我|给你|限你|限时|渲染|生成|导出|转码|下载|上传|处理|做完|做好|完成|搞定|" +
    "预计|估计|预估|还要|还得|还需|开会|开个会|出门|出去|吃饭|午休|休息|离开|任务|流程|工期|工作量)" +
    "(?:了|掉|个|要|需要|得|会|大概|大约|约|差不多|将近|最多|至少|上)*\\s*$" +
    "|(?<![a-z])(?:wait|waited|waiting|took|takes|taking|spent|spend|spending|every|after|give me|eta:?|(?:back|ready|done|finished|there) in|(?:reply|respond|answer|get back to me|report back) within)\\s+(?:(?:about|around|roughly|nearly|almost|like|another)\\s+)?$",
  "i",
);
const TAKES_AFTER =
  /^\s*(?:左右|上下)?\s*(?:前(?!后)|之前|以前|再(?:看|说|来|问|叫|找|试|提醒|汇报|回|决定|开始|继续|检查|确认)|一次|一趟|(?:就|才)?(?:能|可以)(?:好|看到|出|交|给|发)|(?:就|才)?(?:能|可以)?(?:渲染|生成|导出|转码|下载|上传|处理|完成|搞定|回来|回复|回你|回我|发你|发我|发给|发过来|出片|交片|交给|给我|到手|(?:做|剪|弄|搞|跑|传)(?:完|好|出来))|ago|later|from now|to (?:render|finish|export|generate|upload|download|process|run))/i;
// 给我 2 分钟左右的片子: the length of the piece asked for, whatever came before it.
const PIECE_AFTER = /^\s*(?:左右|上下)?\s*(?:长)?的\s*(?:片子|视频|短片|成片|影片|动画|宣传片|版本|母带|片)/;

/**
 * Right before a number, a word for setting the work to it: 改成 3 分钟, 剪成 90 秒, 做成竖屏,
 * 控制在 2 分钟以内, make it 2 minutes. What follows such a number is what to do with the cut
 * («剪成 90 秒发给我»), not how long something takes.
 */
export const TARGET_BEFORE =
  /(?:改成|改为|改到|剪成|剪到|缩到|缩短到|缩成|压到|压成|压缩到|延长到|加长到|拉长到|调成|调到|调整到|调整为|换成|做成|出成|定成|定为|设为|设成|控制在|保持在|限制在|限定在|维持在|(?<![a-z])(?:make it|cut it(?: down)? to|trim it(?: down)? to|change it to|bring it(?: down| up)? to|keep it(?: (?:under|within|below|at|to|around))?))\s*(?:约|大约|大概|差不多|在|about|around|roughly)?\s*$/i;

/** Whether the running time at `start`–`end` is how long something else takes (see `TAKES_BEFORE`). */
function takesTime(text: string, start: number, end: number): boolean {
  const after = text.slice(end, end + 10);
  if (PIECE_AFTER.test(after) || TARGET_BEFORE.test(text.slice(Math.max(0, start - 16), start))) return false;
  // Wide enough for "get back to me within about ".
  return TAKES_BEFORE.test(text.slice(Math.max(0, start - 28), start)) || TAKES_AFTER.test(after);
}

function unitSeconds(unit: string): { factor: number; extra: number } {
  const u = unit.toLowerCase();
  if (u.startsWith("半") || u === "小时半" || u === "钟头半") return { factor: 3600, extra: 1800 };
  if (u === "小时" || u === "钟头" || u.startsWith("h")) return { factor: 3600, extra: 0 };
  if (u === "分半钟" || u === "分半") return { factor: 60, extra: 30 };
  if (u === "分钟" || u === "分" || u === "m" || u.startsWith("min")) return { factor: 60, extra: 0 };
  return { factor: 1, extra: 0 };
}

// 90s 港风, 80s 复古, 90s 色调: a decade, not ninety seconds.
const DECADE_AFTER = /^\s*(?:的)?\s*(?:港|复古|风|色调|色彩|调色|年代|审美|感觉|那种|那样|日系|美式|欧美|怀旧|style|vibe|aesthetic|look|fashion|music|disco|retro)/i;

function readDurations(text: string, taken: readonly Span[]): DimensionSpan[] {
  type Part = Span & { seconds: number; factor: number; cn: boolean; bare: boolean };
  const parts: Part[] = [];
  for (const match of text.matchAll(DURATION_PART)) {
    const amount = numberOf(match[1]!);
    if (amount === null) continue;
    const start = match.index!;
    const end = start + match[0].length;
    if (taken.some((span) => start < span.end && span.start < end)) continue;
    if (match[2] === "s" && /^[1-9]0$/.test(match[1]!) && DECADE_AFTER.test(text.slice(end, end + 8))) continue;
    const { factor, extra } = unitSeconds(match[2]!);
    const bare = match[2] === "分" || match[2]!.toLowerCase() === "m";
    parts.push({ start, end, seconds: amount * factor + extra, factor, cn: !/^\d/.test(match[1]!), bare });
  }
  // «1 小时 20 分钟», «2 分钟 30 秒»: a smaller unit right after a larger one is one running time.
  const merged: Part[] = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (last && part.factor < last.factor && /^[\s零]*$/.test(text.slice(last.end, part.start))) {
      last.end = part.end;
      last.seconds += part.seconds;
      last.factor = part.factor;
      last.bare = false;
      continue;
    }
    merged.push({ ...part });
  }
  // 打分：时长 8 分，画面 7 分 — scores, not minutes: a scoring word, or more than one bare 分.
  const scores = SCORING.test(text) || merged.filter((part) => part.bare).length > 1;
  return merged
    .filter((part) => !part.bare || (!scores && RUNNING_TIME_BEFORE.test(text.slice(Math.max(0, part.start - 12), part.start))))
    .filter((part) => !notALength(text, part.start, part.end, part.cn) && !takesTime(text, part.start, part.end) && !saidNo(text, part.start))
    .map((part) => ({
      value: { dimension: "duration", seconds: part.seconds, bound: boundAround(text, part.start, part.end) },
      start: part.start,
      end: part.end,
    }));
}

const RESOLUTION_P = /(?<![\d.])(\d{3,4})\s*p(?![a-z])/gi;
// Not 2k 字 or 4k 块: a count of words or money.
const RESOLUTION_K = /(?<![\d.])([248])\s*k(?![a-z])(?!\s*(?:字|词|元|块|人|条|个|次|粉|行|words?|chars?|characters?|tokens?|rmb|yuan|usd))/gi;
const RESOLUTION_WXH = /(?<![\d.])(\d{3,4})\s*[x×*]\s*(\d{3,4})(?![\d.])/gi;
const K_LINES: Readonly<Record<string, number>> = { "2": 1440, "4": 2160, "8": 4320 };
const MONEY_OR_RATE = /预算|报价|稿费|费用|价格|价钱|多少钱|工资|码率|比特率|(?<![a-z])(?:budget|price|cost|fee|bitrate|bit rate|kbps)(?![a-z])/i;

function readResolutions(text: string, taken: Span[]): DimensionSpan[] {
  const out: DimensionSpan[] = [];
  const add = (start: number, end: number, lines: number): void => {
    if (lines < 240 || lines > 4320) return;
    taken.push({ start, end });
    if (!saidNo(text, start)) out.push({ value: { dimension: "resolution", lines, bound: boundAround(text, start, end) }, start, end });
  };
  for (const match of text.matchAll(RESOLUTION_WXH)) {
    add(match.index!, match.index! + match[0].length, Math.min(Number(match[1]), Number(match[2])));
  }
  for (const match of text.matchAll(RESOLUTION_P)) add(match.index!, match.index! + match[0].length, Number(match[1]));
  for (const match of text.matchAll(RESOLUTION_K)) {
    // 预算 2k, 报价压到 4k, 码率 8k: money or a bitrate, not a picture.
    const clause = text.slice(0, match.index!).split(/[，。,;；!?！？\n]/).at(-1) ?? "";
    if (MONEY_OR_RATE.test(clause)) continue;
    add(match.index!, match.index! + match[0].length, K_LINES[match[1]!]!);
  }
  return out;
}

/** The ratios a picture is actually made in; anything else with a colon is a time or a score. */
const KNOWN_RATIOS: ReadonlySet<string> = new Set([
  "16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "9:21", "3:2", "2:3", "4:5", "5:4", "2:1", "1:2",
  "2.35:1", "2.39:1", "2.4:1", "1.85:1",
]);
const ASPECT = /(?<![\d.:])(\d{1,2}(?:\.\d{1,2})?)\s*(?::|比)\s*(\d{1,2}(?:\.\d{1,2})?)(?![\d.:])/g;
/** «1:1 还原» is a faithful copy, not a square picture. */
const NOT_A_RATIO_AFTER = /^\s*(?:还原|复刻|复制|照搬|对应|copy|replica)/i;
// A ratio is a picture's only with a word for its shape in the line: 画幅 16:9, 9:16 竖屏, 比例
// 4:3, 2.35:1 宽银幕, aspect 16:9. Alone, 2:1 is as often a score.
const RATIO_CONTEXT = /画幅|比例|宽高比|画面比|屏|宽银幕|(?<![a-z])(?:aspect|ratio|widescreen)(?![a-z])/i;
// 比分 2:1, the score was 3:2: never a picture's shape.
const SCORE_BEFORE = /(?:比分|比数|得分|战绩|(?<![a-z])(?:score|scored|won|lost|beat)(?![a-z]))[^，。,;；!?！？\n]*$/i;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function readAspects(text: string, taken: Span[]): DimensionSpan[] {
  const out: DimensionSpan[] = [];
  for (const match of text.matchAll(ASPECT)) {
    const end = match.index! + match[0].length;
    if (NOT_A_RATIO_AFTER.test(text.slice(end, end + 6))) continue;
    const [w, h] = [match[1]!, match[2]!];
    let ratio = `${w}:${h}`;
    if (!w.includes(".") && !h.includes(".")) {
      const d = gcd(Number(w), Number(h)) || 1;
      ratio = `${Number(w) / d}:${Number(h) / d}`;
    }
    if (!KNOWN_RATIOS.has(ratio)) continue;
    taken.push({ start: match.index!, end });
    if (!RATIO_CONTEXT.test(text) || SCORE_BEFORE.test(text.slice(Math.max(0, match.index! - 24), match.index!))) continue;
    if (!saidNo(text, match.index!)) out.push({ value: { dimension: "aspect", ratio }, start: match.index!, end });
  }
  return out;
}

// 竖屏 / 横屏 and their English: which side of the picture is longer, when no ratio says more. In
// English only with a word that makes it the picture's shape ("portrait video", "in landscape"):
// alone, a portrait is a picture of someone. Not 横幅 / 竖幅, which are as often a banner.
const ORIENTATION =
  /(竖屏|竖版|竖构图|横屏|横版|横构图)|(?<![a-z])(?:(portrait|vertical|landscape|horizontal)(?:\s+|-)(?:video|format|version|cut|orientation|framing)|(?:in|as)\s+(portrait|landscape)(?![a-z])(?!\s+of))/gi;
// 手机竖屏看, 竖屏的时候字太小: how you watched it, not how it is made.
const VIEWING_BEFORE = /(?:手机|屏幕|设备|平板)\s*$/;
const VIEWING_AFTER = /^\s*(?:看|观看|预览|播放|播|浏览|刷|显示|模式|状态|的时候|时(?![长间])|上看|上播)/;

function readOrientations(text: string, taken: Span[]): DimensionSpan[] {
  const out: DimensionSpan[] = [];
  for (const match of text.matchAll(ORIENTATION)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (taken.some((span) => start < span.end && span.start < end)) continue;
    if (VIEWING_BEFORE.test(text.slice(Math.max(0, start - 4), start)) || VIEWING_AFTER.test(text.slice(end, end + 6))) continue;
    if (saidNo(text, start)) continue;
    const word = (match[1] ?? match[2] ?? match[3]!).toLowerCase();
    taken.push({ start, end });
    out.push({ value: { dimension: "aspect", ratio: /^(?:竖|portrait|vertical)/.test(word) ? "portrait" : "landscape" }, start, end });
  }
  return out;
}

/** 24p alone could be anything; only the rates a picture runs at read as one. */
const COMMON_RATES: ReadonlySet<number> = new Set([12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120]);
const FPS_UNIT = /(?<![\d.])(\d{1,3}(?:\.\d{1,3})?)\s*(?:fps|frames? per second|帧每秒|帧\/秒|帧\s*\/\s*s)(?![a-z])/gi;
// 每秒 24 帧: a rate. A bare 24 帧 is a count of frames (淡出 24 帧, 多了 12 帧) and no rate at all.
const FPS_PER_SECOND = /每秒\s*(?:钟\s*)?(\d{1,3}(?:\.\d{1,3})?)\s*帧/g;
// 帧率约 30, 帧率至少 24: the bound between the word and the number is read at the number.
const FPS_AFTER_WORD = /帧率\s*(?:是|为|要|改成|改为|设为|设成|用|:)?\s*(?:大约|大概|约|至少|最少|不低于|不少于|最多|不超过|不高于)?\s*(\d{1,3}(?:\.\d{1,3})?)/g;
const FPS_BARE = /(?<![\d.])(\d{2,3}(?:\.\d{1,3})?)\s*p(?![a-z])/gi;

function readRates(text: string, taken: Span[]): DimensionSpan[] {
  const out: DimensionSpan[] = [];
  const seen: Span[] = [];
  const add = (start: number, end: number, fps: number, common: boolean, numberAt = start): void => {
    if (!(fps > 0) || fps > 240 || (common && !COMMON_RATES.has(fps))) return;
    if (seen.some((span) => start < span.end && span.start < end)) return;
    seen.push({ start, end });
    taken.push({ start, end });
    // Placed at the number: in 帧率改成 30 what comes before it is 帧率改成.
    if (!saidNo(text, start)) out.push({ value: { dimension: "fps", fps, bound: boundAround(text, numberAt, end) }, start: numberAt, end });
  };
  for (const match of text.matchAll(FPS_UNIT)) add(match.index!, match.index! + match[0].length, Number(match[1]), false);
  for (const match of text.matchAll(FPS_AFTER_WORD)) {
    const end = match.index! + match[0].length;
    add(match.index!, end, Number(match[1]), false, end - match[1]!.length);
  }
  for (const match of text.matchAll(FPS_PER_SECOND)) {
    const end = match.index! + match[0].length;
    add(match.index!, end, Number(match[1]), false, match.index! + match[0].indexOf(match[1]!));
  }
  for (const match of text.matchAll(FPS_BARE)) {
    const end = match.index! + match[0].length;
    if (!notALength(text, match.index!, end)) add(match.index!, end, Number(match[1]), true);
  }
  return out;
}

/**
 * Every number for one of the four dimensions in `text`, in the order the dimensions are listed
 * above and, within one, as written. Full-width digits and colons read as their ASCII selves.
 */
export function readDimensions(text: string): DimensionValue[] {
  return readDimensionSpans(text).map((span) => span.value);
}

/**
 * {@link readDimensions}, each reading with where its number stands in `text.normalize("NFKC")`
 * (which is `text` itself when it is normalized already): for telling what the words around a
 * number make of it.
 */
export function readDimensionSpans(text: string): DimensionSpan[] {
  const normalized = text.normalize("NFKC");
  const taken: Span[] = [];
  // A resolution, a ratio or a rate claims its digits first, so none of them is also read as a
  // running time.
  const resolutions = readResolutions(normalized, taken);
  const aspects = readAspects(normalized, taken);
  // 竖版 1080×1920 and 9:16 竖屏 already say more than which side is longer.
  const shapeSaid = aspects.length > 0 || [...normalized.matchAll(RESOLUTION_WXH)].length > 0;
  const orientations = shapeSaid ? [] : readOrientations(normalized, taken);
  const rates = readRates(normalized, taken);
  return [...readDurations(normalized, taken), ...resolutions, ...aspects, ...orientations, ...rates];
}

/** The value a requirement keeps beside its dimension: everything but the dimension's name. */
export function dimensionValueJson(value: DimensionValue): Record<string, unknown> {
  const { dimension: _dimension, ...rest } = value;
  return rest;
}

/** Whether two readings say the same thing: the same dimension, number and bound. */
export function sameDimensionValue(a: DimensionValue, b: DimensionValue): boolean {
  return a.dimension === b.dimension && JSON.stringify(dimensionValueJson(a)) === JSON.stringify(dimensionValueJson(b));
}
