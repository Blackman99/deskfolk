/**
 * Checks from your words (ADR 0040 P3): a running time, a resolution, an aspect or a frame rate you
 * state for a job is offered as a check the app runs itself on the job's final deliverable, with
 * ffprobe, the way it runs every other check (ADR 0036). Read straight off your words by
 * `quote-dimensions.ts`, with no model in between.
 *
 * A number read from your words is only ever a proposal: a card in the conversation you confirm,
 * change or turn down. It becomes a gate when you confirm it, or when two separate lines of yours
 * state it as a target — the number set for the deliverable by the word for what it measures
 * (「片长约 2 分钟」) or by a word setting the work to it (「剪成 2 分钟」) — with nothing later
 * saying otherwise: the 「片长约 2 分钟」 you said twice is a check of 108–132 seconds, and a master
 * of 107 seconds fails it however sure a reviewing Bot is. Only a target statement counts toward
 * that, and only one moves a gate: a later, different target is offered as its replacement, and the
 * gate stands aside (`conflict`, no gate) until you choose. Any other reading (「片子差不多 107
 * 秒」) is at most a card. So a misread number costs a card.
 *
 * This file is the arithmetic: which of your words state a number for the work, the range each
 * allows (D15: 10% either way, 以上 / 以内 one end only), when two agree, which delivered file is
 * "the final deliverable", and the words the checks are shown in. The store keeps the checks and
 * their states (`store/derived-checks.ts`); ffprobe runs in `measure-check.ts`.
 *
 * What counts is kept narrow, since a missed number only means no card: a running time needs a
 * word for a bound (约, 左右, 以上, 以内, 至少, 不超过…), a word setting the work to it right before
 * it (剪成, 做成, 控制在, 改成…) or the word for what it measures in its clause (片长, 时长); a
 * resolution, a ratio (with a word for the picture's shape in the line), 竖屏 / 横屏 or a frame rate
 * (written as one: 帧率, fps, 每秒 N 帧) counts as said. A line that asks, wonders, complains,
 * tells how a cut came out (上一版, 这版, 现在, 之前, 交的, 只有, 了 after the number…), describes a
 * file on hand (拍的, 相机, ffprobe…), asks for another version (也做一版, 竖版, 抖音版…) or is about a still picture counts
 * nothing at all; a number about one part of the work (C09, 镜头, 开头, logo, 字幕, 抖音版…), in
 * an annotation or under a part's ticket counts for no dimension; a clause about the footage, a
 * reference or the music counts only a number set by a word, and never as a target.
 */
import type { CheckMeasure, Locale } from "@real-bot/protocol";
import { soundsLikeComplaint } from "./complaint-words";
import { readDimensionSpans, TARGET_BEFORE, type Dimension, type DimensionSpan, type DimensionValue } from "./quote-dimensions";

/** A number you gave is met within this much either way (D15), unless you said 以上 or 以内. */
export const DERIVED_TOLERANCE = 0.1;

/** A ratio is met within this much: 854×480 is 16:9, 1440×1080 is not. */
export const ASPECT_TOLERANCE = 0.01;

/** The dimensions a check from your words can measure, in the order they are listed. */
export const DERIVED_DIMENSIONS: readonly Dimension[] = ["duration", "resolution", "aspect", "fps"];

/**
 * Checks from your words a plan can hold at once: per dimension a gate and the replacement your
 * later words offer for it.
 */
export const DERIVED_CHECKS_MAX = DERIVED_DIMENSIONS.length * 2;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The range a reading allows. */
export function measureOf(reading: DimensionValue): CheckMeasure {
  if (reading.dimension === "aspect") return { dimension: "aspect", ratio: reading.ratio };
  const value = reading.dimension === "duration" ? reading.seconds : reading.dimension === "resolution" ? reading.lines : reading.fps;
  if (reading.bound === "at_least") return { dimension: reading.dimension, min: value, max: null };
  if (reading.bound === "at_most") return { dimension: reading.dimension, min: null, max: value };
  return { dimension: reading.dimension, min: round2(value * (1 - DERIVED_TOLERANCE)), max: round2(value * (1 + DERIVED_TOLERANCE)) };
}

/**
 * Whether two ranges ask the same thing: the same number with the same bound, as the ranges they
 * make are the same (「约 2 分钟」, 「2 分钟左右」 and 「片长 120 秒」 are; 「约 2 分钟」 and 「片长改成
 * 130 秒」 are not, though 130 falls in 108–132: it is you changing the number).
 */
export function sameAsk(a: CheckMeasure, b: CheckMeasure): boolean {
  if (a.dimension === "aspect" || b.dimension === "aspect") return a.dimension === "aspect" && b.dimension === "aspect" && a.ratio === b.ratio;
  return a.dimension === b.dimension && a.min === b.min && a.max === b.max;
}

// One part of the work, not the final deliverable: C09, 镜头, 第 3 段, 每段, 片头, 开头, logo, 字幕,
// 口播, 高潮, 场景, 第 2 集, shot, each. The checks are on the final deliverable, and 「C09 8 秒」 must
// not become a master of 8 s, nor 「logo 在 5 秒左右出现」 one of 5 s.
const PART_WORDS =
  /(?<![A-Za-z0-9])[A-Za-z]\d{1,3}(?!\d)|镜头|分镜|单镜|每镜|每个镜|每段|每一段|片段|第\s*[\d一二三四五六七八九十百]+\s*(?:镜|个镜头|段|场|幕|个|集|部分)|[\d一二三四五六七八九十百]+\s*(?:个镜头|镜(?!头))|片头|片尾|开场|开头|结尾|片花|预告|转场|过渡|字幕|口播|高潮|部分|场景|空镜|黑场|倒计时|前半段|后半段|(?:这|那|中间|前面|后面|最后)一?段|采访|访谈|每页|每张|每句|每行|每个场景|(?<![a-z])(?:logo|shots?|scenes?|clips?|segments?|each|per|intro|outro|opening|ending|credits|trailer|transition|subtitles?|captions?)(?![a-z])/i;
// A ticket that is the whole work, whatever else its title says.
const WHOLE_WORDS = /母带|成片|终版|定稿|master|final/i;

/** Whether a ticket's title names one part of the work (C09, 镜头 3) rather than the whole. */
export function partTicket(title: string): boolean {
  return PART_WORDS.test(title.normalize("NFKC")) && !WHOLE_WORDS.test(title);
}

export type QuoteForChecks = {
  id: string;
  body: string;
  via: "message" | "ask_answer" | "annotation" | "board";
  /**
   * What counts as one line of yours when the same number is said twice: the quote itself, or for
   * words typed on the board, the plan's fields together or one ticket's description (saving the
   * same field again is not saying it again).
   */
  source: string;
  /** When you said it (the quote's `created_at`): what "later" means between two of your lines. */
  at: string;
  /** The ticket it was filed under, when that ticket names one part of the work (`partTicket`). */
  aboutPart: boolean;
};

/**
 * One line of yours stating a number for one dimension of the work. `target`: the number is set for
 * the deliverable, by the word for what it measures in its clause (片长, 分辨率, 帧率, 画幅…) or by a
 * word setting the work to it right before it (剪成, 做成, 改成, 控制在…), outside any clause about
 * the footage or a reference. Only a target counts toward "said twice" and only one moves a gate.
 */
export type Statement = { quoteId: string; at: string; source: string; target: boolean; reading: DimensionValue; measure: CheckMeasure };

// Where a clause ends: a comma, a stop, a question or exclamation mark, a new line; a point only
// when no digit follows it, so 2.35:1 and 29.97 stay whole.
const CLAUSE_BREAK = /[，。,;；!?！？\n]|\.(?!\d)/g;

// A line that asks or wonders rather than says: 能不能改成 90 秒？, 片长是 2 分钟吗, 如果改成 60 帧,
// 会不会更好, can you make it 90 seconds, would it be better at 60 fps.
const ASKS =
  /[?？]|吗|(?:可以|行|好|对|是)么|呢\s*$|能不能|能否|可不可以|可否|要不要|是不是|会不会|行不行|好不好|行不|好不|怎么样|怎样|如何|你看|你觉得|觉得|试试|多久|多长时间|什么时候|啥时候|如果|要是|假如|假设|万一|的话|或许|也许|可能|说不定|(?<![a-z])(?:if|maybe|perhaps|might|would|whether|unless|(?:can|could|will|should) (?:you|we|it|i))(?![a-z])/i;
// A line telling how a cut came out, or pointing at one already made: 上一版, 这版, 这次, 第一版,
// 现在, 之前, 原来, 你交的, 收到的, 只有 107 秒, 才 90 秒, 已经, 实际, 量出来, 显示, 太卡, 为什么, 怎么剪成…,
// it was, it's, now, you cut it to; a clause that only appraises it (「，可以」「，还行」). The
// complaint words (complaint-words.ts) besides.
const A_CUT_MADE =
  /上一?版|上个版本|这一?版|这个版本|那一?版|旧版|前一版|第\s*[\d一二三四五六七八九十]+\s*版|刚才那|刚刚那|之前|原来|这次|交的|收到的|现在|目前|当前|实际|已经|只有|只剩|仅有|才(?=\s*[\d零〇一二两三四五六七八九十百半])|量出来|测出来|出来(?:的|是|只)|显示|比要求|比说好|粗剪|初剪|完整版|[一-龥]{0,4}剪辑版|太卡|太糊|不够|为什么|为啥|怎么(?!样)|咋|(?:^|[，,。；;])\s*(?:看了\s*[，,]?\s*)?(?:可以|还行|行|挺好|不错|没问题|ok)(?:的|了|吧|啊)?\s*(?=[，,。；;!！]|$)|(?<![a-z])(?:only|already|actually|currently|current|now|it's|it’s|it is|was|were|came out|comes out|measured|measures|choppy|laggy|stutter(?:s|y|ing)?|why|how come|the last (?:cut|version|one)|previous (?:cut|version)|this (?:cut|version)|you(?:'ve|’ve| have| had)? (?:cut|made|rendered|exported|trimmed|edited|delivered))(?![a-z])/i;
// A line describing a file already on hand, the footage shot or a probe of a cut: 我拍的是 4K, 相机是
// 60 帧, 客户给的都是 4K, 4K 显示器, ffprobe 显示…, Stream #0:0: Video… Its numbers are that file's.
const ON_HAND = /拍的|拍摄|相机|(?:客户|我|他|她|他们|对方)给(?:你|我)?的|显示器|ffprobe|mediainfo|stream\s*#\d|(?<![a-z])video:\s*h\.?26[45]/i;
// Right after a number, 了: 剪成 107 秒了, 做成竖屏了, 差不多 2 分钟了 say where a cut got to.
const DONE_AFTER = /^\s*(?:左右|上下|以内|之内|以上|以下)?\s*了/;
// Another version beside the main one: 横屏的也做一版, 另出一个 30 秒的, 再做一个 15 秒的, 竖版的也要,
// 抖音版 30 秒左右, a landscape version too. What it asks is not asked of the final cut, wherever
// in the line the version is named.
const ANOTHER_VERSION =
  /竖版|横版|方版|横屏版|竖屏版|抖音版|快手版|视频号版|小红书版|精简版|短版|加长版|英文版|也(?:做|出|剪|来|弄|搞|拍|要)\s*(?:一版|一个版本|一份|一条|一支|一个)|另(?:做|出|剪|拍|弄|来)\s*(?:一|个)|另一(?:版|个版本)|多(?:做|出|剪)一|单独(?:做|出|剪)|再(?:做|剪|出|来|拍|弄)\s*(?:一|个)|(?<![a-z])(?:(?:version|cut|edit)s?\s+(?:too|as well)|another\s+(?:[^,.;!?\n]{0,20}\s)?(?:video|film|clip|version|cut)|also\s+(?:make|do|cut|render|export|deliver|produce|create)\s+(?:a|an|one))(?![a-z])/i;
// A complaint word said no to is something asked, not a complaint: 不能穿帮, 别让画面太暗, 镜头之间不能
// 跳变, don't make it too dark. A brief says these as often as a complaint says them plain.
const SAID_NO_TO = /(?:不要|不能|不许|不准|不可以|不得|不应|千万别|别(?!扭)|避免|防止)[^，。,.;；!?！？\n]{0,6}|(?<![a-z])(?:don'?t|do not|never|avoid|no)\s[^,.;!?\n]{0,20}/gi;
// A clause about something other than the piece: the footage, a reference, a sample, the sound
// (素材 20 分钟, 参考那个 3 分钟的, 4K 的素材, 配乐 3 分钟). Its numbers count only when a word sets the
// work to them («把素材剪成 90 秒»), and then only as a card, never as a target.
const ELSEWHERE =
  /素材|参考|原片|原视频|样片|片源|源文件|源视频|音乐|配乐|歌|音频|配音|旁白|像[^，。,;；!?！？\n]{0,16}(?:那样|一样|那种)|类似|同款|(?<![a-z])(?:reference|source|footage|raw|sample|bgm|music|song|audio|soundtrack|voice-?over|narration)(?![a-z])/i;
// A line about a still picture, not the video: 一张照片，1080p; 封面做成 16:9; 壁纸做成 9:16; 手机界面做成竖屏.
const A_PICTURE = /照片|图片|海报|封面|缩略图|头像|截图|配图|预览图|效果图|示意图|长图|壁纸|动图|界面|(?<![a-z])(?:kv|banner|gif|ppt|photo|image|poster|thumbnail|cover|screenshot|wallpaper)s?(?![a-z])/i;
// Words for the whole work, which make a clause the film's whatever an earlier clause named: 片长,
// 总长, 成片, 整片, the film.
const WHOLE_WORK = /片长|总长|全长|成片|全片|整片|整支|(?<![a-z])(?:the (?:film|video|whole cut)|total length)(?![a-z])/i;
// Earlier in the clause, the word for what the number measures of the deliverable: 片长 2 分钟,
// 成片时长 90 秒, 分辨率 1080p, 帧率 30, 画幅 16:9, duration 3m, aspect ratio 9:16. For a running time
// it is what lets a bare number count at all; for every dimension it is what makes a number a target.
const DIMENSION_WORDS: Readonly<Record<Dimension, RegExp>> = {
  duration: /片长|时长|总长|全长|长度|(?<![a-z])(?:running time|run ?time|duration|length)(?![a-z])/i,
  resolution: /分辨率|(?<![a-z])resolution(?![a-z])/i,
  fps: /帧率|(?<![a-z])frame ?rate(?![a-z])/i,
  aspect: /画幅|比例|宽高比|画面比|(?<![a-z])aspect(?: ratio)?(?![a-z])/i,
};

/** Where the clause holding `at` starts and ends in `text`. */
function clauseAround(text: string, at: number): { start: number; end: number } {
  let start = 0;
  for (const match of text.matchAll(CLAUSE_BREAK)) {
    if (match.index! >= at) return { start, end: match.index! };
    start = match.index! + match[0].length;
  }
  return { start, end: text.length };
}

/**
 * Whether the number at `start` is about one part of the work: a part named in its own clause
 * (「开头控制在 5 秒以内」「C09 做成竖屏」), or in an earlier clause unless its own names the whole
 * work (「C09 这个镜头，时长 8 秒」 is the shot's; 「加中英字幕，片长约 2 分钟」 is the film's). A part
 * said no to (「不要额外加片头」) names none.
 */
function aboutAPart(text: string, start: number): boolean {
  const clause = clauseAround(text, start);
  if (PART_WORDS.test(text.slice(clause.start, clause.end).replace(SAID_NO_TO, " "))) return true;
  return PART_WORDS.test(text.slice(0, clause.start).replace(SAID_NO_TO, " ")) && !WHOLE_WORK.test(text.slice(clause.start, start));
}

// Right after a number, a word for changing it to another one (帧率 24 改成 60, 画幅 16:9 → 竖屏), or
// another choice beside it (帧率 24 或 30): the number is what it was, or one of two, not what you
// ask. Right before it, 从 (分辨率从 4K 降到 1080). What follows the change word is read as usual.
const CHANGED_FROM_AFTER = /^\s*(?:改成|改为|改到|改|换成|换到|换|降到|降为|降|升到|升为|提到|提高到|压到|砍到|缩到|变成|调成|调到|调整为|→|->|=>|到|(?:或者?|\/|or)\s*\d)/i;
const CHANGED_FROM_BEFORE = /从\s*$/;

/** A number of a line with whether it is a target (see {@link Statement}). */
export type StatedSpan = DimensionSpan & { target: boolean };

/**
 * Of the numbers in a line (NFKC-normalized), those it states for the work, each marked a target
 * or not (see the top of this file). Whatever is left says nothing, and makes no card.
 */
export function statedOfTheWork(text: string): StatedSpan[] {
  const spans = readDimensionSpans(text);
  if (spans.length === 0) return [];
  const plain = text.replace(SAID_NO_TO, " ");
  if (ASKS.test(text) || soundsLikeComplaint(plain) || A_CUT_MADE.test(plain) || ON_HAND.test(text) || ANOTHER_VERSION.test(text) || A_PICTURE.test(text)) return [];
  if (spans.some((span) => DONE_AFTER.test(text.slice(span.end, clauseAround(text, span.end).end)))) return [];
  return spans.flatMap((span): StatedSpan[] => {
    const { value, start, end } = span;
    if (aboutAPart(text, start)) return [];
    if (CHANGED_FROM_AFTER.test(text.slice(end, end + 6)) || CHANGED_FROM_BEFORE.test(text.slice(Math.max(0, start - 4), start))) return [];
    const clause = clauseAround(text, start);
    const before = text.slice(clause.start, start);
    const set = TARGET_BEFORE.test(before);
    // The footage or a reference named in its clause, or in an earlier one unless its own names the
    // whole work (「用那首歌，时长 3 分 20 秒」 is the song's).
    const elsewhere = ELSEWHERE.test(text.slice(clause.start, clause.end)) || (ELSEWHERE.test(text.slice(0, clause.start)) && !WHOLE_WORK.test(before));
    if (elsewhere && !set) return [];
    const named = DIMENSION_WORDS[value.dimension].test(before);
    if (value.dimension === "duration" && !set && value.bound === "exact" && !named) return [];
    return [{ ...span, target: !elsewhere && (named || set) }];
  });
}

/**
 * What your words about a job state for its final deliverable: per dimension, each line that
 * states one number for it (`statedOfTheWork`), oldest first as in `quotes`. A line stating two
 * different numbers for one dimension says nothing clear about it and is passed over; one stating
 * the same number twice is one statement, a target when either says it as one. Nothing is taken
 * from a line filed under a part's ticket or from an annotation (said at one spot of one delivery).
 */
export function derivedStatements(quotes: readonly QuoteForChecks[]): Map<Dimension, Statement[]> {
  const out = new Map<Dimension, Statement[]>();
  for (const quote of quotes) {
    const text = quote.body.normalize("NFKC");
    if (quote.via === "annotation" || quote.aboutPart) continue;
    const byDimension = new Map<Dimension, StatedSpan[]>();
    for (const span of statedOfTheWork(text)) byDimension.set(span.value.dimension, [...(byDimension.get(span.value.dimension) ?? []), span]);
    for (const [dimension, spans] of byDimension) {
      const measures = spans.map((span) => measureOf(span.value));
      if (measures.some((measure) => !sameAsk(measure, measures[0]!))) continue;
      const statement: Statement = {
        quoteId: quote.id,
        at: quote.at,
        source: quote.source,
        target: spans.some((span) => span.target),
        reading: spans[0]!.value,
        measure: measures[0]!,
      };
      out.set(dimension, [...(out.get(dimension) ?? []), statement]);
    }
  }
  return out;
}

const VIDEO = /\.(?:mp4|mov|m4v|mkv|webm|avi)$/i;

// In a file's name, a word for one part of the work, another version or format of it, or a draft:
// C09, s03, shot, scene, clip (v2, r2 and E01 are a version, a revision, an episode); 9x16, 30s,
// vertical, douyin, teaser, trailer, intro, OP, ED, logo, sting, preview, proxy, 720p.
const NOT_THE_FILM_TOKEN =
  /^(?:(?![vVrReE])[A-Za-z]\d{1,3}|(?:shot|scene|clip|seg|segment|part)s?\d*|\d+x\d+|\d+s|(?:720|540|480|360|240)p|vertical|horizontal|square|portrait|landscape|douyin|tiktok|kuaishou|reels?|shorts?|teaser|trailer|intro|outro|opening|ending|op|ed|logo|sting|ident|bumper|preview|proxy|draft|rough|wip|temp|test|sample)$/i;
const NOT_THE_FILM_WORD = /镜头|分镜|片段|场景|竖版|横版|方版|竖屏|横屏|抖音|快手|小红书|视频号|预告|花絮|片头|片尾|粗剪|样片|小样|预览/;
// Folders of footage and references: nothing in them is the job's cut.
const SOURCE_FOLDER = /^(?:footage|raw|rushes|ref|refs|reference|references|素材|参考|原片)$/i;

/**
 * Whether a delivered file can be the job's final deliverable, and by which name: a video whose name
 * has the word MASTER (母带 in Chinese); failing any, one with the word final (成片, 终版); failing
 * those, a video under a `deliverables/` folder. Whole words only (`master_shot_03.mp4`,
 * `EP01finale.mp4` are not it), never a name that also names a part, another version or format, or
 * a draft (`C09_final.mp4`, `EP01_MASTER_9x16.mp4`, `EP01_trailer_MASTER.mp4`, `EP01_MASTER_proxy.mp4`),
 * and never a file under a footage or reference folder. A lower `rank` wins between names; which
 * place wins is `finalDeliverable`'s.
 */
export function bindRuleOf(relpath: string): { glob: string; rank: number } | null {
  if (!VIDEO.test(relpath)) return null;
  const segments = relpath.split("/");
  if (segments.slice(0, -1).some((segment) => SOURCE_FOLDER.test(segment))) return null;
  const base = segments[segments.length - 1]!.replace(VIDEO, "");
  const tokens = base.split(/[^A-Za-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  if (tokens.some((token) => NOT_THE_FILM_TOKEN.test(token)) || NOT_THE_FILM_WORD.test(base)) return null;
  if (tokens.some((token) => token.toLowerCase() === "master") || base.includes("母带")) return { glob: "*MASTER*", rank: 0 };
  if (tokens.some((token) => token.toLowerCase() === "final") || /成片|终版/.test(base)) return { glob: "*final*", rank: 1 };
  if (segments.slice(0, -1).includes("deliverables")) return { glob: "deliverables/**", rank: 2 };
  return null;
}

// A ticket for another version or a piece around the film: what is delivered on it is not the film.
const VERSION_TICKET = /抖音版|快手版|竖版|横版|方版|精简版|短版|加长版|英文版|预告|花絮|片头|片尾|(?<![a-z])(?:teaser|trailer|vertical|douyin|tiktok|intro|outro)(?![a-z])/i;

/** Whether a file delivered on a ticket of this title may be the film: not a part's, nor another version's. */
export function filmTicket(title: string): boolean {
  return !partTicket(title) && !VERSION_TICKET.test(title);
}

/** 108, 118.8, 8.04: at most two decimals, no trailing zeros. */
export function formatNumber(value: number): string {
  return String(round2(value));
}

/** 90 秒, 2 分钟, 2 分 30 秒, 1 小时: under two minutes in seconds, as people say it. */
function spokenDuration(seconds: number, en: boolean): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return en ? `${seconds / 3600} h` : `${seconds / 3600} 小时`;
  if (seconds >= 60 && seconds % 60 === 0) return en ? `${seconds / 60} min` : `${seconds / 60} 分钟`;
  if (seconds > 120 && Number.isInteger(seconds)) {
    const minutes = Math.floor(seconds / 60);
    return en ? `${minutes} min ${seconds % 60} s` : `${minutes} 分 ${seconds % 60} 秒`;
  }
  return en ? `${formatNumber(seconds)} s` : `${formatNumber(seconds)} 秒`;
}

const BOUND_WORD: Record<"about" | "at_least" | "at_most" | "exact", { zh: string; en: string }> = {
  about: { zh: "约 ", en: "about " },
  at_least: { zh: "至少 ", en: "at least " },
  at_most: { zh: "不超过 ", en: "at most " },
  exact: { zh: " ", en: "" },
};

/** What you said, in the app's words: the line a derived check is filed under (its `item`). */
export function readingLabel(reading: DimensionValue, locale: Locale): string {
  const en = locale === "en";
  if (reading.dimension === "aspect") {
    if (reading.ratio === "portrait") return en ? "Portrait" : "竖屏";
    if (reading.ratio === "landscape") return en ? "Landscape" : "横屏";
    return en ? `Aspect ${reading.ratio}` : `画幅 ${reading.ratio}`;
  }
  const word = BOUND_WORD[reading.bound][en ? "en" : "zh"];
  if (reading.dimension === "duration") return en ? `Running time ${word}${spokenDuration(reading.seconds, true)}` : `时长${word}${spokenDuration(reading.seconds, false)}`;
  if (reading.dimension === "resolution") return en ? `Resolution ${word}${reading.lines}p` : `分辨率${word}${reading.lines}p`;
  return en ? `Frame rate ${word}${formatNumber(reading.fps)} fps` : `帧率${word}${formatNumber(reading.fps)}`;
}

/** 108–132, at least 120, at most 90, in the unit given. */
function rangeWords(min: number | null, max: number | null, unit: string, en: boolean): string {
  if (min !== null && max !== null) return min === max ? `${formatNumber(min)}${unit}` : `${formatNumber(min)}–${formatNumber(max)}${unit}`;
  if (min !== null) return en ? `at least ${formatNumber(min)}${unit}` : `至少 ${formatNumber(min)}${unit}`;
  return en ? `at most ${formatNumber(max ?? 0)}${unit}` : `不超过 ${formatNumber(max ?? 0)}${unit}`;
}

/** What a measure asks, in a few words: 「时长 108–132 秒」, "Running time 108–132 s". */
export function measureLabel(measure: CheckMeasure, locale: Locale): string {
  const en = locale === "en";
  if (measure.dimension === "aspect") {
    if (measure.ratio === "portrait") return en ? "Portrait (taller than wide)" : "竖屏（高大于宽）";
    if (measure.ratio === "landscape") return en ? "Landscape (wider than tall)" : "横屏（宽大于高）";
    return en ? `Aspect ${measure.ratio}` : `画幅 ${measure.ratio}`;
  }
  if (measure.dimension === "duration") return en ? `Running time ${rangeWords(measure.min, measure.max, " s", true)}` : `时长 ${rangeWords(measure.min, measure.max, " 秒", false)}`;
  if (measure.dimension === "resolution") return en ? `Short side ${rangeWords(measure.min, measure.max, " px", true)}` : `短边 ${rangeWords(measure.min, measure.max, " 像素", false)}`;
  return en ? `Frame rate ${rangeWords(measure.min, measure.max, " fps", true)}` : `帧率 ${rangeWords(measure.min, measure.max, "", false)}`;
}

/** Where a derived check is not looking yet, and what it waits for: the words a Bot reads. */
export function unboundNote(locale: Locale): string {
  return locale === "en"
    ? "not bound yet: it checks the final deliverable once one is delivered (a video named *MASTER* or *final*, or under deliverables/)"
    : "还没对上文件：交付了最终成品（文件名带 MASTER 或 final 的视频，或放在 deliverables/ 下的视频）才开始检查";
}

/**
 * A check from your words you have not confirmed, as the Bots read it beside the plan's checks: what
 * the delivered cut measured against it, and that it waits for the user. Information, never a block.
 */
export function unconfirmedNote(check: { item: string; last_run?: { outcome: string | null; detail: string } | null; path?: string | null }, locale: Locale): string {
  const en = locale === "en";
  const outcome = check.last_run?.outcome;
  const got = outcome === "pass" || outcome === "fail" ? check.last_run!.detail.replace(/，要.*$|; needs .*$/, "") : null;
  if (got) return en ? `unconfirmed check: ${got}, the user said ${check.item} (waiting for the user to confirm)` : `未确认的检查：${got}，用户说的是${check.item}（待用户确认）`;
  if (!check.path) return en ? `unconfirmed check: the user said ${check.item}, nothing delivered to measure yet (waiting for the user to confirm)` : `未确认的检查：用户说的是${check.item}，还没有交付可量（待用户确认）`;
  return en ? `unconfirmed check: the user said ${check.item}, not measured yet (waiting for the user to confirm)` : `未确认的检查：用户说的是${check.item}，还没量（待用户确认）`;
}

/**
 * The app's card about a check from your words that differs from a gate in force: the gate's
 * number and the one you said last (`replaces`, then `measures`), and how many separate lines of
 * yours have said it (`times`). The only card an offer gets (2026-10-04).
 */
export function replacementCardBody(locale: Locale, measures: readonly CheckMeasure[], replaces: readonly CheckMeasure[], times = 1): string {
  const en = locale === "en";
  const list = measures.map((measure) => measureLabel(measure, locale)).join(en ? "; " : "、");
  const old = replaces.map((measure) => measureLabel(measure, locale)).join(en ? "; " : "、");
  const said = times >= 2 ? (en ? `You have said it ${times} times. ` : `你已经说了 ${times} 次。`) : "";
  return en
    ? `${said}What you said last differs from the check in force: ${old} in force, ${list} just now. The one in force stays until you choose.`
    : `${said}你后来说的和生效中的检查不一样：生效中是${old}，你刚说的是${list}。你选之前，生效中的那条照旧。`;
}

/** The words a card's 改 puts in your composer for a dimension: say the number, and your line is the source. */
export function editDraft(dimension: Dimension, locale: Locale): string {
  const en = locale === "en";
  if (dimension === "duration") return en ? "Make the running time " : "片长改成 ";
  if (dimension === "resolution") return en ? "Make the resolution " : "分辨率改成 ";
  if (dimension === "aspect") return en ? "Make the aspect " : "画幅改成 ";
  return en ? "Make the frame rate " : "帧率改成 ";
}
