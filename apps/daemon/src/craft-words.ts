/**
 * Whether a requirement is about how the work is made rather than about one thing in it (craft):
 * shots that hold together (背景连贯, 过门要有过渡), no extra hands or broken anatomy, no freeze
 * frames to fill the running time, one look kept the same throughout (画风统一, 色调一致); or a
 * choice of what the work looks or sounds like (色调偏冷, 打光要硬, 配音用男声: a value choice);
 * or about what stays the same across a series (a character's left arm, its look). ADR 0042 filed
 * all three for the conversation the plan lives in (the project) by default, in a video job; since
 * 2026-10-10 only the scribe's own reading widens a new entry, and these lists are left for old
 * rules taken in (`conversationWide`) and standing candidates. Only craft is offered to hold for every video job (standing): a
 * value choice is one film's or one series' taste (EP01 cold, EP02 warm), and a series' constants
 * are that series' own. A fixed list of words, read with no model, in the category the scribe gave
 * and in your words themselves.
 *
 * The list keeps to words that name the craft of pictures and cuts. A bare 一致, 统一, 风格, 节奏
 * or 画质 is left out: 「这次数据要和上个月一致」 is about one job, and filed for the whole
 * conversation it would reach every later job there. They count only beside what they make one
 * (画风统一, 色调一致), which is also what turns a value word into craft.
 *
 * Words naming one part of the work (C09, 镜头 3, 片头) are about that part: 「C09 脚穿地」 stays
 * where it was said, whatever its category.
 *
 * The scribe reads which of these an entry is (`nature`, ADR 0055); these lists are what the app
 * goes by for an entry nothing read so (one the scribe gave no nature, an old rule taken in).
 */
// What a film looks or sounds like: chosen per film or per series, so no craft on its own.
const LOOK_ZH = "画风|色调|光影|打光|运镜|镜头语言|字幕样式|配音|音色";
const LOOK_EN = "art style|visual style|colou?r grad(?:e|ing)|lighting";

const CRAFT_ZH = new RegExp(
  [
    "连贯", "衔接", "过渡", "转场", "跳变", "解剖", "多手", "多指", "四肢", "畸形", "穿模", "冻帧", "静帧", "补时长",
    // One look kept the same: 画风统一, 色调前后要一致, 统一的光影, 风格保持一致.
    `(?:${LOOK_ZH}|(?:画面|视觉|美术)?风格)(?:要|需要|保持|必须|得|前后|始终|全片|全程|都|也)*(?:统一|一致)`,
    `(?:统一|一致)的?(?:${LOOK_ZH}|风格)`,
  ].join("|"),
);

const CRAFT_EN = new RegExp(
  [
    "continuity", "(?:shot|scene) transitions?", "transitions? between (?:shots|scenes)",
    "consistent (?:style|look|colou?rs?|lighting|colou?r grad(?:e|ing))",
    `(?:${LOOK_EN}) (?:(?:must|should|has to|needs to) )?(?:(?:stays?|be|is|remains?) )?consistent`,
    "anatomy", "anatomical", "extra (?:hands?|fingers?|limbs?)", "freeze[- ]?frames?",
  ]
    .map((words) => `\\b(?:${words})\\b`)
    .join("|"),
  "i",
);

const VALUE_ZH = new RegExp(LOOK_ZH);
const VALUE_EN = new RegExp(`\\b(?:${LOOK_EN})\\b`, "i");

const SERIES_ZH = /人设|角色设定|造型|左手|右手|左臂|右臂/;
const SERIES_EN = /\b(?:character design|left (?:hand|arm)|right (?:hand|arm))\b/i;

// One part of the work, named: C09, s03, 第 3 镜, 前三镜, 镜头 5, 第 2 集, 片头, 片尾, shot 4.
const NAMES_A_PART =
  /(?<![A-Za-z0-9])[A-Za-z]\d{1,3}(?!\d)|第\s*[\d一二三四五六七八九十百]+\s*(?:镜|个镜头|段|场|幕|集)|[\d一二三四五六七八九十百]+\s*号?镜(?!头)|镜头\s*\d|片头|片尾|(?<![a-z])(?:shots?|scenes?|clips?)\s*\d/i;

/** Whether words name one part of the work (C09, 镜头 3, 片头): about that part, whatever else they say. */
export function namesAPart(words: string): boolean {
  return NAMES_A_PART.test(words.normalize("NFKC"));
}

function reads(category: string | null, words: string, zh: RegExp, en: RegExp): boolean {
  if (namesAPart(words)) return false;
  const said = (text: string): boolean => zh.test(text) || en.test(text);
  return (category !== null && said(category)) || said(words);
}

/** Whether an entry of this category, standing on these words, is about how the work is made (see above). */
export function craftRequirement(category: string | null, words: string): boolean {
  return reads(category, words, CRAFT_ZH, CRAFT_EN);
}

/**
 * Whether an entry holds for the plan's whole conversation by default, in a video job: craft, a
 * value choice of how the work looks or sounds, or what stays the same across a series (see above).
 */
export function conversationWide(category: string | null, words: string): boolean {
  return craftRequirement(category, words) || reads(category, words, VALUE_ZH, VALUE_EN) || reads(category, words, SERIES_ZH, SERIES_EN);
}

/** Whether an entry is about how the work is made: as the scribe read it when it did, else by the lists above. */
export function craftEntry(nature: string | null, category: string | null, words: string): boolean {
  if (nature === null) return craftRequirement(category, words);
  return nature === "craft" && !namesAPart(words);
}
