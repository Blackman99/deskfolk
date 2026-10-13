import type { TranscriptItem } from "./transcript.ts";
import { transcriptItemKey } from "./transcript.ts";

/** How long a row counts as arriving: its entrance animation, with room to spare. */
export const ARRIVAL_MS = 700;

/**
 * Which rows of a conversation have just arrived, so only those rise into place.
 *
 * Nothing that was already there animates: not the history a conversation opens on, not the
 * earlier messages "Load earlier" brings in above it, and not a Bot's reply replacing the working
 * bubble that was already showing it. What is left is what the eye should catch: a new line, a
 * new reply, a working bubble starting.
 *
 * It is called from a `$derived`, so it may run more than once for the same transcript; it gives
 * the same answer each time until a row's arrival has had time to play.
 */
export class ArrivalTracker {
  #session: string | null = null;
  /** Rows that were there before, or have finished arriving. */
  #known = new Set<string>();
  /** Rows arriving now, until their animation has had time to finish. */
  #arriving = new Set<string>();
  /** Turns whose working bubble was on screen: their reply is not new to the eye. */
  #streamed = new Set<string>();
  /** The newest message seen; anything older is history coming in above. */
  #newest = "";
  #schedule: (fn: () => void, ms: number) => void;

  constructor(schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms)) {
    this.#schedule = schedule;
  }

  /** The keys (`transcriptItemKey`) of the rows arriving in this transcript. */
  observe(sessionId: string | null, items: readonly TranscriptItem[]): ReadonlySet<string> {
    if (sessionId !== this.#session || (this.#known.size === 0 && this.#arriving.size === 0)) {
      this.#session = sessionId;
      this.#baseline(items);
      return new Set();
    }
    for (const item of items) {
      const key = transcriptItemKey(item);
      if (item.type === "streaming") this.#streamed.add(item.turn.id);
      if (this.#known.has(key) || this.#arriving.has(key)) continue;
      if (item.type === "replying") {
        this.#known.add(key);
        continue;
      }
      if (item.type === "message") {
        const message = item.message;
        const older = message.created_at < this.#newest;
        const wasStreaming = Boolean(message.turn_id && this.#streamed.has(message.turn_id));
        if (message.created_at > this.#newest) this.#newest = message.created_at;
        if (older || wasStreaming) {
          this.#known.add(key);
          continue;
        }
      }
      this.#arrive(key);
    }
    // A fresh set each time, so whatever reads it sees the change.
    return new Set(this.#arriving);
  }

  #baseline(items: readonly TranscriptItem[]): void {
    this.#known = new Set();
    this.#arriving = new Set();
    this.#streamed = new Set();
    this.#newest = "";
    for (const item of items) {
      this.#known.add(transcriptItemKey(item));
      if (item.type === "streaming") this.#streamed.add(item.turn.id);
      if (item.type === "message" && item.message.created_at > this.#newest) this.#newest = item.message.created_at;
    }
  }

  #arrive(key: string): void {
    this.#arriving.add(key);
    const session = this.#session;
    this.#schedule(() => {
      if (this.#session !== session) return;
      this.#arriving.delete(key);
      this.#known.add(key);
    }, ARRIVAL_MS);
  }
}
