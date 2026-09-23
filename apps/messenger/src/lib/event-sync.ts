import type { EventCursor, SequencedEvent, SyncFrame } from "@real-bot/protocol";

const MAX_BUFFER_COUNT = 2000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const MAX_NOTIFICATION_TAIL = 256;

export type NotificationReplay =
  | { complete: true; frames: SequencedEvent[] }
  | { complete: false; frames: []; reason: "invalid" | "instance" | "truncated" };

function isNotificationFrame(frame: SequencedEvent): boolean {
  const event = frame.payload.event;
  return event === "notification.upsert" || event === "notification.removed" || event === "notification.summary";
}

/** One buffer spans subscription, the HTTP snapshot and any session-detail read. */
export class EventSync {
  private cursor: EventCursor | null = null;
  private buffer: SequencedEvent[] = [];
  private bytes = 0;
  private buffering = true;
  private invalid = false;
  private waiter: { cursor: EventCursor; resolve: (ready: boolean) => void } | null = null;
  private notificationTail: SequencedEvent[] = [];
  /** Highest seq dropped from the tail by overflow; null if nothing has been shifted. */
  private droppedThrough: number | null = null;

  /** HTTP can overtake WebSocket; install detail only after its global prefix has arrived. */
  waitThrough(cursor: EventCursor): Promise<boolean> {
    return new Promise((resolve) => {
      this.waiter = { cursor, resolve };
      this.wake();
    });
  }

  close(): void {
    this.invalid = true;
    this.buffer = [];
    this.notificationTail = [];
    this.droppedThrough = null;
    this.cursor = null;
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiter;
    if (!waiting) return;
    const valid = !this.invalid && this.cursor?.event_instance_id === waiting.cursor.event_instance_id;
    const received = Math.max(this.cursor?.watermark_seq ?? 0, this.buffer.at(-1)?.seq ?? 0);
    if (!valid || received >= waiting.cursor.watermark_seq) {
      this.waiter = null;
      waiting.resolve(valid);
    }
  }

  pause(): void {
    this.buffering = true;
  }

  receive(frame: SyncFrame): SequencedEvent[] | null {
    if (frame.type === "resnapshot") {
      this.close();
      return null;
    }
    if (frame.type === "ready") return [];
    if (this.invalid) return null;
    if (this.cursor && frame.event_instance_id !== this.cursor.event_instance_id) {
      this.close();
      return null;
    }
    if (this.buffering) {
      this.bytes += new TextEncoder().encode(JSON.stringify(frame)).length;
      if (this.buffer.length >= MAX_BUFFER_COUNT || this.bytes > MAX_BUFFER_BYTES) {
        this.close();
        return null;
      }
      this.buffer.push(frame);
      if (frame.type === "event") this.rememberNotification(frame);
      this.wake();
      return [];
    }
    const advanced = this.advance(frame);
    if (!advanced) {
      this.close();
      return null;
    }
    return advanced;
  }

  snapshotCursor(): EventCursor | null {
    return this.cursor
      ? { event_instance_id: this.cursor.event_instance_id, watermark_seq: this.cursor.watermark_seq }
      : null;
  }

  /**
   * Notification frames with seq > cursor. Complete only when this instance is valid and every
   * needed notification after the page is still in the tail. Unrelated dropped frames do not
   * invalidate if the remaining floor still covers the page.
   */
  notificationEventsAfter(cursor: EventCursor): NotificationReplay {
    if (this.invalid) return { complete: false, frames: [], reason: "invalid" };
    if (!this.cursor || this.cursor.event_instance_id !== cursor.event_instance_id) {
      return { complete: false, frames: [], reason: "instance" };
    }
    if (this.droppedThrough != null && this.droppedThrough > cursor.watermark_seq) {
      return { complete: false, frames: [], reason: "truncated" };
    }
    return {
      complete: true,
      frames: this.notificationTail.filter((frame) => frame.seq > cursor.watermark_seq),
    };
  }

  /**
   * Install from a cursor the page already applied plus the frames it missed, in place of a
   * snapshot: what a phone does when it comes back to the Mac it left. Everything — the missed
   * frames, then what the new link buffered — must continue that cursor without a gap. When it
   * does not, nothing changes and null says to take the snapshot instead.
   */
  resume(cursor: EventCursor, missed: SequencedEvent[]): SequencedEvent[] | null {
    if (this.invalid) return null;
    const frames = [...missed, ...this.buffer];
    let seq = cursor.watermark_seq;
    for (const frame of frames) {
      if (frame.event_instance_id !== cursor.event_instance_id) return null;
      if (frame.seq <= seq) continue;
      if (frame.seq !== seq + 1) return null;
      seq = frame.seq;
    }
    this.notificationTail = [];
    this.droppedThrough = null;
    this.cursor = { event_instance_id: cursor.event_instance_id, watermark_seq: cursor.watermark_seq };
    this.buffering = false;
    this.buffer = [];
    this.bytes = 0;
    const accepted: SequencedEvent[] = [];
    for (const frame of frames) accepted.push(...(this.advance(frame) ?? []));
    return accepted;
  }

  install(cursor?: EventCursor): SequencedEvent[] | null {
    if (this.invalid) return null;
    if (cursor) {
      if (this.cursor?.event_instance_id !== cursor.event_instance_id) {
        this.notificationTail = [];
        this.droppedThrough = null;
      } else {
        this.notificationTail = this.notificationTail.filter((frame) => frame.seq > cursor.watermark_seq);
        if (this.droppedThrough != null && this.droppedThrough <= cursor.watermark_seq) this.droppedThrough = null;
      }
      this.cursor = { event_instance_id: cursor.event_instance_id, watermark_seq: cursor.watermark_seq };
    }
    this.buffering = false;
    const pending = this.buffer;
    this.buffer = [];
    this.bytes = 0;
    const accepted: SequencedEvent[] = [];
    for (const frame of pending) {
      const next = this.advance(frame);
      if (!next) {
        this.close();
        return null;
      }
      accepted.push(...next);
    }
    return accepted;
  }

  private advance(frame: SequencedEvent): SequencedEvent[] | null {
    if (!this.cursor || frame.event_instance_id !== this.cursor.event_instance_id) return null;
    if (frame.seq <= this.cursor.watermark_seq) return [];
    if (frame.seq !== this.cursor.watermark_seq + 1) return null;
    this.cursor.watermark_seq = frame.seq;
    this.rememberNotification(frame);
    return [frame];
  }

  private rememberNotification(frame: SequencedEvent): void {
    if (!isNotificationFrame(frame)) return;
    if (this.notificationTail.some((row) => row.seq === frame.seq)) return;
    this.notificationTail.push(frame);
    this.notificationTail.sort((a, b) => a.seq - b.seq);
    while (this.notificationTail.length > MAX_NOTIFICATION_TAIL) {
      const dropped = this.notificationTail.shift();
      if (dropped) this.droppedThrough = dropped.seq;
    }
  }
}
