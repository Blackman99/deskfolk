/**
 * What the app itself says about your stops (ADR 0040 P2): the receipt for a stop or a go on it
 * carried out, its answer when you ask whether things stopped or say they have not, the note a
 * Bot's work goes on with after a lift, and the line a read-only turn opens on; and after a restart,
 * what it cut off (ADR 0041). Every word of it comes from what the holds recorded and what the store
 * says is running — no model writes any of it, so it cannot claim a stop that did not happen.
 */
import type { Locale, RestartCause } from "@real-bot/protocol";

/** Your line, as a receipt quotes it: when you said it (wall-clock hour and minute) and what. Null for a button. */
export type SaidLine = { at: string; body: string } | null;

/** A line of yours as a receipt quotes it. */
export function saidOf(line: { created_at: string; body: string }): NonNullable<SaidLine> {
  return { at: clockOf(line.created_at), body: line.body };
}

/** Wall-clock hour and minute, as the app says when something was said or made. */
export function clockOf(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** A turn a stop ended, or one still running, as a receipt lists it. */
export type ControlTurnLine = {
  /** The Bot, when the receipt's heading does not already name it. */
  bot: string | null;
  plan: string | null;
  /** The conversation it ran in; null when it is the one the receipt is in. */
  where: string | null;
  lastStep: string | null;
};

/** How much of your line a receipt quotes. */
const SAID_MAX = 60;

/** Your words, quoted: 「你手头的生成停一下」. */
function quoted(locale: Locale, said: NonNullable<SaidLine>): string {
  const chars = [...said.body.replace(/\s+/g, " ").trim()];
  const body = chars.length > SAID_MAX ? `${chars.slice(0, SAID_MAX).join("")}…` : chars.join("");
  return locale === "en" ? `"${body}"` : `「${body}」`;
}

/** When you said what: 你 10:35 说的「你手头的生成停一下」. */
function youSaid(locale: Locale, said: NonNullable<SaidLine>): string {
  return locale === "en" ? `you said at ${said.at}: ${quoted(locale, said)}` : `你 ${said.at} 说的${quoted(locale, said)}`;
}

function turnLine(locale: Locale, line: ControlTurnLine): string {
  const en = locale === "en";
  const parts: string[] = [];
  if (line.bot) parts.push(line.bot);
  parts.push(line.plan ?? (en ? "no plan" : "没有规划的一段"));
  if (line.where) parts.push(en ? `in ${line.where}` : `在「${line.where}」`);
  if (line.lastStep) parts.push(en ? `last step: ${line.lastStep}` : `最后一步：${line.lastStep}`);
  return parts.join(" · ");
}

function joinList(locale: Locale, items: readonly string[]): string {
  return items.join(locale === "en" ? ", " : "、");
}

/**
 * The receipt for a stop: what it covers, what it ended, what it set aside, what goes on beside it,
 * and what still runs (nothing, unless something went wrong).
 */
export function stopReceiptBody(
  locale: Locale,
  input: {
    /** Each hold's scope in words: "视频导演的全部工作", "群「剪辑」里的工作", "所有 Bot 的工作". */
    scopes: readonly string[];
    said: SaidLine;
    stopped: readonly ControlTurnLine[];
    suspended: number;
    parked: readonly string[];
    beside: readonly { bot: string; plan: string; ticket: string | null }[];
    stillRunning: readonly ControlTurnLine[];
    /**
     * A hold that goes when you next speak, and about what: a Stop's, about that job (`job`); a
     * group stop menu's, in that group (`group`) or to that Bot (`bot`). False: until you lift it.
     */
    liftOnNextLine: false | "job" | "group" | "bot";
    /** Everything is stopped, routines too. */
    global: boolean;
  },
): string {
  const en = locale === "en";
  const lines: string[] = [];
  const what = joinList(locale, input.scopes);
  const source = input.said ? (en ? ` (${youSaid(locale, input.said)})` : `（${youSaid(locale, input.said)}）`) : "";
  lines.push(en ? `Stopped: ${what}${source}.` : `已停下${what}${source}。`);
  if (input.global) lines.push(en ? "- Routines are paused too." : "- 日程也暂停。");
  if (input.stopped.length > 0) {
    const turns = input.stopped.map((line) => turnLine(locale, line)).join(en ? "; " : "；");
    lines.push(en ? `- Ended ${input.stopped.length} running turn(s): ${turns}` : `- 中止 ${input.stopped.length} 段执行：${turns}`);
  } else {
    lines.push(en ? "- Nothing was running; nothing new starts." : "- 当时没有在跑的，新的也不会再开。");
  }
  if (input.suspended > 0) {
    lines.push(
      en
        ? `- ${input.suspended} check-back(s) set aside; they come back when you lift the stop.`
        : `- 挂起 ${input.suspended} 个回看，继续时恢复。`,
    );
  }
  if (input.parked.length > 0) lines.push(en ? `- Parked: ${joinList(locale, input.parked)}` : `- 搁置：${joinList(locale, input.parked)}`);
  for (const other of input.beside) {
    const on = other.ticket ? (en ? `${other.plan}, ${other.ticket}` : `${other.plan}的${other.ticket}`) : other.plan;
    lines.push(
      en
        ? `- ${other.bot} is still working on ${on}; this stop does not cover it.`
        : `- ${other.bot} 还在做${on}，这次叫停没有覆盖它，照常。`,
    );
  }
  lines.push(
    input.stillRunning.length === 0
      ? en
        ? "- Running now: nothing."
        : "- 此刻在跑：无。"
      : en
        ? `- Still running: ${input.stillRunning.map((line) => turnLine(locale, line)).join("; ")}`
        : `- 仍在跑：${input.stillRunning.map((line) => turnLine(locale, line)).join("；")}`,
  );
  // A stop on everything is lifted by words that name everything; a plain 「继续」 lifts one Bot's or one group's.
  lines.push(
    input.liftOnNextLine
      ? nextLineLifts(locale, input.liftOnNextLine)
      : input.global
        ? en
          ? `Say "all bots continue" to lift it.`
          : "说「所有 Bot 继续」就解除。"
        : en
          ? `Say "continue" to lift it.`
          : "说「继续」就解除。",
  );
  return lines.join("\n");
}

/** How a stop that goes with your next line says so, by what that line has to be about. */
function nextLineLifts(locale: Locale, about: "job" | "group" | "bot"): string {
  const en = locale === "en";
  switch (about) {
    case "job":
      return en ? "Say anything more about this job and it goes on from there." : "你在这件事上再说话，它就接着往下。";
    case "group":
      return en ? "Say anything more in this group and the Bots go on from what you say." : "你在这个群里再说话就解除，Bot 从你这句接着往下。";
    case "bot":
      return en ? "Say anything more to it and it goes on from what you say." : "你再对它说话就解除，它从你这句接着往下。";
  }
}

/** The receipt for a go on: which stops it lifted, and what goes on now. */
export function continueReceiptBody(
  locale: Locale,
  input: {
    /** Each lifted hold, its scope in words and the line that made it. */
    lifted: readonly { scope: string; said: SaidLine }[];
    resumed: readonly ControlTurnLine[];
    /** Bots going on from a line of yours they could only answer while it was stopped, with that line. */
    takenUp?: readonly { bot: string; said: SaidLine }[];
    resumedCheckBacks: number;
    restored: readonly string[];
    /** Holds still covering what you let go on, in words, with the line that made each. */
    stillHeld: readonly { scope: string; said: SaidLine }[];
  },
): string {
  const en = locale === "en";
  const lines: string[] = [];
  const lifted = input.lifted.map((row) => withSaid(locale, row.scope, row.said)).join(en ? "; " : "；");
  lines.push(en ? `Lifted: ${lifted}.` : `已解除叫停：${lifted}。`);
  if (input.resumed.length > 0) {
    const turns = input.resumed.map((line) => turnLine(locale, line)).join(en ? "; " : "；");
    lines.push(en ? `- ${input.resumed.length} stopped turn(s) start again with a note on where they were: ${turns}` : `- ${input.resumed.length} 段被停下的工作带着一条说明重新开始：${turns}`);
  }
  if (input.takenUp && input.takenUp.length > 0) {
    const rows = input.takenUp.map((row) => withSaid(locale, row.bot, row.said)).join(en ? "; " : "；");
    lines.push(en ? `- Going on from what you said while it was stopped: ${rows}` : `- 照你叫停期间说的接着做：${rows}`);
  }
  if (input.resumedCheckBacks > 0) lines.push(en ? `- ${input.resumedCheckBacks} check-back(s) back on.` : `- ${input.resumedCheckBacks} 个回看恢复。`);
  if (input.restored.length > 0) lines.push(en ? `- Back as before: ${joinList(locale, input.restored)}` : `- 恢复原状：${joinList(locale, input.restored)}`);
  lines.push(...stillHeldLines(locale, input.stillHeld));
  return lines.join("\n");
}

function stillHeldLines(locale: Locale, stillHeld: readonly { scope: string; said: SaidLine }[]): string[] {
  return stillHeld.map((row) =>
    locale === "en" ? `Still stopped: ${withSaid(locale, row.scope, row.said)}.` : `仍在叫停中：${withSaid(locale, row.scope, row.said)}。`,
  );
}

/** A hold's scope in words, with the line that made it when a line did. */
function withSaid(locale: Locale, scope: string, said: SaidLine): string {
  if (!said) return scope;
  return locale === "en" ? `${scope} (${youSaid(locale, said)})` : `${scope}（${youSaid(locale, said)}）`;
}

/**
 * The answer to 「停了吗」「你没停」 and their like: what holds the work you asked about, what of it
 * still runs, and — when you said it had not stopped — what the app found running under a stop and
 * ended just now.
 */
export function controlStatusBody(
  locale: Locale,
  input: {
    /** What you asked about, in words: a Bot's name, a group, a plan, "所有 Bot". */
    about: string;
    holds: readonly { scope: string; said: SaidLine; since: string }[];
    running: readonly ControlTurnLine[];
    /**
     * Work on what is said here that runs where a stop here does not reach: on the job your line is
     * filed under, or in a Bot↔Bot direct opened from here, when the job's own conversation is another.
     */
    elsewhere?: readonly ControlTurnLine[];
    ended: readonly ControlTurnLine[];
    /** The words said it had not stopped, or asked whether it can stop, and nothing holds it: the answer ends with a stop button. */
    offerStop: boolean;
    /** Said in place of a read-only answer that said nothing to your line: it opens by saying why. */
    unanswered?: boolean;
  },
): string {
  const en = locale === "en";
  const lead = input.unanswered
    ? [
        en
          ? `${input.about} did not answer: it is stopped, so it could only read and reply, and does not act on what you said.`
          : `${input.about}没有回话：它被叫停着，这一段只能读和回答，不会照你的话动手。`,
      ]
    : [];
  const lines: string[] = [...lead, ...(
    input.holds.length === 0
      ? [en ? `${input.about}: not stopped.` : `${input.about}：没有被叫停。`, ...endedLines(locale, input.ended)]
      : heldLines(locale, { about: input.about, holds: input.holds, ended: input.ended }))];
  lines.push(
    input.running.length === 0
      ? en
        ? "Running now: nothing."
        : "此刻在跑：无。"
      : en
        ? `Running now: ${input.running.map((line) => turnLine(locale, line)).join("; ")}`
        : `此刻在跑：${input.running.map((line) => turnLine(locale, line)).join("；")}`,
  );
  const elsewhere = input.elsewhere ?? [];
  if (elsewhere.length > 0) {
    lines.push(
      en
        ? `Also working on this elsewhere, out of reach of a stop here: ${elsewhere.map((line) => turnLine(locale, line)).join("; ")}`
        : `别处也在做这里的事（在这里叫停停不到）：${elsewhere.map((line) => turnLine(locale, line)).join("；")}`,
    );
  }
  if (input.offerStop) lines.push(en ? `Press Stop to stop ${input.about}.` : `要停下${input.about}，点「停下」。`);
  if (input.unanswered) lines.push(en ? "A button below lifts the stop, and it takes up your line." : "点下面的按钮解除，它就照你这句做。");
  return lines.join("\n");
}

/**
 * Where your stops stand, a line per stop (`about` names what was asked about, or is null when the
 * line is one of several in a status answer), then what was found running under one and ended just
 * now. Shared by the answer to 「停了吗」 and the status answer about a plan.
 */
export function heldLines(
  locale: Locale,
  input: { about: string | null; holds: readonly { scope: string; said: SaidLine; since: string }[]; ended: readonly ControlTurnLine[] },
): string[] {
  const en = locale === "en";
  const lines = input.holds.map((hold) => {
    // The line that made it says when; a button's hold has only its own time.
    const source = hold.said ? youSaid(locale, hold.said) : en ? `since ${hold.since}` : `自 ${hold.since} 起`;
    const lead = input.about ?? (en ? "Stopped" : "叫停");
    return input.about ? (en ? `${lead}: stopped (${hold.scope}, ${source}).` : `${lead}：叫停中（${hold.scope}，${source}）。`) : en ? `${lead}: ${hold.scope} (${source}).` : `${lead}：${hold.scope}（${source}）。`;
  });
  return [...lines, ...endedLines(locale, input.ended)];
}

function endedLines(locale: Locale, ended: readonly ControlTurnLine[]): string[] {
  if (ended.length === 0) return [];
  const en = locale === "en";
  const turns = ended.map((line) => turnLine(locale, line)).join(en ? "; " : "；");
  return [en ? `Found still running under the stop, and ended now: ${turns}` : `刚才发现叫停下还有在跑的，已停下：${turns}`];
}

/**
 * The note a Bot's stopped work opens on once you lift the stop: that you said to go on, in your
 * words, and where the work was when it was stopped. It states what happened and asks for nothing;
 * what to do next is the Bot's to read from the transcript.
 */
export function resumeNote(
  locale: Locale,
  input: { said: SaidLine; plan: string | null; written: readonly string[]; recent: readonly string[] },
): string {
  const en = locale === "en";
  const parts: string[] = [];
  if (en) {
    parts.push(
      input.said
        ? `(App note) The user had stopped this work and has now lifted the stop (their words: ${quoted(locale, input.said)}).`
        : "(App note) The user had stopped this work and has now lifted the stop.",
    );
    if (input.plan) parts.push(`It was ${input.plan}.`);
    if (input.written.length > 0) parts.push(`Files it wrote: ${input.written.join(", ")}`);
    if (input.recent.length > 0) parts.push(`Last things it did before the stop: ${input.recent.join("; ")}`);
    parts.push("What was said here while it was stopped is in the transcript above.");
  } else {
    parts.push(input.said ? `（应用提示）用户叫停了这件工作，现在解除了（原话：${quoted(locale, input.said)}）。` : "（应用提示）用户叫停了这件工作，现在解除了。");
    if (input.plan) parts.push(`停下前在做的是${input.plan}。`);
    if (input.written.length > 0) parts.push(`写过的文件：${input.written.join("、")}`);
    if (input.recent.length > 0) parts.push(`停下前最后几步：${input.recent.join("；")}`);
    parts.push("叫停期间这里说过的话都在上面的转录里。");
  }
  return parts.join("\n");
}

/** The first line of a read-only turn's situation: the stop over it, and what the turn may do. */
export function readOnlyLine(locale: Locale, said: SaidLine): string {
  if (locale === "en") {
    const source = said ? ` (they said at ${said.at}: ${quoted(locale, said)})` : "";
    return `The user has stopped this work${source}. This turn can only answer: read files and reply; it changes nothing and wakes nobody.`;
  }
  const source = said ? `（用户 ${said.at} 说的${quoted(locale, said)}）` : "";
  return `用户已叫停这件工作${source}，这一段只能回答：可以读文件、回复用户，改不了任何东西，也叫不动别人。`;
}

/**
 * How a job a restart cut off goes on (ADR 0045), as its notice says it. Below the supervisor's
 * level there is none: nothing goes on until you press a button.
 * - `now`: the daemon stopped cleanly, so it picks up at once.
 * - `after_stable`: after a crash or a development restart, once the daemon has run for a minute.
 * - `dev_burst`: a development daemon that restarted more than once within five minutes waits for you.
 * - `held`: a stop of yours covers it; it goes on after the lift.
 * - `unknown_effect`: its last external call has no known outcome, so it waits for you.
 * - `waits`: work on no plan, which the supervisor does not pick up.
 * - `restarted_again`: cut by an earlier development restart and to go on after a minute, but the
 *   daemon started again first, so it waits for you; told by the later boot.
 */
export type RestartArrangement = "now" | "after_stable" | "dev_burst" | "held" | "unknown_effect" | "waits" | "restarted_again";

/** One arrangement as the notice's last line says it. */
function arrangementLine(locale: Locale, arrangement: RestartArrangement | null): string {
  const en = locale === "en";
  switch (arrangement) {
    case "now":
      return en ? "It stopped cleanly, so it picks up from where it stopped now." : "这次是正常停下，现在就从断的地方自动接着做。";
    case "after_stable":
      return en
        ? "Once the daemon has run steadily for a minute it picks up once on its own; Continue goes on now, Not now leaves it as it is; its 「中断」 line's own Continue still picks it up later."
        : "守护进程稳定运行 1 分钟后会自动接着做一次；点「继续」现在就接着做，点「先放着」就先不动它，之后还能点它那条「中断」后面的「继续」。";
    case "dev_burst":
      return en
        ? "The development daemon restarted more than once within five minutes, so nothing picks up on its own: Continue picks each up from where it stopped; Not now leaves it as it is; its 「中断」 line's own Continue still picks it up later."
        : "开发版守护进程 5 分钟内重启了不止一次，不会自己接着做：点「继续」从断的地方接着做，点「先放着」就先不动它，之后还能点它那条「中断」后面的「继续」。";
    case "held":
      return en ? "A stop of yours covers it; it picks up once you lift the stop." : "你的叫停还覆盖着它，解除叫停之后再接着做。";
    case "unknown_effect":
      return en
        ? "Its last external call has no known outcome, so nothing picks up on its own, to avoid submitting it twice: check whether that step went through, then press Continue; Not now leaves it as it is; its 「中断」 line's own Continue still picks it up later."
        : "最后一步是结果不明的外部调用，为免重复提交不会自己接着做：先确认那一步有没有生效，再点「继续」；点「先放着」就先不动它，之后还能点它那条「中断」后面的「继续」。";
    case "restarted_again":
      return en
        ? "An earlier development restart cut it off, and the daemon started again before it could pick up, so nothing picks up on its own: Continue picks each up from where it stopped; Not now leaves it as it is; its 「中断」 line's own Continue still picks it up later."
        : "它是之前开发版重启时断的，还没来得及自动接着做，守护进程又启动了一次，所以不会自己接着做：点「继续」从断的地方接着做，点「先放着」就先不动它，之后还能点它那条「中断」后面的「继续」。";
    default:
      return en
        ? "Nothing picks up on its own: Continue picks each up from where it stopped; Not now leaves it as it is; its 「中断」 line's own Continue still picks it up later."
        : "不会自己接着做：点「继续」从断的地方接着做，点「先放着」就先不动它，之后还能点它那条「中断」后面的「继续」。";
  }
}

/**
 * After a restart, one job it cut off (ADR 0041): why the daemon started again, each turn that
 * stopped and where, and what happens now. Below the supervisor's level nothing goes on until you
 * press a button; from it each turn's `arrangement` (ADR 0045) says whether it picks up on its own,
 * and when — turns with different arrangements are named with theirs.
 */
export function restartNoticeBody(
  locale: Locale,
  input: {
    cause: RestartCause;
    /** The plan the turns were on, as a title; null for turns on no plan. */
    plan: string | null;
    turns: ReadonlyArray<ControlTurnLine & { arrangement?: RestartArrangement | null }>;
  },
): string {
  const en = locale === "en";
  const why = en
    ? { clean: "The daemon was stopped and has started again", crash: "The daemon quit unexpectedly and has started again", dev: "The development daemon has restarted" }[input.cause]
    : { clean: "守护进程停下后重新启动了", crash: "守护进程意外退出后重新启动了", dev: "开发版守护进程重新启动了" }[input.cause];
  const what = input.plan ? (en ? `the plan "${input.plan}" was cut off` : `「${input.plan}」这件事中断了`) : en ? "the work here was cut off" : "这里的工作中断了";
  const turns = input.turns.map((line) => turnLine(locale, line)).join(en ? "; " : "；");
  const groups = new Map<RestartArrangement | null, string[]>();
  for (const line of input.turns) {
    const key = line.arrangement ?? null;
    groups.set(key, [...(groups.get(key) ?? []), line.bot ?? (en ? "the Bot" : "这个 Bot")]);
  }
  const next = groups.size <= 1
    ? arrangementLine(locale, [...groups.keys()][0] ?? null)
    : [...groups].map(([arrangement, bots]) => `${joinList(locale, bots)}${en ? ": " : "："}${arrangementLine(locale, arrangement)}`).join("\n");
  return en ? `${why}; ${what}: ${turns}.\n${next}` : `${why}，${what}：${turns}。\n${next}`;
}

/**
 * The supervisor's line about a job it will not move on its own any more (ADR 0045), in a
 * conversation you are in: a ticket it called back twice with no progress since (`stalled`), work it
 * picked up three times within the hour (`retry_budget`), or work whose last external call has no
 * known outcome (`unknown_effect`). Facts only, then what you can do.
 */
/**
 * The line a job gets when a Bot ended its segment twice in a row with no progress and work still
 * open (ADR 0044's end contract): the job waits for you as blocked. `job` names it as the
 * supervisor's lines do (任务 03《…》 or 规划「…」).
 */
export function noProgressNoticeBody(locale: Locale, input: { job: string; bot: string }): string {
  return locale === "en"
    ? `${input.job}: ${input.bot} ended twice in a row without progress and there is still work open on it, so it waits for you. Say how to go on, or @ ${input.bot}.`
    : `${input.job}：${input.bot}连续两次结束都没有进展，还有没做完的事，先停下等你。说一句接下来怎么做，或者 @ ${input.bot}。`;
}

/**
 * The line a job gets when a Bot said the work is still going and then ended its segment anyway,
 * after the end contract's one bounce (ADR 0044): nothing open wakes it, so without this line the
 * conversation would read as work under way. `job` is null for a desk conversation with no plan.
 */
export function promisedLaterNoticeBody(locale: Locale, input: { job: string | null; bot: string; said: string }): string {
  const head = input.job ? (locale === "en" ? `${input.job}: ` : `${input.job}：`) : "";
  return locale === "en"
    ? `${head}${input.bot} said "${input.said}", but its turn has ended and nobody is carrying on with it. To have it go on, @ ${input.bot}.`
    : `${head}${input.bot}说「${input.said}」，但这一轮已经结束了，没有人接着做。要它继续，@ ${input.bot}。`;
}

/**
 * The line your direct gets when a Bot ended the segment your line opened without a word to you, after
 * the end contract's one bounce (ADR 0044): without it the line would just sit there unanswered.
 */
export function saidNothingNoticeBody(locale: Locale, input: { bot: string }): string {
  return locale === "en"
    ? `${input.bot} ended its turn without replying to you. Say it again to have it answer.`
    : `${input.bot}这一轮没有回复你就结束了。要它回答，再说一次。`;
}

export function supervisorNoticeBody(
  locale: Locale,
  input: {
    code: "stalled" | "retry_budget" | "unknown_effect";
    /** The job as the line names it: 任务 03《…》 or 规划「…」. */
    job: string;
    bot: string;
    /** `stalled`: how many times it was called back. `retry_budget`: how many times it picked up. */
    count?: number;
    /** `unknown_effect`: the call whose outcome is unknown. */
    tool?: string | null;
  },
): string {
  const en = locale === "en";
  switch (input.code) {
    case "stalled":
      return en
        ? `This has stopped: ${input.job} — ${input.bot} was called back ${input.count ?? 2} times and nothing moved since (no stage change, delivery, first passing check or new artifact). To carry on, @ ${input.bot} or whoever should pick it up, or change the ticket on the flow board.`
        : `这件事停下了：${input.job}已经叫醒${input.bot} ${input.count ?? 2} 次，之后没有新的进展（阶段变化、交付、第一次通过的检查或新产物都没有）。要继续就 @ ${input.bot}或该接手的 Bot，或者在流程图里改这张任务。`;
    case "retry_budget":
      return en
        ? `${input.job} was picked up again ${input.count ?? 3} times within the hour and still did not get going, so it is not picked up automatically any more. To carry on, press Continue on its last segment, or @ ${input.bot}.`
        : `${input.job}一小时内已经自动接着做了 ${input.count ?? 3} 次，还是没接上，不再自动接着做。要继续就点那一段的「继续」，或者 @ ${input.bot}。`;
    case "unknown_effect":
      return en
        ? `${input.job}: the last external call of ${input.bot}'s segment${input.tool ? ` (${input.tool})` : ""} has no known outcome, so it is not picked up automatically, to avoid submitting it twice. Check whether that step went through, then press Continue on that segment, or @ ${input.bot}.`
        : `${input.job}：${input.bot}上一段的外部调用${input.tool ? `（${input.tool}）` : ""}结果不明，为免重复提交不自动接着做。先确认那一步有没有生效，再点那一段的「继续」，或者 @ ${input.bot}。`;
  }
}
