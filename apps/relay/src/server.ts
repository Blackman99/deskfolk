import type { ServerWebSocket } from 'bun';
import { isIP } from 'node:net';
import { base64url, canonicalize, fromBase64url, randomBytes, verifyEnrollmentProof } from '@real-bot/remote';
import type { EnrollmentChallenge } from '@real-bot/remote';
import { EnrollmentStore } from './store.ts';
import { Mailboxes } from './mailbox.ts';
import { Bucket, envelope, fields, identifier, integer, IpLimiter, key, LIMITS, opaqueId, parseWire, requireValue } from './wire.ts';
import type { RecordValue } from './wire.ts';

export type RelayLog = { event: 'http_rejected' | 'socket_closed' | 'started' | 'stopped'; code: number };
export interface RelayOptions {
  hostname?: string;
  port?: number;
  database: string;
  bootstrap?: string;
  relayId: string;
  origin: string;
  enabled?: boolean;
  pairingEnabled?: boolean;
  trustedProxyIp?: string;
  log?: (entry: RelayLog) => void;
  now?: () => number;
}
type Socket = ServerWebSocket<Connection>;
type Phase = 'hello' | 'proof' | 'waiting' | 'control' | 'data' | 'closed';
type Connection = {
  role: 'host' | 'device'; phase: Phase; deadline: number; id?: string;
  challenge?: EnrollmentChallenge; publicKey?: string;
  mode?: 'control' | 'link'; routeId?: string; deviceId?: string;
};
type Route = { id: string; deviceId: string; device: Socket; host?: Socket };

export function startRelay(options: RelayOptions) {
  requireValue(/^[A-Za-z0-9_-]{1,64}$/.test(options.relayId));
  const origin = new URL(options.origin);
  requireValue(origin.protocol === 'https:' && origin.origin === options.origin);
  requireValue(!options.trustedProxyIp || isIP(options.trustedProxyIp));
  const store = new EnrollmentStore(options.database, options.bootstrap);
  const now = options.now ?? Date.now;
  const logRate = new Bucket(20, 5, now());
  const log = (event: RelayLog['event'], code: number) => {
    if (!logRate.take(1, now())) return;
    try { options.log?.({ event, code }); } catch { /* Logging cannot change admission. */ }
  };
  const mailboxes = new Mailboxes();
  const sockets = new Set<Socket>();
  const connections = new Set<Connection>();
  const routes = new Map<string, Route>();
  const ipLimiter = new IpLimiter();
  const mailboxLimiter = new IpLimiter();
  const admission = new Bucket(60, 1, now());
  const bandwidth = new Bucket(LIMITS.burstBytes, LIMITS.bytesPerSecond, now());
  const controls = new Bucket(40, 20, now());
  const httpRate = new Bucket(100, 50, now());
  let control: Socket | undefined;
  let httpActive = 0;
  let stopped = false;

  function terminate(socket: Socket, code: number): void {
    if (socket.data.phase === 'closed') return;
    socket.data.phase = 'closed'; socket.data.challenge = undefined;
    sockets.delete(socket); connections.delete(socket.data);
    // terminate discards Bun's pending writes; graceful close can flush revoked frames.
    socket.terminate();
    log('socket_closed', code);
  }
  function dropRoute(routeId: string, code: number): void {
    const route = routes.get(routeId);
    if (!route) return;
    routes.delete(routeId);
    terminate(route.device, code);
    if (route.host) terminate(route.host, code);
    if (control) sendControl({ type: 'route_closed', route_id: routeId });
  }
  function disconnect(socket: Socket, code: number): void {
    if (socket === control) {
      control = undefined;
      mailboxes.clear();
      for (const id of [...routes.keys()]) dropRoute(id, code);
      // Pending host links and device proofs cannot outlive their control authority.
      for (const peer of [...sockets]) if (peer !== socket) terminate(peer, code);
    } else if (socket.data.routeId && routes.has(socket.data.routeId)) {
      const route = routes.get(socket.data.routeId)!;
      if (socket === route.device || socket === route.host) dropRoute(route.id, code);
    }
    terminate(socket, code);
  }
  function send(socket: Socket, value: string | Uint8Array): boolean {
    if (socket.data.phase === 'closed') return false;
    const size = typeof value === 'string' ? Buffer.byteLength(value) : value.length;
    if (socket.getBufferedAmount() + size > LIMITS.bufferBytes) { disconnect(socket, 1013); return false; }
    const sent = socket.send(value);
    if (sent <= 0 || socket.getBufferedAmount() > LIMITS.bufferBytes) { disconnect(socket, 1013); return false; }
    return true;
  }
  function sendControl(value: RecordValue): void {
    if (control) send(control, new TextEncoder().encode(canonicalize(value)));
  }
  function reply(status: number, value: RecordValue): Response {
    return new Response(canonicalize(value), { status, headers: {
      'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    } });
  }
  function reject(status: number): Response { log('http_rejected', status); return reply(status, { error: 'rejected' }); }

  function hello(socket: Socket, message: RecordValue): void {
    const data = socket.data;
    if (data.role === 'device') fields(message, ['type', 'id', 'nonce_c']);
    else if (message.mode === 'control') fields(message, ['type', 'id', 'nonce_c', 'mode']);
    else fields(message, ['type', 'id', 'nonce_c', 'mode', 'route_id', 'device_id']);
    requireValue(message.type === 'hello');
    const id = identifier(message.id);
    requireValue(typeof message.nonce_c === 'string'); fromBase64url(message.nonce_c, 16);
    const publicKey = store.lookup(data.role, id);
    requireValue(publicKey);
    if (data.role === 'host') {
      requireValue(message.mode === 'control' || message.mode === 'link');
      data.mode = message.mode;
      if (message.mode === 'control') requireValue(!control);
      else {
        requireValue(control);
        data.routeId = opaqueId(message.route_id); data.deviceId = identifier(message.device_id);
        const route = routes.get(data.routeId);
        requireValue(route && !route.host && route.deviceId === data.deviceId);
      }
    } else requireValue(control && ![...routes.values()].some(route => route.deviceId === id));
    data.id = id; data.publicKey = publicKey;
    data.challenge = { role: data.role, id, nonce_c: message.nonce_c, nonce_s: base64url(randomBytes(16)), ts: Math.floor(now() / 1_000), relay_id: options.relayId };
    data.phase = 'proof'; data.deadline = now() + LIMITS.challengeMs;
    send(socket, canonicalize({ type: 'challenge', ...data.challenge }));
  }
  function proof(socket: Socket, message: RecordValue): void {
    fields(message, ['type', 'signature']);
    requireValue(message.type === 'proof' && typeof message.signature === 'string');
    const data = socket.data;
    requireValue(data.challenge && data.id && store.lookup(data.role, data.id) === data.publicKey);
    const challenge = data.challenge;
    verifyEnrollmentProof({ challenge, signature: message.signature, enrolledPublicKey: fromBase64url(data.publicKey!, 32), nowUnix: Math.floor(now() / 1_000),
      consume: candidate => {
        if (data.challenge !== challenge || candidate.nonce_s !== challenge.nonce_s || now() >= data.deadline) return false;
        data.challenge = undefined; return true;
      },
    });
    if (data.role === 'host' && data.mode === 'control') {
      requireValue(!control); control = socket; data.phase = 'control';
      send(socket, canonicalize({ type: 'ok', mode: 'control' }));
    } else if (data.role === 'device') {
      requireValue(control && routes.size * 2 < LIMITS.slots && ![...routes.values()].some(route => route.deviceId === data.id));
      const routeId = base64url(randomBytes(16));
      data.routeId = routeId; data.phase = 'waiting'; data.deadline = now() + LIMITS.challengeMs;
      routes.set(routeId, { id: routeId, deviceId: data.id!, device: socket });
      sendControl({ type: 'route_pending', route_id: routeId, device_id: data.id! });
    } else {
      const route = routes.get(data.routeId!);
      requireValue(control && route && !route.host && route.deviceId === data.deviceId && store.lookup('device', route.deviceId));
      route.host = socket; data.phase = 'data'; route.device.data.phase = 'data';
      if (!send(socket, canonicalize({ type: 'ok', mode: 'link', route_id: route.id, device_id: route.deviceId }))) return;
      send(route.device, canonicalize({ type: 'ok', mode: 'link', route_id: route.id, device_id: route.deviceId }));
    }
  }
  function manage(socket: Socket, message: RecordValue): void {
    requireValue(socket === control && controls.take(1, now()));
    const requestId = opaqueId(message.request_id);
    const op = message.op;
    let result: RecordValue = {};
    switch (op) {
      case 'health':
        fields(message, ['op', 'request_id']);
        result = { devices: store.count(), routes: routes.size, mailboxes: mailboxes.size, sockets: sockets.size, pairing_enabled: options.pairingEnabled === true };
        break;
      case 'open_pair':
        fields(message, ['op', 'request_id', 'pairing_id', 'expires_unix']);
        requireValue(options.pairingEnabled);
        mailboxes.open(identifier(message.pairing_id), integer(message.expires_unix, 0, Number.MAX_SAFE_INTEGER) * 1_000, now());
        break;
      case 'cancel_pair':
        fields(message, ['op', 'request_id', 'pairing_id']); mailboxes.cancel(identifier(message.pairing_id)); break;
      case 'register_device':
        fields(message, ['op', 'request_id', 'device_id', 'enrollment_pk']);
        requireValue(options.pairingEnabled);
        store.register(identifier(message.device_id), key(message.enrollment_pk)); break;
      case 'revoke_device': {
        fields(message, ['op', 'request_id', 'device_id']);
        const id = identifier(message.device_id);
        store.revoke(id);
        // Clear pending pairing replies too: none may resurrect a revoked enrollment.
        mailboxes.clear();
        for (const route of [...routes.values()]) if (route.deviceId === id) dropRoute(route.id, 1008);
        for (const peer of [...sockets]) if ((peer.data.role === 'device' && peer.data.id === id) || peer.data.deviceId === id) disconnect(peer, 1008);
        break;
      }
      case 'read_pair': {
        fields(message, ['op', 'request_id', 'pairing_id', 'offset']);
        const chunk = mailboxes.readRequest(identifier(message.pairing_id), integer(message.offset, 0, LIMITS.mailbox), now());
        result = chunk ?? { pending: true }; break;
      }
      case 'deliver_pair':
        fields(message, ['op', 'request_id', 'pairing_id', 'offset', 'total', 'ciphertext']);
        mailboxes.deliver(identifier(message.pairing_id), integer(message.offset, 0, LIMITS.mailbox), integer(message.total, 40, LIMITS.mailbox), envelope(message.ciphertext, LIMITS.mailboxChunk), now()); break;
      case 'close_route':
        fields(message, ['op', 'request_id', 'route_id']); dropRoute(opaqueId(message.route_id), 1000); break;
      default: throw new Error('invalid');
    }
    sendControl({ type: 'result', request_id: requestId, ...result });
  }

  async function readBody(request: Request): Promise<RecordValue> {
    requireValue(request.headers.get('content-type') === 'application/json');
    const length = request.headers.get('content-length');
    requireValue(!length || (/^\d+$/.test(length) && Number(length) <= LIMITS.httpBody));
    const reader = request.body?.getReader(); requireValue(reader);
    const body = new Uint8Array(LIMITS.httpBody); let size = 0; let expired = false;
    const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, LIMITS.challengeMs);
    try {
      while (true) {
        const { done, value } = await reader.read(); requireValue(!expired);
        if (done) break;
        requireValue(size + value.length <= LIMITS.httpBody); body.set(value, size); size += value.length;
      }
      return parseWire(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, size)));
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  }

  let server: ReturnType<typeof Bun.serve<Connection>>;
  try { server = Bun.serve<Connection>({
    hostname: options.hostname ?? '127.0.0.1', port: options.port ?? 8080,
    maxRequestBodySize: LIMITS.httpBody, idleTimeout: 15,
    async fetch(request, server) {
      let active = false;
      try {
        const url = new URL(request.url);
        if (url.search || url.hash || request.headers.has('authorization')) return reject(400);
        if (request.headers.has('origin') && request.headers.get('origin') !== options.origin) return reject(403);
        if (!httpRate.take(1, now())) return reject(429);
        if (url.pathname === '/healthz' && request.method === 'GET') return reply(200, { status: 'ok', enabled: options.enabled === true });
        if (!options.enabled) return reject(503);
        let ip = server.requestIP(request)?.address;
        requireValue(ip);
        if (options.trustedProxyIp && ip === options.trustedProxyIp) {
          ip = request.headers.get('x-real-ip') ?? ''; requireValue(isIP(ip));
        }
        if (request.method === 'GET' && (url.pathname === '/v1/relay/host' || url.pathname === '/v1/relay/device')) {
          if (!admission.take(1, now()) || !ipLimiter.take(ip, now())) return reject(429);
          if (connections.size >= LIMITS.sockets || [...connections].filter(data => ['hello', 'proof', 'waiting'].includes(data.phase)).length >= LIMITS.pending) return reject(503);
          const role = url.pathname === '/v1/relay/host' ? 'host' : 'device';
          if (role === 'device' && !control) return reject(503);
          const data: Connection = { role, phase: 'hello', deadline: now() + LIMITS.challengeMs };
          connections.add(data);
          try { if (server.upgrade(request, { data })) return; }
          catch { connections.delete(data); return reject(400); }
          connections.delete(data); return reject(400);
        }
        if (request.method !== 'POST' || !['/v1/relay/bootstrap', '/v1/pair/mailbox'].includes(url.pathname)) return reject(404);
        if (!options.pairingEnabled) return reject(503);
        if (!mailboxLimiter.take(ip, now())) return reject(429);
        if (httpActive >= LIMITS.httpRequests) return reject(503);
        httpActive++; active = true;
        const message = await readBody(request);
        if (url.pathname === '/v1/relay/bootstrap') {
          fields(message, ['bootstrap', 'host_id', 'enrollment_pk']); requireValue(typeof message.bootstrap === 'string');
          store.bootstrap(message.bootstrap, identifier(message.host_id), key(message.enrollment_pk));
          return reply(201, { enrolled: true });
        }
        if (!control) return reject(503);
        const id = identifier(message.pairing_id);
        if (message.op === 'submit') {
          fields(message, ['op', 'pairing_id', 'ciphertext']);
          mailboxes.submit(id, envelope(message.ciphertext), now()); return reply(202, { accepted: true });
        }
        fields(message, ['op', 'pairing_id']); requireValue(message.op === 'poll');
        const ciphertext = mailboxes.poll(id, now());
        return ciphertext ? reply(200, { ciphertext: base64url(ciphertext) }) : reply(202, { pending: true });
      } catch { return reject(400); }
      finally { if (active) httpActive--; }
    },
    error() { return reject(500); },
    websocket: {
      maxPayloadLength: LIMITS.frame, backpressureLimit: LIMITS.bufferBytes,
      closeOnBackpressureLimit: true, perMessageDeflate: false, idleTimeout: 60, sendPings: true,
      open(socket) { sockets.add(socket); },
      message(socket, raw) {
        try {
          const data = socket.data;
          requireValue(data.phase !== 'closed');
          if (data.phase === 'hello' || data.phase === 'proof') {
            requireValue(now() < data.deadline && typeof raw === 'string' && Buffer.byteLength(raw) <= LIMITS.text);
            const message = parseWire(raw);
            if (data.phase === 'hello') hello(socket, message); else proof(socket, message);
            return;
          }
          requireValue(typeof raw !== 'string' && raw.length > 0 && raw.length <= LIMITS.frame && bandwidth.take(raw.length, now()));
          if (data.phase === 'control') { manage(socket, parseWire(new TextDecoder('utf-8', { fatal: true }).decode(raw))); return; }
          requireValue(data.phase === 'data' && control);
          const route = routes.get(data.routeId!);
          requireValue(route && route.host && store.lookup('device', route.deviceId));
          const peer = socket === route.device ? route.host : route.device;
          requireValue(peer.data.phase === 'data'); send(peer, raw);
        } catch { disconnect(socket, 1008); }
      },
      close(socket) { disconnect(socket, 1000); },
    },
  }); } catch (error) { store.close(); throw error; }
  const timer = setInterval(() => {
    mailboxes.expire(now());
    for (const socket of [...sockets]) if (['hello', 'proof', 'waiting'].includes(socket.data.phase) && now() >= socket.data.deadline) disconnect(socket, 1008);
  }, 250);
  log('started', 0);
  return {
    port: server.port!,
    async stop() {
      if (stopped) return;
      stopped = true; clearInterval(timer);
      for (const socket of [...sockets]) disconnect(socket, 1001);
      mailboxes.clear(); await server.stop(true); store.close(); log('stopped', 0);
    },
  };
}
