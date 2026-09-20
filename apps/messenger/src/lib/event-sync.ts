import type { EventCursor, SequencedEvent, SyncFrame } from "@real-bot/protocol";

const MAX_BUFFER_COUNT = 2000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** One buffer spans subscription, the HTTP snapshot and any session-detail read. */
export class EventSync {
  private cursor: EventCursor | null = null;
  private buffer: SequencedEvent[] = [];
  private bytes = 0;
  private buffering = true;
  private invalid = false;

  matches(cursor: EventCursor): boolean {
    return this.cursor?.event_instance_id === cursor.event_instance_id;
  }

  pause(): void {
    this.buffering = true;
  }

  receive(frame: SyncFrame): SequencedEvent[] | null {
    if (frame.type === "resnapshot") {
      this.invalid = true;
      return null;
    }
    if (frame.type === "ready") return [];
    if (this.invalid) return null;
    if (this.buffering) {
      this.bytes += new TextEncoder().encode(JSON.stringify(frame)).length;
      if (this.buffer.length >= MAX_BUFFER_COUNT || this.bytes > MAX_BUFFER_BYTES) {
        this.invalid = true;
        this.buffer = [];
        return null;
      }
      this.buffer.push(frame);
      return [];
    }
    return this.advance(frame);
  }

  install(cursor?: EventCursor): SequencedEvent[] | null {
    if (this.invalid) return null;
    if (cursor) this.cursor = { event_instance_id: cursor.event_instance_id, watermark_seq: cursor.watermark_seq };
    this.buffering = false;
    const pending = this.buffer;
    this.buffer = [];
    this.bytes = 0;
    const accepted: SequencedEvent[] = [];
    for (const frame of pending) {
      const next = this.advance(frame);
      if (!next) return null;
      accepted.push(...next);
    }
    return accepted;
  }

  private advance(frame: SequencedEvent): SequencedEvent[] | null {
    if (!this.cursor || frame.event_instance_id !== this.cursor.event_instance_id) return null;
    if (frame.seq <= this.cursor.watermark_seq) return [];
    if (frame.seq !== this.cursor.watermark_seq + 1) return null;
    this.cursor.watermark_seq = frame.seq;
    return [frame];
  }
}
