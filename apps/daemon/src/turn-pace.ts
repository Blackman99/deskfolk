/**
 * How long a turn may keep calling tools before it has to say where it stands.
 *
 * A turn loops until the model answers without a tool call, and nothing else ended it: on
 * 2026-09-25 a Bot spent 99 hops and an hour re-encoding one picture into ever smaller base64
 * for a tool that could not take it, sending nothing, each hop re-reading a context that had
 * grown to 140k tokens. Real work runs long too — a video Bot polling its jobs finished at 141
 * hops — so the limit is set past that, and the turns in between are asked, every so often,
 * whether they are getting anywhere.
 */
import type { Locale } from "@real-bot/protocol";

/** Every this many hops the loop asks whether the turn is getting anywhere. */
export const TURN_CHECK_IN_HOPS = 40;
/** Past this many hops the tools are taken away and the next reply is the turn's last. */
export const TURN_HOP_LIMIT = 160;

export type TurnPace = "go" | "check_in" | "last";

/**
 * What the hop about to start (1-based) is. The note for a check-in or the last hop goes in as a
 * user line after the previous hop's tool results, the way a closing check's note does.
 */
export function turnPace(hop: number): TurnPace {
  if (hop > TURN_HOP_LIMIT) return "last";
  if (hop > 1 && (hop - 1) % TURN_CHECK_IN_HOPS === 0) return "check_in";
  return "go";
}

/**
 * Why a check-in does not ask for a progress message: a hop that sends one ends the turn. So the
 * choice it offers is to stop and say so, or to carry on without answering it.
 */
export function checkInNote(locale: Locale, hops: number): string {
  return locale === "en"
    ? `(App note) This turn has made ${hops} tool calls in a row without handing anything back. If you are stuck, going in circles, or waiting on something a tool cannot give you, stop now: reply directly, without a tool call, saying what is done, where it is stuck and what you need from whom. If you are genuinely making progress, carry on and do not answer this note. At ${TURN_HOP_LIMIT} the tools are taken away.`
    : `（应用提示）这一轮已经连续调用工具 ${hops} 跳，还没有交出任何结果。如果卡住了、在绕圈，或者在等工具给不了的东西，现在就停下：不要再调工具，直接回复做完了什么、卡在哪、需要谁做什么。如果确实在推进，就继续做，不用回应这条。到 ${TURN_HOP_LIMIT} 跳会收起工具。`;
}

/**
 * An empty answer — no words, no tool call — is the model dropping the thread, not a choice to
 * stay quiet: a Bot with nothing to add says so, and that closer is dropped anyway. On 2026-09-28
 * Gemini through an OpenAI-compatible proxy ended two turns in a row that way (a normal stop, zero
 * output tokens) right after reading the sources, so the report was never written and each turn
 * completed with nothing to show. The loop asks once for the next step instead.
 */
export function emptyReplyNote(locale: Locale): string {
  return locale === "en"
    ? "(App note) Your last reply was empty: no text and no tool call. The job is not accounted for yet. Carry on with the next step (write the files that are due), or reply directly with what is done and where it is stuck. If there is really nothing for you to add, reply 'no new work'."
    : "（应用提示）你刚才的回复是空的：没有文字，也没有调用工具。这件事还没交代完：接着做下一步（该写的文件写出来），或者直接回复做完了什么、卡在哪。确实没有要补充的，就回复「无新工作」。";
}

/**
 * What comes before a note that sends an ending back once the closing reply it was weighed on has
 * already gone out: the Bot otherwise reads the bounce as a reply refused, and either says it again or
 * takes the next step for the reply (2026-10-07: a withheld answer, then a submit that ended in silence).
 */
export function replyOutNote(locale: Locale, note: string): string {
  return locale === "en"
    ? `(App note) Your reply has gone out to the conversation as written; do not say it again. What follows is about the work, not the reply. ${note}`
    : `（应用提示）你的回复已经原样发出，不要再说一遍。下面说的是这件事的活，不是回复：${note}`;
}

export function lastHopNote(locale: Locale): string {
  return locale === "en"
    ? `(App note) This turn has reached ${TURN_HOP_LIMIT} tool calls and its tools have been taken away. Reply now, directly: what is done, what is not, where it is stuck and what you need from whom to finish. This reply ends the turn.`
    : `（应用提示）这一轮已经到了 ${TURN_HOP_LIMIT} 跳上限，工具已收起。现在直接回复：做完了什么、还差什么、卡在哪、要做完需要谁做什么。这条回复就是这一轮的结尾。`;
}
