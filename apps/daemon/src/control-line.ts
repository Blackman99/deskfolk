/**
 * 控制句: whether a line of yours tells the Bots to stop or to go on, read by fixed rules — no model
 * call, no store — so the app can act on it before anything else happens to the line (ADR 0040
 * P2). On 2026-09-29 five stop lines in a row went through the organizer like any request, and the
 * work they were about kept running (fixture F-a).
 *
 * One rule decides: the app acts on a line only when nothing is left of it once its control phrases
 * and a short list of fillers are taken out. Any other line with a control word in it is delivered
 * as usual, with a hint that offers the buttons (`possible_control`); nothing in it is acted on. A
 * stop missed that way costs you one press of the button, a stop read into a request halts work you
 * wanted, so whatever is unclear goes to the hint. One or two characters are enough to say who
 * stopped (「他停下」), when (「八点停」), that it already happened (「又停了」「已恢复」), on what
 * condition (「卡了就停」) or on what (「恢复文件」), so none may be left over.
 *
 * The reading, in order:
 * 1. A status question (`status-question.ts`) is answered as one.
 * 2. `@names`, Bot names, emoji, spaces and punctuation go; an emoji that says no (🙅 ❌ 🚫 ⛔) is
 *    noted first. The line asks when it has ? or 吗, ends in 么 / 呢, or has a word that asks: 停没停,
 *    了没, 有没有, 是不是 and the other A-not-A forms (能不能, 要不要…), or 怎么, 为什么, 谁….
 * 3. A question stops something only as a request made of the Bot: 能 / 可以 / 麻烦… (or 好吗 /
 *    行不行 after it) with a stop, said to 你 / 您 or with 先 / 一下 / 请 / 麻烦, or as 能不能 /
 *    可不可以 — and with no 了 (了没 included) and no word that asks why or who: 「怎么能停」「谁能停一下」
 *    ask about it, 「能先停一下吗」 requests it. Any other question with a control word in it gets a
 *    status answer, which ends with a stop button when the line says the work has not stopped or
 *    asks whether it can stop (「能停么」「停下好吗」).
 * 4. Phrases are read longest first, so a negated verb is a phrase of its own: 别停 / 不要停 go on,
 *    别继续(了) / 不要继续 stop. Stop, 没停 and go on are the three kinds. 恢复 goes on only alone or
 *    with the work (工作 / 活 / 任务 / 生成 / 渲染 / 审片: 「恢复文件」 restores a file, 「已恢复」 says
 *    what happened), and 继续等 / 继续保持… keep things as they are, which is no go on at all.
 * 5. The fillers are the only words that may stand beside them: the scope words (你, 你们, 大家,
 *    所有 Bot, 这件事…), 手头 / 工作 / 生成…, 都 / 也 / 先 / 一下 / 马上 / 立刻 / 赶紧 / 给我 / 快, 请 /
 *    吧 / 啊 / 呀 / 的, interjections (唉 嗯 哦…), and 麻烦 outside a question. Where a word stands
 *    matters: 了 is a filler only in a question (「停了」「渲染停了」 say what happened, 「停了吗」 asks
 *    it); 的 right after the verb makes it describe something (「暂停的任务」); 麻烦 is polite only
 *    before the verb (「停下麻烦吗」 asks whether it is a bother); the work right before the verb is a
 *    label for its state (「渲染暂停」「任务继续」), unless 的 comes before the work (「你手头的生成停
 *    一下」); 群里 / 私聊里 say where only before a stop or 没停 (「私聊里的也停掉」, not 「群里继续」),
 *    and 那边 / 手上 never (「手上停一下」 directs a hand in the picture).
 * 6. Pure control: nothing left over, phrases of one kind only, no lookalike (停顿, 停车), no
 *    attachment, and no word that forbids or undoes (不许, 严禁, 反对, 撤销, 解除, 取消 beside
 *    another control word, a 🙅). Nor is a line pure that shows the words rather than says them:
 *    in quotes or brackets, ~~struck out~~, after a leading >, as code (`stop`, stop(), /stop,
 *    #stop, --continue), with a laughing, smirking or thinking emoji (😂 🙃 🙄 🤔…), or with a Bot
 *    named without an @ and not followed by 「，」「、」「你」 or 「也」 (「审片员：停」 is a line of
 *    a script). A line with two kinds in it (「今天先停明天继续」「停了的接着做」)
 *    offers both buttons, and so does one with a word that forbids or undoes, which may turn the
 *    verb round (「撤销暂停」 means go on).
 * 7. 「没停」 on its own reaffirms a hold that already covers it; with none, it is a status answer
 *    with the stop button.
 * 8. 「算了」「不做了」「取消」 on their own ask whether to stop or to drop the job. 算了 and 不做了
 *    beside a stop add the offer to drop the job (「算了，停吧」); in a line with nothing else of
 *    control they are words like any other (「取消字幕」). 别再 / 不要再 are no phrase at all, so
 *    「别再用冻帧补时长」 has no control word in it.
 *
 * Where it applies is read from the words and the place (ADR 0040 P2), first row that fits:
 * everything, when the line names all the Bots (所有 Bot, 所有人都, 全都停) and nothing narrower —
 * no 你 / 你们, no Bot named, no 群里 / 私聊里 / 那边, no 这件事; the
 * Bots it names, with an `@` or without; the plan, for 「这件事」 when the caller can tell which
 * plan the line is about; in a direct, the Bot on the other side; in a group, 「你」 means the Bot
 * you are answering — the one you quote, or else the only Bot that spoke in the last ten minutes —
 * together with the group; otherwise the group.
 */
import type { ControlScope, Message, SessionKind } from "@real-bot/protocol";
import { parseMentions } from "./mentions";
import { isStatusQuestion } from "./status-question";

/** What a control line is about, in the terms a hold is made in (`scope`, `scope_id`). */
export type { ControlScope };

/** A button a hint offers. */
export type ControlVerb = "stop" | "continue";

/**
 * What the line asks the app to do:
 * - `none`: nothing; the line goes where any line goes.
 * - `status`: a question about where things stand (「停了吗」「怎么还在跑？」), answered like a status
 *   question. `offerStop`: it says the work has not stopped, or asks whether it can stop (「能停么」),
 *   so the answer ends with a button to stop what `scopes` names.
 * - `stop`: a stop line, made a hold at once. `offerCancel`: it also said 算了 / 不做了, so the
 *   receipt offers to drop the job too; text alone never drops anything.
 * - `continue`: a go-on line; which holds over `scopes` it lifts is the caller's to work out.
 * - `reaffirm`: 「你没停」 while a hold already covers it: check what still runs and end it.
 * - `abandon`: 「算了」「不做了」「取消」 alone: a card asking whether to stop or to drop the job.
 * - `possible_control`: any other line with a control word in it, delivered as usual with a hint
 *   offering the buttons in `offer`.
 */
export type ControlReading =
  | { kind: "none" }
  | { kind: "status"; offerStop: boolean; scopes: ControlScope[] }
  | { kind: "stop"; offerCancel: boolean; scopes: ControlScope[] }
  | { kind: "continue"; scopes: ControlScope[] }
  | { kind: "reaffirm"; scopes: ControlScope[] }
  | { kind: "abandon"; scopes: ControlScope[] }
  | { kind: "possible_control"; offer: ControlVerb[]; scopes: ControlScope[] };

/** The fields `readControlLine` reads from the line; a real `Message` satisfies this. */
export type ControlLineCandidate = Pick<
  Message,
  "kind" | "body" | "session_id" | "created_at" | "parent_id" | "attachments" | "annotation_source_message_id"
>;

export type ControlLineInput = {
  message: ControlLineCandidate;
  sessionKind: SessionKind;
  /** Every Bot on the roster: an `@name` is read against these, as a line's mentions are everywhere else. */
  roster: ReadonlyArray<{ id: string; name: string }>;
  /** The Bots present in the conversation: a shortened `@name` may mean one of them, and a direct's one is who you talk to. */
  present: readonly string[];
  /** The line this one quotes, when it quotes one. */
  parent?: Pick<Message, "kind" | "author"> | null;
  /** The conversation's lines before this one; only a group's last ten minutes of them are read. */
  recent?: ReadonlyArray<Pick<Message, "kind" | "author" | "created_at">>;
  /** The plan the line is about, when that can be told without a model call; null when it cannot. */
  planId?: string | null;
  /** The line sends a batch of annotations: its words are about the passages they mark. */
  annotated?: boolean;
  /** Whether a hold in force already covers `scopes`; asked only for a 「没停」 line. */
  held?: (scopes: ControlScope[]) => boolean;
};

/** A line this long is a paste or a brief, never a control line; reading it is not worth the time. */
const MAX_BODY = 4000;
/** How far back 「你」 in a group looks for the one Bot that spoke. */
const ADDRESSEE_WINDOW_MS = 10 * 60_000;

type Kind =
  | "stop"
  | "go_on"
  | "not_stopped"
  | "abandon"
  /** 停没停 / 停不停: ask whether it stopped. */
  | "asks_stop"
  /** Make the line a question wherever they are. */
  | "asks"
  /** 么 / 呢: a question at the very end, left over anywhere else. */
  | "particle"
  /** 了: a filler in a question, left over in a statement. */
  | "perfective"
  /** With a stop in a question, the line asks for the stop; 麻烦 outside a question is only polite. */
  | "request"
  /** Forbids or undoes what follows, or turns it round: left over, and the hint offers both buttons. */
  | "negation"
  | "global"
  /** 全都: everything, when a stop or a go on follows it. */
  | "all"
  | "plural"
  | "singular"
  | "this_plan"
  /** 群里 / 私聊里: where the work is, before a stop or 没停; 那边 is never enough to say where. */
  | "place"
  | "filler";

/**
 * Every phrase the reading knows, by kind. Longest match wins at each position, so 别停 (go on)
 * beats 停 (stop), 你们 beats 你, and 还在生成 beats the filler 生成. English phrases only match
 * whole words. `filler`, `place` (where rule 5 lets it) and the scope kinds are the whole
 * whitelist of what may stand beside a control phrase in a line the app acts on.
 */
const PHRASES: Readonly<Record<Kind, readonly string[]>> = {
  stop: [
    ...["停", "停下", "停下来", "停掉", "停止", "停住", "暂停", "停一下", "停手", "停工", "叫停", "喊停", "中止", "终止", "中断", "打住", "住手"],
    ...["别做了", "不要做了", "先别做", "先别做了", "别弄了", "不要弄了", "别搞了", "不要搞了", "别生成了", "不要生成了", "别渲染了", "不要渲染了"],
    ...["别再做了", "不要再做了", "别再生成了", "不要再生成了"],
    // A negated go on is a stop.
    ...["别继续", "别继续了", "不要继续", "不要继续了", "先别继续", "先别继续了", "不继续", "不用继续", "不用继续了"],
    ...["别再继续", "别再继续了", "不要再继续", "不要再继续了"],
    ...["stop", "pause", "halt", "abort", "don't continue", "do not continue", "dont continue"],
  ],
  go_on: [
    ...["继续", "继续做", "接着", "接着做", "接着来", "恢复", "往下做", "开工"],
    // A negated stop is a go on.
    ...["别停", "不要停", "不用停", "别停下", "不要停下", "别暂停", "不要暂停", "不用暂停"],
    ...["continue", "resume", "proceed", "unpause", "keep going", "go on", "carry on", "don't stop", "do not stop", "dont stop"],
  ],
  not_stopped: [
    ...["没停", "还没停", "没有停", "还没有停", "还不停", "还不停下"],
    ...["还在做", "还在跑", "还在进行", "还在继续", "还在生成", "还在渲染"],
    ...["still running", "still going", "not stopped", "haven't stopped", "didn't stop"],
  ],
  abandon: ["算了", "不做了", "取消", "作废", "cancel", "never mind", "nevermind"],
  asks_stop: ["停没停", "停不停"],
  asks: [
    ...["吗", "了没", "了没有", "有没有", "是不是", "要不要", "是否"],
    ...["怎么", "为什么", "为啥", "为何", "咋", "干嘛", "谁", "why"],
  ],
  particle: ["么", "呢"],
  perfective: ["了"],
  request: [
    ...["能", "可以", "能不能", "可不可以", "能否", "麻烦"],
    // A request asked with a tail: 「停一下好吗」.
    ...["好吗", "好么", "行吗", "行么", "可以吗", "好不好", "行不行"],
    ...["can", "could", "would"],
  ],
  negation: [
    ...["不", "别", "没", "没有", "无", "未", "勿", "莫", "甭"],
    // Forbidding or undoing it: 「严禁停」「撤销暂停」「停止暂停」 mean the other way round.
    ...["禁", "禁止", "严禁", "反对", "拒绝", "休想", "撤销", "撤回", "结束", "退出", "解除", "停止暂停", "停止叫停"],
    ...["no", "not", "never", "don't", "dont"],
  ],
  global: [
    ...["所有bot", "所有bots", "所有的bot", "全部bot", "全部bots", "所有机器人", "所有的机器人", "全部机器人", "所有人都"],
    ...["all bots", "all the bots", "every bot"],
  ],
  all: ["全都"],
  // 谁都 / 谁也 are everyone (「谁都停下」), not 谁 asking.
  plural: ["你们", "大家", "各位", "所有人", "谁都", "谁也", "everyone", "everybody", "you all"],
  singular: ["你", "您", "you"],
  this_plan: ["这件事", "这事"],
  place: ["群里", "私聊里", "那边"],
  filler: [
    // What: the work the stop is about, never what to do with it.
    ...["都", "全部", "所有", "手头", "工作", "活", "任务", "生成", "渲染", "审片", "什么都", "什么也"],
    // How soon, and particles.
    ...["也", "先", "一下", "马上", "立刻", "立即", "立马", "赶紧", "赶快", "快", "给我", "请", "吧", "啊", "呀", "的"],
    // Interjections.
    ...["唉", "哎", "哎呀", "嗯", "额", "呃", "哦", "喂"],
    ...["please", "pls", "now", "right now", "immediately", "just", "all", "everything", "rendering", "generating"],
  ],
};

/**
 * Words found before any phrase, so that none can take part of one: they look like a stop or a go
 * on and are something else (「别停顿」 is about the cut, not 「别停」; 「继续等」 keeps things as
 * they are). A line with one is never acted on, and with no control word left it is no hint either.
 */
const LOOKALIKES: readonly string[] = [
  ...["停顿", "停留", "停车", "停靠", "停泊", "停格", "停帧", "停机", "停电", "停播", "停滞", "停摆", "停歇", "停当", "调停", "停用", "暂停键"],
  ...["继续等", "继续保持", "继续搁置", "继续放着", "继续冻结", "继续挂着", "继续观望"],
];

/** Request words that ask by themselves, as A-not-A forms or with 吗 at the end. */
const ASKING_REQUESTS = new Set(["能不能", "可不可以", "能否", "好吗", "好么", "行吗", "行么", "可以吗", "好不好", "行不行"]);
/** Drop-it words that only stand alone: beside another control word they undo it (「取消暂停」「cancel the stop」). */
const CANCELS = new Set(["取消", "作废", "cancel"]);
/** What 恢复 may have beside it and still mean going on: 「恢复工作」, 「恢复渲染」, 「恢复吧」. */
const RESUMES = new Set(["恢复", "工作", "活", "任务", "生成", "渲染", "审片", "吧", "啊", "呀"]);
/** Words that ask why, who or whether: a question with one asks about the stop, it never requests one (「怎么能停」). */
const QUESTION_WORDS = new Set(["怎么", "为什么", "为啥", "为何", "咋", "干嘛", "谁", "why", "有没有", "是不是", "是否", "要不要"]);
/**
 * What makes a question a request of the Bot: said to it, or asking it to do something now or for
 * a moment. 「能停么」「可以暂停吗」 ask whether it can be done.
 */
const ASKED_OF_YOU = new Set(["你", "您", "you", "先", "一下", "请", "please", "麻烦", "能不能", "可不可以"]);
/** The work, as a filler: right before the verb it names a state (「渲染暂停」), unless 的 comes before it. */
const WORK = new Set(["工作", "活", "任务", "生成", "渲染", "审片"]);

/** An emoji that says no, noted before emoji go. */
const NO_EMOJI: readonly string[] = ["🙅", "❌", "❎", "🚫", "⛔", "✖", "👎"];
/** A laugh, a smirk or a doubt: the words beside it are not meant as they stand (「继续🙄」). */
const TONE_EMOJI: readonly string[] = ["😂", "🤣", "😆", "😹", "😏", "🙃", "🙄", "😒", "😅", "🤔", "💀", "😜", "🤪", "😝", "😛"];
/**
 * Words shown rather than said: in quotes or brackets (an apostrophe inside a word is no quote),
 * ~~struck out~~, after a > at the start of a line, in a code fence.
 */
const QUOTED = /["`“”‘「」『』《》【】〈〉〔〕()[\]{}]|~~[^~]+~~|(^|\n)\s*>|(^|[^a-z])'|'($|[^a-z])/;
/** Words written as code: stop(), continue;, /stop, #stop or #暂停#, --continue. */
const CODE = /[a-z](\(\)|;)|(^|\s)(--|\/|#)[a-z\u4e00-\u9fff]/;
/** What may follow a Bot's name written without an @ for the name to be said to it: 「审片员，停下」「审片员你也停下」. */
const AFTER_BARE_NAME = new Set([",", "、", "你", "也"]);
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\u20e3\ufe0e\ufe0f]/gu;
const WORD_CHAR = /[a-z0-9'-]/;
/**
 * Every word list the reading uses, by name. The test holds its own copy of each and checks this
 * against it, so a word added here to let a line through is added there on purpose too.
 */
export const CONTROL_LEXICON: Readonly<Record<string, readonly string[]>> = {
  ...PHRASES,
  lookalike: LOOKALIKES,
  asking_request: [...ASKING_REQUESTS],
  cancel: [...CANCELS],
  resume_with: [...RESUMES],
  question_word: [...QUESTION_WORDS],
  asked_of_you: [...ASKED_OF_YOU],
  work: [...WORK],
  after_bare_name: [...AFTER_BARE_NAME],
  no_emoji: NO_EMOJI,
  tone_emoji: TONE_EMOJI,
};
/** What the lookalike pass leaves in place of a lookalike. */
const LOOKALIKE_MARK = "\u0000";

type Phrase = { text: string; kind: Kind | "lookalike" };

function indexByFirst(phrases: Phrase[]): Map<string, Phrase[]> {
  const index = new Map<string, Phrase[]>();
  for (const phrase of phrases) {
    const first = String.fromCodePoint(phrase.text.codePointAt(0)!);
    const list = index.get(first) ?? [];
    list.push(phrase);
    index.set(first, list);
  }
  for (const list of index.values()) list.sort((a, b) => b.text.length - a.text.length);
  return index;
}

const PHRASE_INDEX = indexByFirst(
  (Object.entries(PHRASES) as Array<[Kind, readonly string[]]>).flatMap(([kind, texts]) => texts.map((text) => ({ text, kind }))),
);
const LOOKALIKE_INDEX = indexByFirst(LOOKALIKES.map((text) => ({ text, kind: "lookalike" as const })));

/** The longest phrase starting at `at`; an English one only as a whole word. */
function phraseAt(index: Map<string, Phrase[]>, text: string, at: number): Phrase | null {
  for (const phrase of index.get(String.fromCodePoint(text.codePointAt(at)!)) ?? []) {
    if (!text.startsWith(phrase.text, at)) continue;
    const end = at + phrase.text.length;
    if (WORD_CHAR.test(phrase.text[0]!) && at > 0 && WORD_CHAR.test(text[at - 1]!)) continue;
    if (WORD_CHAR.test(phrase.text.at(-1)!) && end < text.length && WORD_CHAR.test(text[end]!)) continue;
    return phrase;
  }
  return null;
}

type Token = { kind: Kind; text: string };

type Words = {
  /** The phrases read, in order; negations, and particles and 了 that are left over, are not among them. */
  tokens: Token[];
  /** Code points no phrase took, a negation's included. */
  rest: number;
  negated: boolean;
  lookalike: boolean;
  asks: boolean;
};

/**
 * Rules 2–6 on a normalized line (lower case, no punctuation, a space only between two English
 * words): lookalikes first, then phrases, leftmost-longest; what no phrase took is left over.
 */
function readWords(text: string, questionMark: boolean): Words {
  let lookalike = false;
  let masked = "";
  for (let at = 0; at < text.length; ) {
    const hit = phraseAt(LOOKALIKE_INDEX, text, at);
    const taken = hit ? hit.text : String.fromCodePoint(text.codePointAt(at)!);
    if (hit) lookalike = true;
    masked += hit ? LOOKALIKE_MARK : taken;
    at += taken.length;
  }
  let tokens: Token[] = [];
  let rest = 0;
  let negated = false;
  for (let at = 0; at < masked.length; ) {
    const ch = String.fromCodePoint(masked.codePointAt(at)!);
    if (ch === " " || ch === LOOKALIKE_MARK) {
      at += 1;
      continue;
    }
    const hit = phraseAt(PHRASE_INDEX, masked, at);
    at += hit ? hit.text.length : ch.length;
    if (!hit || (hit.kind === "particle" && at < masked.length)) {
      rest += 1;
      continue;
    }
    if (hit.kind === "negation") {
      negated = true;
      rest += [...hit.text].length;
      continue;
    }
    tokens.push({ kind: hit.kind as Kind, text: hit.text });
  }
  // Where a word stands (rule 5). Only a line with nothing left over is acted on, so a word no
  // phrase took between two tokens never matters here: the line is out already.
  const verb = (token: Token | undefined) => token !== undefined && (token.kind === "stop" || token.kind === "go_on" || token.kind === "not_stopped");
  const size = (token: Token) => [...token.text].length;
  tokens = tokens.filter((token, i) => {
    const before = tokens[i - 1];
    const next = tokens[i + 1];
    // 「暂停的任务」「你停下的」: the verb describes something, it tells nobody to do anything.
    if (token.text === "的" && verb(before)) rest += 1;
    // 「渲染暂停」「任务继续」: a label for the work's state, unless 的 makes the work a thing of yours.
    if (token.kind === "filler" && WORK.has(token.text) && (next?.kind === "stop" || next?.kind === "go_on") && before?.text !== "的") rest += size(token);
    // 群里 / 私聊里 say where the work a stop or 没停 is about; 那边 never says enough.
    if (token.kind === "place" && (token.text === "那边" || !tokens.slice(i + 1).some((after) => after.kind === "stop" || after.kind === "not_stopped"))) rest += size(token);
    // 「停下麻烦吗」 asks whether stopping is a bother: 麻烦 is polite only before the verb.
    if (token.kind === "request" && token.text === "麻烦" && tokens.slice(0, i).some(verb)) {
      rest += size(token);
      return false;
    }
    return true;
  });
  const asks =
    questionMark ||
    tokens.some((token) => token.kind === "asks" || token.kind === "asks_stop" || token.kind === "particle" || ASKING_REQUESTS.has(token.text));
  // Outside a question, 了 says what happened, and a request word is only words (「可以停」), 麻烦
  // aside, which is only polite.
  if (!asks) {
    for (const token of tokens) {
      if (token.kind === "perfective" || (token.kind === "request" && token.text !== "麻烦")) rest += [...token.text].length;
    }
  }
  // 恢复 goes on only alone or with the work it is about.
  if (tokens.some((token) => token.text === "恢复") && (rest > 0 || tokens.some((token) => !RESUMES.has(token.text)))) {
    tokens = tokens.filter((token) => token.text !== "恢复");
    lookalike = true;
  }
  return { tokens, rest, negated, lookalike, asks };
}

/**
 * Punctuation and spaces out; a space stays only between two English words, and an apostrophe or a
 * hyphen inside a word keeps it whole (「don't」「stop-motion」).
 */
function squeeze(text: string): string {
  const chars = [...text];
  const spaced = chars
    .map((ch, i) => {
      const inWord = (ch === "'" || ch === "-") && /[a-z]/.test(chars[i - 1] ?? "") && /[a-z]/.test(chars[i + 1] ?? "");
      return !inWord && /[\p{P}\p{S}]/u.test(ch) ? " " : ch;
    })
    .join("");
  return spaced.replace(/\s+/g, (space: string, offset: number, whole: string) =>
    /[a-z0-9]/.test(whole[offset - 1] ?? "") && /[a-z0-9]/.test(whole[offset + space.length] ?? "") ? " " : "",
  );
}

/** The body with its `@names` gone, plus the Bots it names by id and whether it says `@everyone`. */
function mentionsOf(input: ControlLineInput): { text: string; named: string[]; everyone: boolean } {
  const { message, roster, present, parent } = input;
  const nameOf = new Map(roster.map((bot) => [bot.id, bot.name] as const));
  const idOf = new Map(roster.map((bot) => [bot.name, bot.id] as const));
  const presentNames = present.map((id) => nameOf.get(id)).filter((name): name is string => typeof name === "string");
  const parsed = parseMentions(message.body, roster.map((bot) => bot.name), { lenient: presentNames });
  let text = "";
  let from = 0;
  for (const span of parsed.spans) {
    text += message.body.slice(from, span.start) + " ";
    from = span.end;
  }
  text += message.body.slice(from);
  // Quoting a Bot's line puts its @name in front (store/messages.ts): that says who you answer, which
  // is what 「你」 reads, not an @ of your own.
  const quoted = parent?.kind === "bot" ? nameOf.get(parent.author) : undefined;
  const lead = parsed.spans[0];
  const replyMention =
    quoted !== undefined && lead?.name === quoted && message.body.slice(0, lead.start).trim() === "" && parsed.spans.filter((span) => span.name === quoted).length === 1;
  const named = parsed.mentions
    .filter((name) => !(replyMention && name === quoted))
    .map((name) => idOf.get(name))
    .filter((id): id is string => typeof id === "string");
  return { text, named, everyone: parsed.everyone };
}

/**
 * Roster names written without an `@` (「视频导演，停下」), taken out of the normalized text and read
 * like `@names`. Only names of two code points or more, and an English one only as a whole word.
 * `loose`: a name not followed by 「，」「、」「你」 or 「也」, which may be a line of a script
 * (「审片员：停」), a subject (「视频导演停下来的镜头」) or part of a longer name for something else.
 */
function bareNamesOf(text: string, roster: ControlLineInput["roster"]): { text: string; named: string[]; loose: boolean } {
  const names = roster
    .map((bot) => ({ id: bot.id, name: bot.name.normalize("NFKC").toLowerCase() }))
    .filter((bot) => [...bot.name].length >= 2)
    .sort((a, b) => b.name.length - a.name.length);
  const named: string[] = [];
  let out = "";
  let loose = false;
  for (let at = 0; at < text.length; ) {
    const hit = names.find(
      (bot) =>
        text.startsWith(bot.name, at) &&
        !(WORD_CHAR.test(bot.name[0]!) && at > 0 && WORD_CHAR.test(text[at - 1]!)) &&
        !(WORD_CHAR.test(bot.name.at(-1)!) && WORD_CHAR.test(text[at + bot.name.length] ?? "")),
    );
    if (hit) {
      if (!named.includes(hit.id)) named.push(hit.id);
      out += " ";
      at += hit.name.length;
      if (!AFTER_BARE_NAME.has(text.slice(at).trimStart().charAt(0))) loose = true;
    } else {
      out += text[at];
      at += 1;
    }
  }
  return { text: out, named, loose };
}

/** The Bot 「你」 in a group means: the one you quote, else the only Bot that spoke in the last ten minutes. */
function addressee(input: ControlLineInput): string | null {
  if (input.parent?.kind === "bot") return input.parent.author;
  const now = Date.parse(input.message.created_at);
  const bots = new Set(
    (input.recent ?? [])
      .filter((line) => {
        if (line.kind !== "bot") return false;
        const at = Date.parse(line.created_at);
        return at >= now - ADDRESSEE_WINDOW_MS && at <= now;
      })
      .map((line) => line.author),
  );
  return bots.size === 1 ? [...bots][0]! : null;
}

function scopesOf(input: ControlLineInput, tokens: Token[], mentions: { named: string[]; everyone: boolean }): ControlScope[] {
  const has = (kind: Kind) => tokens.some((token) => token.kind === kind);
  const group = input.sessionKind === "group";
  const session: ControlScope = { scope: "session", id: input.message.session_id };
  // 「全都停」「所有 Bot 停下」 name everything, and 「全都继续」 lifts it again. Anything narrower
  // in the line wins: 「你手头的全都停下」 is still the one Bot, 「你们全都停下」 the Bots the line is
  // said to, as 你们 alone would be, 「私聊里的全都停下」 the work in the direct, 「这件事全都停下」
  // the plan.
  const allOf = tokens.some((token, i) => {
    const next = tokens.slice(i + 1).find((after) => after.kind !== "filler");
    return token.kind === "all" && (next?.kind === "stop" || next?.kind === "go_on");
  });
  const narrower = has("singular") || has("plural") || has("place") || has("this_plan") || mentions.named.length > 0;
  if ((has("global") || allOf) && !narrower) return [{ scope: "global", id: null }];
  const named: ControlScope[] = [...new Set(mentions.named)].map((id) => ({ scope: "bot", id }));
  if (mentions.everyone && group) named.push(session);
  if (named.length > 0) return named;
  if (has("this_plan") && input.planId) return [{ scope: "plan", id: input.planId }];
  if (!group) {
    const other = input.present.length === 1 ? input.present[0]! : null;
    return [other ? { scope: "bot", id: other } : session];
  }
  if (has("singular")) {
    const bot = addressee(input);
    return bot ? [{ scope: "bot", id: bot }, session] : [session];
  }
  return [session];
}

const NONE: ControlReading = { kind: "none" };

/** Reads a line of yours for stop, go on or 「没停」; see the file comment for the rules. */
export function readControlLine(input: ControlLineInput): ControlReading {
  const { message } = input;
  if (message.kind !== "user" || message.body.length > MAX_BODY) return NONE;
  const mentions = mentionsOf(input);
  const said = mentions.text.normalize("NFKC").toLowerCase().replace(/’/g, "'");
  const bare = bareNamesOf(said.replace(EMOJI, ""), input.roster);
  const words = readWords(squeeze(bare.text), bare.text.includes("?"));
  const has = (kind: Kind) => words.tokens.some((token) => token.kind === kind);
  const scopes = () => scopesOf(input, words.tokens, { named: [...mentions.named, ...bare.named], everyone: mentions.everyone });

  // 1. A status question.
  if (isStatusQuestion(message)) return { kind: "status", offerStop: false, scopes: scopes() };
  if (input.annotated || message.annotation_source_message_id) return NONE;

  // 4. The kinds said. 算了 goes with a stop; 停没停 asks about one.
  const stopping = has("stop") || has("abandon") || has("asks_stop");
  const kinds = [stopping, has("go_on"), has("not_stopped")].filter(Boolean).length;
  if (kinds === 0) return NONE;
  // 6. Words that forbid or undo: 取消 beside another control word, an emoji that says no.
  const verbs = has("stop") || has("go_on") || has("not_stopped") || has("asks_stop");
  const negated = words.negated || NO_EMOJI.some((emoji) => message.body.includes(emoji)) || (verbs && words.tokens.some((token) => CANCELS.has(token.text)));
  const offer: ControlVerb[] =
    negated
      ? ["stop", "continue"]
      : [...(has("stop") || has("asks_stop") || has("not_stopped") ? ["stop" as const] : []), ...(has("go_on") ? ["continue" as const] : [])];

  // 6. Anything but pure control is only a hint; 8. 算了 in a longer line not even that. Words
  // shown rather than said, and a Bot's name written as the subject of a line, are not pure.
  const shown = QUOTED.test(said) || CODE.test(said) || TONE_EMOJI.some((emoji) => message.body.includes(emoji)) || bare.loose;
  const pure = kinds === 1 && words.rest === 0 && !negated && !words.lookalike && !shown && message.attachments.length === 0;
  if (!pure) return verbs ? { kind: "possible_control", offer, scopes: scopes() } : NONE;

  // 3. A question: a stop only when it is a request of the Bot. Asked whether it can stop
  // (「能停么」「停下好吗」), the answer offers the button.
  if (words.asks) {
    const couldBe = has("stop") && has("request") && !words.tokens.some((token) => token.text.startsWith("了") || QUESTION_WORDS.has(token.text));
    const ofYou = words.tokens.some((token) => ASKED_OF_YOU.has(token.text) || (token.kind === "stop" && [...ASKED_OF_YOU].some((word) => token.text.includes(word))));
    if (couldBe && ofYou) return { kind: "stop", offerCancel: has("abandon"), scopes: scopes() };
    return { kind: "status", offerStop: has("not_stopped") || couldBe, scopes: scopes() };
  }
  if (has("stop")) return { kind: "stop", offerCancel: has("abandon"), scopes: scopes() };
  // 7. 没停.
  if (has("not_stopped")) {
    const covered = scopes();
    return input.held?.(covered) ? { kind: "reaffirm", scopes: covered } : { kind: "status", offerStop: true, scopes: covered };
  }
  if (has("go_on")) return { kind: "continue", scopes: scopes() };
  return { kind: "abandon", scopes: scopes() };
}
