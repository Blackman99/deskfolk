/**
 * 进度询问: a user line that is only asking where a job stands ("怎么样了", "how's it going") and
 * nothing else. Pure text matching — no store, no model call — so `turn-engine.ts` can check it
 * before doing anything a real message would trigger (organizing, judging, waking a turn).
 *
 * Deliberately conservative: a false negative just takes the normal path (the organizer and
 * participation answer as they always have); a false positive would answer a real request with a
 * status recap instead of doing it, which is the worse mistake. So this only matches a short,
 * closed set of zh/en phrasings, and anything that reads as an instruction (继续/重做/改/删/加快/做/
 * 请…) simply fails to match rather than being special-cased out — the whole trimmed body has to be
 * one of these phrasings, nothing more.
 */
import type { Message } from "@real-bot/protocol";
import { codePointCount } from "./text";

/** A status line reads badly past this; a real request is almost never this short anyway. */
const MAX_CODE_POINTS = 24;

// Optional lead-in, then a closed set of "how's it going" idioms, then optional trailing
// punctuation. `进行的|进行得` only ever precedes 怎么样了/如何了/咋样了, but folding it into one
// shared prefix group costs nothing: no real message matches the other combinations by accident.
const ZH_HOW_IS_IT = new RegExp(
  "^(?:现在|目前|这件事|进度|进展|进行的|进行得)?" +
    "(?:怎么样了|如何了|咋样了|好了吗|做完了吗|完成了吗|到哪了|到哪一步了|" +
    "进度呢|进展呢|成片呢|结果呢|还在做吗|在做吗)" +
    "[？?。！]?$",
);

// Bare "进度" / "进展", alone or with a trailing particle — asked with nothing else said.
const ZH_BARE_PROGRESS = /^(?:进度|进展)(?:呢|啊)?[？?。！]?$/;

const EN_HOW_IS_IT = /^(?:how'?s it going|how is it going|any updates?|status(?: update)?|progress|done yet|is it done)[?!.]*$/i;

/** The fields `isStatusQuestion` reads; a real `Message` satisfies this, and a test can build less. */
export type StatusQuestionCandidate = Pick<
  Message,
  "kind" | "body" | "parent_id" | "attachments" | "annotation_source_message_id"
>;

/**
 * Whether `message` is only a status question: nothing to detect against but its own body — a
 * quote-reply, an @mention, an attachment or an annotation batch all mean the line is about
 * something specific, so those take the normal path even when the words would otherwise match.
 */
export function isStatusQuestion(message: StatusQuestionCandidate): boolean {
  if (message.kind !== "user") return false;
  if (message.attachments.length > 0) return false;
  if (message.annotation_source_message_id) return false;
  if (message.parent_id) return false;
  const trimmed = message.body.trim();
  if (!trimmed) return false;
  if (codePointCount(trimmed) > MAX_CODE_POINTS) return false;
  // A line naming a Bot is for that Bot: `@视频导演 怎么样了` takes the normal path.
  if (trimmed.includes("@")) return false;
  return ZH_HOW_IS_IT.test(trimmed) || ZH_BARE_PROGRESS.test(trimmed) || EN_HOW_IS_IT.test(trimmed);
}
