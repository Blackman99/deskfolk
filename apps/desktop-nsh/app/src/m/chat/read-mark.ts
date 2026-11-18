import { USER_MEMBER } from "@real-bot/protocol";
import type { TranscriptItem } from "./transcript.ts";

/**
 * Which message the "New" line goes above: the first one someone else wrote after you last read
 * this conversation, as things stood when you opened it.
 *
 * Settled once per opening. Messages that come in while you are looking at the conversation are
 * read as they arrive and draw no line; a conversation with nothing unread when opened has none.
 * It is called from a `$derived`, so it may run more than once for the same transcript.
 */
export class ReadMark {
  #session: string | null = null;
  #since: string | null = null;
  #settled = false;
  #id: string | null = null;

  observe(sessionId: string | null, lastReadAt: string | null | undefined, items: readonly TranscriptItem[]): string | null {
    if (sessionId !== this.#session) {
      this.#session = sessionId;
      this.#since = lastReadAt ?? null;
      this.#settled = false;
      this.#id = null;
    }
    if (!this.#settled && items.length > 0) {
      this.#settled = true;
      const since = this.#since;
      if (since) {
        for (const item of items) {
          if (item.type !== "message") continue;
          const message = item.message;
          if (message.author !== USER_MEMBER && message.kind !== "system" && message.created_at > since) {
            this.#id = message.id;
            break;
          }
        }
      }
    }
    return this.#id;
  }
}
