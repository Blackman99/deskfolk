/**
 * Live bytes that are worth watching while they happen and not worth keeping afterwards:
 * a terminal's output, and a Bot's `shell` while it runs.
 *
 * Deliberately **not** {@link EventStream}. That ring is 2000 frames / 16 MiB and an overflow
 * makes every client resnapshot; one `pnpm build` would blow through it and cost everyone a
 * full reload. Streams get their own ring per stream, their own cursor, no catch-up and no
 * place in the sequenced event protocol — the same standing as `turn.token`.
 *
 * The cursor is a **byte offset**, not a chunk number. Resuming is then exact no matter how the
 * bytes were split on the way out, so a transport is free to coalesce or re-chunk as it likes.
 */
export const TERMINAL_STREAM_BYTES = 256 * 1024;
export const COMMAND_STREAM_BYTES = 64 * 1024;

export type StreamRead = {
  /** Where these bytes start. Greater than the requested offset when the ring had dropped some. */
  offset: number;
  bytes: Uint8Array;
  /** Bytes that were dropped between the requested offset and {@link offset}. */
  skipped: number;
  /** Total bytes ever written, whether still retained or not. */
  end: number;
  closed: boolean;
};

export type StreamSink = (read: StreamRead) => void;

type Stream = {
  limit: number;
  chunks: Array<{ offset: number; bytes: Uint8Array }>;
  /** Offset of the oldest byte still retained. */
  first: number;
  /** Offset just past the newest byte ever written. */
  end: number;
  retained: number;
  closed: boolean;
  sinks: Set<StreamSink>;
};

export class StreamHub {
  private readonly streams = new Map<string, Stream>();

  open(id: string, limit = TERMINAL_STREAM_BYTES): void {
    if (this.streams.has(id)) return;
    this.streams.set(id, { limit, chunks: [], first: 0, end: 0, retained: 0, closed: false, sinks: new Set() });
  }

  has(id: string): boolean {
    return this.streams.has(id);
  }

  push(id: string, bytes: Uint8Array): void {
    const stream = this.streams.get(id);
    if (!stream || stream.closed || bytes.length === 0) return;
    const offset = stream.end;
    stream.chunks.push({ offset, bytes });
    stream.end += bytes.length;
    stream.retained += bytes.length;
    this.trim(stream);
    const read: StreamRead = { offset, bytes, skipped: 0, end: stream.end, closed: false };
    for (const sink of stream.sinks) sink(read);
  }

  /** The producer is done. Subscribers hear about it; the bytes stay readable until the stream is dropped. */
  close(id: string): void {
    const stream = this.streams.get(id);
    if (!stream || stream.closed) return;
    stream.closed = true;
    const read: StreamRead = { offset: stream.end, bytes: new Uint8Array(0), skipped: 0, end: stream.end, closed: true };
    for (const sink of stream.sinks) sink(read);
  }

  /** Forget it entirely. A subscriber that arrives afterwards reads an empty stream. */
  drop(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.sinks.clear();
    this.streams.delete(id);
  }

  /** Total bytes ever written, retained or not. Zero for a stream that is not open. */
  end(id: string): number {
    return this.streams.get(id)?.end ?? 0;
  }

  /** Everything retained from `from` onward, in one piece. */
  read(id: string, from = 0): StreamRead {
    const stream = this.streams.get(id);
    if (!stream) return { offset: from, bytes: new Uint8Array(0), skipped: 0, end: from, closed: true };
    const start = Math.max(from, stream.first);
    const size = stream.end - start;
    const bytes = new Uint8Array(Math.max(0, size));
    let filled = 0;
    for (const chunk of stream.chunks) {
      const chunkEnd = chunk.offset + chunk.bytes.length;
      if (chunkEnd <= start) continue;
      const skip = Math.max(0, start - chunk.offset);
      bytes.set(chunk.bytes.subarray(skip), filled);
      filled += chunk.bytes.length - skip;
    }
    return {
      offset: start,
      bytes: bytes.subarray(0, filled),
      skipped: Math.max(0, start - from),
      end: stream.end,
      closed: stream.closed,
    };
  }

  /**
   * Backlog and live delivery in one step: a two-call version would lose whatever arrived
   * between the read and the subscribe.
   */
  subscribe(id: string, from: number, sink: StreamSink): () => void {
    const stream = this.streams.get(id);
    if (!stream) {
      sink({ offset: from, bytes: new Uint8Array(0), skipped: 0, end: from, closed: true });
      return () => undefined;
    }
    const backlog = this.read(id, from);
    if (backlog.bytes.length || backlog.skipped) sink(backlog);
    if (stream.closed) {
      sink({ offset: stream.end, bytes: new Uint8Array(0), skipped: 0, end: stream.end, closed: true });
      return () => undefined;
    }
    stream.sinks.add(sink);
    return () => { stream.sinks.delete(sink); };
  }

  /** Streams still held, for diagnostics and for shutting the hub down. */
  ids(): string[] {
    return [...this.streams.keys()];
  }

  private trim(stream: Stream): void {
    while (stream.retained > stream.limit && stream.chunks.length) {
      const head = stream.chunks[0]!;
      const excess = stream.retained - stream.limit;
      if (head.bytes.length <= excess) {
        stream.chunks.shift();
        stream.retained -= head.bytes.length;
        stream.first = head.offset + head.bytes.length;
        continue;
      }
      // Trim inside the chunk rather than dropping it whole: the limit is a byte budget.
      stream.chunks[0] = { offset: head.offset + excess, bytes: head.bytes.subarray(excess) };
      stream.retained -= excess;
      stream.first = head.offset + excess;
    }
  }
}
