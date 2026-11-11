/** The composer box's pure parts: who the @ list offers, where the caret is after an edit, how tall the box is. */
import type { Bot } from "@real-bot/protocol";
import type { MentionCandidate } from "../../m/chat/composer-mentions.svelte";

/**
 * Who an `@query` offers, as `ComposerMentions.mentionCandidates` does: in a group `everyone` leads
 * when it fits, then the Bots (the ones present) whose name or duties contain the query; in a
 * direct, any Bot you can write to. `everyoneNote` is the line under `@everyone`.
 */
export function mentionCandidatesFor(input: { query: string; isGroup: boolean; bots: readonly Bot[]; everyoneNote: string }): MentionCandidate[] {
  const q = input.query.toLowerCase();
  const out: MentionCandidate[] = [];
  if (input.isGroup && "everyone".includes(q)) {
    out.push({ id: "everyone", name: "everyone", isEveryone: true, duties: input.everyoneNote });
  }
  for (const b of input.bots) {
    if (b.name.toLowerCase().includes(q) || (b.duties && b.duties.toLowerCase().includes(q))) {
      out.push({ id: b.id, name: b.name, isEveryone: false, avatar: b.avatar, duties: b.duties });
    }
  }
  return out;
}

/**
 * Where the caret is after the text went from `prev` to `next`, for an edit at one place (typing,
 * a deletion, a paste): the end of what was inserted. The input's own selection event corrects it
 * when it comes; this keeps the @ and / lists right in the moment between.
 */
export function caretAfterEdit(prev: string, next: string): number {
  let head = 0;
  const max = Math.min(prev.length, next.length);
  while (head < max && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < max - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  return next.length - tail;
}

/** The box's height for a text `content` tall (points): 6pt of padding above and below, between the min and the max (`.composer-input`'s 34 / 180; a phone's 40 and min(120, a quarter of the window)). */
export function boxHeight(content: number, phone: boolean, windowHeight: number): number {
  const min = phone ? 40 : 34;
  const max = phone ? Math.min(120, windowHeight * 0.25) : 180;
  return Math.round(Math.max(min, Math.min(max, content + (phone ? 18 : 12))));
}
