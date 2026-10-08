/** The digest of a Bot's memories that opens its turn. */
import type { Locale } from "@real-bot/protocol";
import type { MemoryPromptEntry } from "../prompts";
import type { Store } from "../store";
import { codePointCount } from "../text";

/**
 * A backstop, not a working limit: the per-Bot cap's worst case already fits under it, so a Bot
 * always sees every memory it wrote. It only bites if someone raises the per-Bot cap or the body
 * cap without redoing the arithmetic — exactly when a silent trim beats a blown context. The
 * derivation is pinned by a test, which is why the cost is a shared function and not a literal.
 */
export const MEMORY_DIGEST_LIMIT = 4_600;
/** Longest an age label gets ("10 个月前" / "10mo ago"), with room to spare. */
export const MEMORY_AGE_MAX = 12;

/** What one rendered entry costs against the budget: the text plus its `##` and blank lines. */
export function memoryEntryCost(subject: string, body: string, age: string): number {
  return codePointCount(subject) + codePointCount(body) + codePointCount(age) + 11;
}

/**
 * How old a memory reads in the prompt, counted from when it was last written: a conclusion
 * rewritten today is today's. Bucketed rather than dated: an ISO timestamp would change the system
 * text every day and cost the prefix cache for no gain, and the Bot only has to know whether a
 * conclusion is fresh or stale. The messenger shows the same buckets.
 */
export function memoryAgeLabel(locale: Locale, writtenAt: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(writtenAt).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return locale === "en" ? "today" : "今天";
  if (days < 7) return locale === "en" ? "this week" : "本周";
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return locale === "en" ? `${weeks}w ago` : `${weeks} 周前`;
  const months = Math.floor(days / 30);
  return locale === "en" ? `${months}mo ago` : `${months} 个月前`;
}

/**
 * Two passes on purpose. The cut takes newest-written first, so when the budget ever bites it is
 * the stalest conclusion that falls out. The survivors then render oldest-written first: a new
 * memory lands at the end, where it costs the prefix cache least, and when two say different
 * things about the same matter the Bot can see which one is newer.
 */
export function memoryDigest(store: Store, botId: string, locale: Locale, now: Date = new Date()): MemoryPromptEntry[] {
  const kept: MemoryPromptEntry[] = [];
  let used = 0;
  for (const memory of store.listEnabledMemories(botId)) {
    const age = memoryAgeLabel(locale, memory.updated_at, now);
    const cost = memoryEntryCost(memory.subject, memory.body, age);
    if (used + cost > MEMORY_DIGEST_LIMIT) break;
    used += cost;
    kept.push({ subject: memory.subject, body: memory.body, age });
  }
  return kept.reverse();
}
