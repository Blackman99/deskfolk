import { base64url } from '@real-bot/remote';
import { LIMITS, requireValue } from './wire.ts';

type Mailbox = {
  expires: number; request?: Uint8Array; requestOffset: number; submitted: boolean;
  reply?: Uint8Array; replyOffset: number; delivered: boolean;
};
export class Mailboxes {
  private boxes = new Map<string, Mailbox>();
  open(id: string, expires: number, now: number): void {
    this.expire(now);
    requireValue(expires > now && expires <= now + LIMITS.mailboxTtlMs && !this.boxes.has(id) && this.boxes.size < LIMITS.mailboxes);
    this.boxes.set(id, { expires, requestOffset: 0, submitted: false, replyOffset: 0, delivered: false });
  }
  private get(id: string, now: number): Mailbox {
    const box = this.boxes.get(id);
    requireValue(box && box.expires > now);
    return box;
  }
  submit(id: string, bytes: Uint8Array, now: number): void {
    const box = this.get(id, now);
    requireValue(!box.submitted && bytes.length >= 40 && bytes.length <= LIMITS.mailbox);
    box.request = new Uint8Array(bytes); box.submitted = true;
  }
  readRequest(id: string, offset: number, now: number): { ciphertext: string; offset: number; total: number } | null {
    const box = this.get(id, now);
    if (!box.submitted) { requireValue(offset === 0); return null; }
    requireValue(box.request && offset === box.requestOffset);
    const total = box.request.length;
    const chunk = box.request.subarray(offset, offset + LIMITS.mailboxChunk);
    box.requestOffset += chunk.length;
    const result = { ciphertext: base64url(chunk), offset, total };
    if (box.requestOffset === total) { box.request.fill(0); box.request = undefined; }
    return result;
  }
  deliver(id: string, offset: number, total: number, bytes: Uint8Array, now: number): void {
    const box = this.get(id, now);
    requireValue(box.submitted && !box.request && !box.delivered && offset === box.replyOffset);
    requireValue(total >= 40 && total <= LIMITS.mailbox && bytes.length > 0 && bytes.length <= LIMITS.mailboxChunk && offset + bytes.length <= total);
    if (!box.reply) { requireValue(offset === 0); box.reply = new Uint8Array(total); }
    requireValue(box.reply.length === total);
    box.reply.set(bytes, offset); box.replyOffset += bytes.length;
    box.delivered = box.replyOffset === total;
  }
  poll(id: string, now: number): Uint8Array | null {
    const box = this.get(id, now);
    if (!box.delivered) return null;
    const reply = box.reply!;
    this.boxes.delete(id);
    return reply;
  }
  cancel(id: string): void {
    const box = this.boxes.get(id);
    box?.request?.fill(0); box?.reply?.fill(0); this.boxes.delete(id);
  }
  expire(now: number): void { for (const [id, box] of this.boxes) if (box.expires <= now) this.cancel(id); }
  clear(): void { for (const id of this.boxes.keys()) this.cancel(id); }
  get size(): number { return this.boxes.size; }
}
