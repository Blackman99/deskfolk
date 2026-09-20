import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64url, canonicalize, generateIdentity, identityPublic, randomBytes, signEnrollmentProof } from '@real-bot/remote';
import type { EnrollmentChallenge, IdentitySecrets } from '@real-bot/remote';
import { startRelay } from '../src/server.ts';
import type { RelayOptions, RelayLog } from '../src/server.ts';

export const HOST = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const DEVICE = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
export const DEVICE2 = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
export const PAIR = '01ARZ3NDEKTSV4RRFFQ69G5FAY';
export const ORIGIN = 'https://relay.example.test';
type Message = string | Uint8Array;
export type Json = Record<string, any>;

// lib.dom's constructor omits Bun's custom-CA and header options.
const BunWebSocket = WebSocket as unknown as new (url: string, options?: Bun.WebSocketOptions) => WebSocket;
class Peer {
  socket: WebSocket;
  private queue: Message[] = [];
  private waiting: { resolve: (message: Message) => void; reject: (error: Error) => void }[] = [];
  closed: Promise<void>;
  constructor(url: string, options?: Bun.WebSocketOptions) {
    this.socket = new BunWebSocket(url, options); this.socket.binaryType = 'arraybuffer';
    this.closed = new Promise(resolve => this.socket.addEventListener('close', () => {
      for (const waiter of this.waiting.splice(0)) waiter.reject(new Error('closed'));
      resolve();
    }));
    this.socket.addEventListener('message', event => {
      const value = typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer);
      const waiter = this.waiting.shift(); if (waiter) waiter.resolve(value); else this.queue.push(value);
    });
  }
  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('upgrade rejected')), { once: true });
    });
  }
  next(): Promise<Message> {
    const value = this.queue.shift(); if (value !== undefined) return Promise.resolve(value);
    if (this.socket.readyState >= WebSocket.CLOSING) return Promise.reject(new Error('closed'));
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
  async json(): Promise<Json> {
    const value = await this.next(); return JSON.parse(typeof value === 'string' ? value : new TextDecoder().decode(value));
  }
  text(value: Json): void { this.socket.send(canonicalize(value)); }
  binary(value: Json | Uint8Array): void { this.socket.send(value instanceof Uint8Array ? new Uint8Array(value) : new TextEncoder().encode(canonicalize(value))); }
  close(): void { this.socket.close(); }
}
export async function deadline<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('test deadline')), ms); })]); }
  finally { clearTimeout(timer!); }
}
export async function challenge(peer: Peer, id: string, extra: Json = {}): Promise<EnrollmentChallenge> {
  peer.text({ type: 'hello', id, nonce_c: base64url(randomBytes(16)), ...extra });
  const { type, ...issued } = await peer.json();
  if (type !== 'challenge') throw new Error('expected challenge');
  return issued as EnrollmentChallenge;
}
export async function authenticate(peer: Peer, id: string, identity: IdentitySecrets, extra: Json = {}): Promise<void> {
  const issued = await challenge(peer, id, extra);
  peer.text({ type: 'proof', signature: signEnrollmentProof(issued, identity.enrollment) });
}
export async function fixture(overrides: Partial<RelayOptions> = {}, edge?: { origin: string; ca: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'rb-relay-'));
  const bootstrap = base64url(randomBytes(32));
  const hostKeys = generateIdentity(); const deviceKeys = generateIdentity();
  const logs: RelayLog[] = [];
  let clock = Date.now();
  const config: RelayOptions = { port: 0, database: join(directory, 'enrollment.sqlite'), bootstrap,
    relayId: 'fixture', origin: ORIGIN, enabled: true, pairingEnabled: true, now: () => clock,
    log: entry => logs.push(entry), ...overrides };
  let relay: ReturnType<typeof startRelay>;
  try { relay = startRelay(config); }
  catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  const peers: Peer[] = [];
  const origin = () => edge?.origin ?? `http://127.0.0.1:${relay.port}`;
  function peer(role: 'host' | 'device') {
    const p = new Peer(`${origin().replace(/^http/, 'ws')}/v1/relay/${role}`, edge ? { tls: { ca: edge.ca, serverName: 'localhost' }, headers: { origin: edge.origin } } : undefined);
    peers.push(p); return p;
  }
  const post = (path: string, body: Json) => fetch(`${origin()}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: canonicalize(body),
    ...(edge ? { tls: { ca: edge.ca } } : {}),
  });
  const bootstrapBody = { bootstrap, host_id: HOST, enrollment_pk: base64url(identityPublic(hostKeys).enrollment) };
  async function enroll() { return post('/v1/relay/bootstrap', bootstrapBody); }
  async function host() {
    const p = peer('host'); await p.open(); await authenticate(p, HOST, hostKeys, { mode: 'control' });
    const ok = await p.json(); if (ok.type !== 'ok') throw new Error('expected ok'); return p;
  }
  async function command(control: Peer, op: string, body: Json = {}): Promise<Json> {
    const requestId = base64url(randomBytes(16)); control.binary({ op, request_id: requestId, ...body });
    while (true) { const result = await control.json(); if (result.request_id === requestId) return result; }
  }
  async function register(control: Peer, id = DEVICE, keys = deviceKeys) {
    return command(control, 'register_device', { device_id: id, enrollment_pk: base64url(identityPublic(keys).enrollment) });
  }
  async function route(control: Peer, id = DEVICE, keys = deviceKeys) {
    const device = peer('device'); await device.open(); await authenticate(device, id, keys);
    const pending = await control.json(); if (pending.type !== 'route_pending') throw new Error('expected pending');
    const link = peer('host'); await link.open();
    await authenticate(link, HOST, hostKeys, { mode: 'link', route_id: pending.route_id, device_id: id });
    const hostOk = await link.json(), deviceOk = await device.json();
    if (hostOk.type !== 'ok' || deviceOk.type !== 'ok') throw new Error('expected link ok');
    return { device, link, routeId: pending.route_id as string };
  }
  return { directory, bootstrap, bootstrapBody, hostKeys, deviceKeys, logs, post, peer, enroll, host, command, register, route,
    get port() { return relay.port; }, get now() { return clock; }, advance(ms: number) { clock += ms; },
    async restart() { await relay.stop(); relay = startRelay({ ...config, bootstrap: undefined }); },
    async close() { for (const p of peers) p.close(); await relay.stop(); rmSync(directory, { recursive: true, force: true }); },
  };
}
