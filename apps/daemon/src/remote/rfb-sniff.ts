/**
 * What a remote screen session is actually carrying, read off the bytes the daemon relays: the
 * security type Screen Sharing and the phone settled on, the framebuffer it announced, and how its
 * first update is encoded. ARD (type 30) encrypts only the credentials, so after it the stream is
 * plain RFB. Only the start is parsed — a rect's payload has no length the reader could skip
 * without decoding every encoding — so this stops at the first update's first rect.
 */
export type RfbFacts = {
  securityTypes?: number[];
  chosen?: number;
  width?: number;
  height?: number;
  name?: string;
  /** The first server message after ServerInit: its type, and for an update its first rect. */
  firstMessage?: { type: number; rects?: number; rect?: { x: number; y: number; width: number; height: number; encoding: number } };
  failed?: string;
};

type Stage = "version" | "types" | "auth" | "result" | "init" | "message" | "done";

export class RfbSniffer {
  readonly facts: RfbFacts = {};
  private server = new Uint8Array(0);
  private stage: Stage = "version";
  private clientBytes = 0;
  private clientHead = new Uint8Array(13);

  /** Bytes the phone sent: only its 12-byte version and 1-byte security choice matter. */
  fromClient(bytes: Uint8Array): void {
    if (this.clientBytes >= 13) return;
    const take = Math.min(13 - this.clientBytes, bytes.length);
    this.clientHead.set(bytes.subarray(0, take), this.clientBytes);
    this.clientBytes += take;
    if (this.clientBytes === 13) {
      this.facts.chosen = this.clientHead[12];
      this.advance();
    }
  }

  /** Bytes Screen Sharing sent. */
  fromServer(bytes: Uint8Array): void {
    if (this.stage === "done") return;
    const next = new Uint8Array(this.server.length + bytes.length);
    next.set(this.server);
    next.set(bytes, this.server.length);
    this.server = next;
    this.advance();
  }

  private take(n: number): Uint8Array | null {
    if (this.server.length < n) return null;
    const out = this.server.subarray(0, n);
    this.server = this.server.subarray(n);
    return out;
  }

  private peek(n: number): DataView | null {
    return this.server.length < n ? null : new DataView(this.server.buffer, this.server.byteOffset, n);
  }

  private advance(): void {
    for (;;) {
      if (this.stage === "version") {
        if (!this.take(12)) return;
        this.stage = "types";
      } else if (this.stage === "types") {
        const head = this.peek(1);
        if (!head) return;
        const count = head.getUint8(0);
        const all = this.take(1 + count);
        if (!all) return;
        this.facts.securityTypes = [...all.subarray(1)];
        this.stage = "auth";
      } else if (this.stage === "auth") {
        const chosen = this.facts.chosen;
        if (chosen === undefined) return;
        if (chosen === 1) this.stage = "result";
        else if (chosen === 2) {
          if (!this.take(16)) return;
          this.stage = "result";
        } else if (chosen === 30) {
          const head = this.peek(4);
          if (!head) return;
          const keyLength = head.getUint16(2);
          if (!this.take(4 + 2 * keyLength)) return;
          this.stage = "result";
        } else {
          this.facts.failed = `security type ${chosen} is not read`;
          this.stage = "done";
          return;
        }
      } else if (this.stage === "result") {
        const result = this.peek(4);
        if (!result) return;
        if (result.getUint32(0) !== 0) {
          this.facts.failed = "authentication refused";
          this.stage = "done";
          return;
        }
        this.take(4);
        this.stage = "init";
      } else if (this.stage === "init") {
        const head = this.peek(24);
        if (!head) return;
        const nameLength = head.getUint32(20);
        const all = this.take(24 + nameLength);
        if (!all) return;
        this.facts.width = head.getUint16(0);
        this.facts.height = head.getUint16(2);
        this.facts.name = new TextDecoder().decode(all.subarray(24));
        this.stage = "message";
      } else if (this.stage === "message") {
        const type = this.peek(1)?.getUint8(0);
        if (type === undefined) return;
        if (type !== 0) {
          this.facts.firstMessage = { type };
          this.stage = "done";
          return;
        }
        const head = this.peek(16);
        if (!head) return;
        this.facts.firstMessage = {
          type, rects: head.getUint16(2),
          rect: { x: head.getUint16(4), y: head.getUint16(6), width: head.getUint16(8), height: head.getUint16(10), encoding: head.getInt32(12) },
        };
        this.stage = "done";
        this.server = new Uint8Array(0);
        return;
      } else return;
    }
  }
}
