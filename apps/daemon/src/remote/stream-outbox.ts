import type { StreamRead } from "../streams";

/** One frame's worth of a stream: where it starts, what it carries, and what fell out before it. */
export type OutboxFrame = { offset: number; bytes: Uint8Array; skipped: number; closed: boolean };

const EMPTY = new Uint8Array(0);

/**
 * One device's copy of one output stream, on its way over the link.
 *
 * The link paces what it sends, because the relay cuts a device off once 64 KiB wait for it and
 * the Mac cannot see how fast the phone's radio is draining. What arrives faster than that pace
 * waits here and goes out in the windows after, so a burst — a full-screen program redrawing a
 * few times in a row, a long `ls` — arrives whole, a little later. Only output that outruns the
 * pace for longer than the backlog lasts loses its oldest bytes, counted as skipped, as the
 * daemon's own ring does.
 *
 * Everything here is by byte offset, so a frame's offset always names its first byte. A read
 * that repeats bytes already taken is cut to what is new — the backlog a second watcher is
 * handed can reach here too — and one that starts past them is a hole, reported as skipped.
 */
export class StreamOutbox {
  private chunks: Uint8Array[] = [];
  private held = 0;
  /** Offset of the first byte held. */
  private start = 0;
  /** Just past the last byte taken in, sent or not; null until the first read. */
  private end: number | null = null;
  private skipped = 0;
  private closed = false;
  private closeSent = false;

  constructor(private readonly backlog: number) {}

  push(read: StreamRead): void {
    if (this.closeSent) return;
    if (this.end === null) {
      this.start = this.end = read.offset;
      this.skipped = read.skipped;
    }
    let bytes = read.bytes;
    if (read.offset > this.end) {
      // What is held comes before the hole, and the frame it would go in cannot say so: it goes
      // with what the hole took.
      this.skipped += this.held + (read.offset - this.end);
      this.chunks = [];
      this.held = 0;
      this.start = this.end = read.offset;
    } else if (read.offset < this.end) {
      const repeated = this.end - read.offset;
      bytes = repeated >= bytes.length ? EMPTY : bytes.subarray(repeated);
    }
    if (bytes.length) {
      this.chunks.push(bytes);
      this.held += bytes.length;
      this.end += bytes.length;
      this.trim();
    }
    if (read.closed) this.closed = true;
  }

  /** Whether a frame is waiting to go. */
  get pending(): boolean {
    return this.held > 0 || this.skipped > 0 || (this.closed && !this.closeSent);
  }

  /** The stream is over and the device has been told; nothing more will come for it. */
  get done(): boolean {
    return this.closeSent;
  }

  /** The next frame, at most `max` bytes, oldest first. Null when there is nothing to send. */
  take(max: number): OutboxFrame | null {
    if (!this.pending) return null;
    const size = Math.min(max, this.held);
    const bytes = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const head = this.chunks[0]!;
      const part = Math.min(head.length, size - filled);
      bytes.set(head.subarray(0, part), filled);
      filled += part;
      if (part === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(part);
    }
    const frame: OutboxFrame = {
      offset: this.start,
      bytes,
      skipped: this.skipped,
      closed: this.closed && this.held === size,
    };
    this.start += size;
    this.held -= size;
    this.skipped = 0;
    if (frame.closed) this.closeSent = true;
    return frame;
  }

  private trim(): void {
    while (this.held > this.backlog) {
      const head = this.chunks[0]!;
      const excess = this.held - this.backlog;
      const cut = Math.min(excess, head.length);
      if (cut === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(cut);
      this.held -= cut;
      this.start += cut;
      this.skipped += cut;
    }
  }
}
