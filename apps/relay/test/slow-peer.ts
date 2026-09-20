import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { canonicalize } from '@real-bot/remote';

// A paused TCP reader exercises the real Bun write buffer, not a mocked send().
export class SlowPeer {
  socket: Socket;
  private bytes = Buffer.alloc(0);
  private queue: string[] = [];
  private waiters: ((value: string) => void)[] = [];
  readonly ready: Promise<void>;
  constructor(port: number) {
    this.socket = connect(port, '127.0.0.1');
    let upgraded = false;
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.once('connect', () => this.socket.write(`GET /v1/relay/host HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`));
      this.socket.on('data', chunk => {
        this.bytes = Buffer.concat([this.bytes, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
        if (!upgraded) {
          const end = this.bytes.indexOf('\r\n\r\n'); if (end < 0) return;
          if (!this.bytes.subarray(0, end).toString().startsWith('HTTP/1.1 101')) { reject(new Error('upgrade failed')); return; }
          this.bytes = this.bytes.subarray(end + 4); upgraded = true; resolve();
        }
        while (this.bytes.length >= 2) {
          const opcode = this.bytes[0] & 15;
          let length = this.bytes[1] & 127, offset = 2;
          if (length === 126) { if (this.bytes.length < 4) return; length = this.bytes.readUInt16BE(2); offset = 4; }
          else if (length === 127) { if (this.bytes.length < 10) return; length = Number(this.bytes.readBigUInt64BE(2)); offset = 10; }
          if (this.bytes.length < offset + length) return;
          const body = this.bytes.subarray(offset, offset + length); this.bytes = this.bytes.subarray(offset + length);
          if (opcode === 1) {
            const waiter = this.waiters.shift(); if (waiter) waiter(body.toString()); else this.queue.push(body.toString());
          }
        }
      });
    });
  }
  text(value: Record<string, unknown>): void {
    const body = Buffer.from(canonicalize(value)); const mask = randomBytes(4);
    const header = Buffer.alloc(body.length < 126 ? 2 : 4); header[0] = 0x81;
    if (body.length < 126) header[1] = 0x80 | body.length;
    else { header[1] = 0x80 | 126; header.writeUInt16BE(body.length, 2); }
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  async json(): Promise<Record<string, any>> {
    const value = this.queue.shift() ?? await new Promise<string>(resolve => this.waiters.push(resolve));
    return JSON.parse(value);
  }
  pause(): void { this.socket.pause(); }
  close(): void { this.socket.destroy(); }
}
