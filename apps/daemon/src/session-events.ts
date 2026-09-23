import { randomBytes } from "node:crypto";
import type { CatchupResponse, ClientEvent, EventCursor, SequencedEvent, SyncFrame } from "@real-bot/protocol";
import { displayAvatar } from "./avatar-display";

export const EVENT_RING_COUNT = 2000;
export const EVENT_RING_BYTES = 16 * 1024 * 1024;

/** All methods are synchronous: no commit, publish or snapshot can yield inside this barrier. */
export class EventStream {
  private instance = randomBytes(16).toString("hex");
  private seq = 0;
  private bytes = 0;
  private ring: { frame: SequencedEvent; bytes: number }[] = [];
  private readonly listeners = new Set<(frame: SyncFrame) => void>();

  constructor(private readonly limits = { count: EVENT_RING_COUNT, bytes: EVENT_RING_BYTES }) {}

  cursor(): EventCursor {
    return { event_instance_id: this.instance, watermark_seq: this.seq };
  }

  subscribe(listener: (frame: SyncFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(frame: SyncFrame): void {
    for (const listener of this.listeners) listener(frame);
  }

  publish(payload: ClientEvent): void {
    if (payload.event === "turn.token" || payload.event === "turn.tool") return;
    // Every sequenced portrait passes here — live, replayed from the journal, caught up — so this
    // is the one place it becomes the small marked copy clients are sent.
    if (payload.event === "bot.upsert") payload = { ...payload, avatar: displayAvatar(payload.avatar) };
    let frame: SequencedEvent = {
      type: "event", event_instance_id: this.instance, seq: this.seq + 1, payload,
    };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (this.ring.length >= this.limits.count || this.bytes + bytes > this.limits.bytes || this.seq === Number.MAX_SAFE_INTEGER) {
      this.instance = randomBytes(16).toString("hex");
      this.seq = 0;
      this.bytes = 0;
      this.ring = [];
      this.send({ type: "resnapshot", ...this.cursor() });
      frame = { ...frame, event_instance_id: this.instance, seq: 1 };
    }
    if (bytes > this.limits.bytes) return;
    this.seq = frame.seq;
    this.bytes += bytes;
    this.ring.push({ frame, bytes });
    this.send(frame);
  }

  catchup(cursor: EventCursor): CatchupResponse {
    const resnapshot = cursor.event_instance_id !== this.instance ||
      !Number.isSafeInteger(cursor.watermark_seq) || cursor.watermark_seq < 0 || cursor.watermark_seq > this.seq;
    return {
      ...this.cursor(), resnapshot,
      events: resnapshot ? [] : this.ring.filter(({ frame }) => frame.seq > cursor.watermark_seq).map(({ frame }) => frame),
    };
  }
}

export type SessionUpsertInput = {
  id: string;
  kind: "direct" | "group";
  name: string | null;
  last_read_at?: string | null;
  archived_at?: string | null;
  origin_session_id: string | null;
  origin_message_id: string | null;
  created_at: string;
  updated_at: string;
  participants: { member: string; joined_at: string; left_at: string | null }[];
  unread_count?: number;
};

/** Legacy publishers share these fields so archive state and direct origins cannot drift. */
export function sessionUpsertFields(session: SessionUpsertInput) {
  return {
    id: session.id,
    kind: session.kind,
    name: session.name,
    last_read_at: session.last_read_at ?? null,
    archived_at: session.archived_at ?? null,
    origin_session_id: session.origin_session_id,
    origin_message_id: session.origin_message_id,
    created_at: session.created_at,
    updated_at: session.updated_at,
    participants: session.participants,
    unread_count: session.unread_count ?? 0,
  };
}
