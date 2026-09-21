import { canonicalize } from './canonical.ts';
import { check, id, text, utf8 } from './bytes.ts';

export const REMOTE_RPC_VERSION = 1;
export const REMOTE_FILE_LIMIT = 50 * 1024 * 1024;
export const REMOTE_FILE_STREAMS = 2;
export interface RemoteRequest {
  v: 1; id: string; method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string;
  query?: Record<string, string>; body?: Record<string, unknown>; ifMatch?: string;
}
export interface RemoteResponse {
  v: 1; id: string; status: number; body: unknown;
  headers?: { etag?: string; contentType?: string };
  file?: { streamId: number; size: number };
  upload?: { files: Array<{ streamId: number; filename: string; size: number; sha256: string }> };
  snapshotPage?: { transferId: string; index: number; count: number; bytes: string };
}
export interface RemoteReady {
  type: 'ready'; protocol: 'remote-v1'; event_instance_id: string; watermark_seq: number;
  deviceId: string; trustEpoch: number;
}
export interface AssertionWire { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string }
export interface RegistrationWire { credentialId: string; clientDataJSON: string; attestationObject: string }
export interface PairingQr {
  v: 1; pairingId: string; hostId: string; expiresUnix: number; relayOrigin: string; relayId: string;
  hostDhPublic: string; hostSigningPublic: string; trustEpoch: number; issuedAt: number; secret: string;
}
export function parseRemoteRequest(bytes: Uint8Array): RemoteRequest {
  check(bytes.length <= 1024 * 1024, 'RPC limit');
  const source = text(bytes), value = JSON.parse(source) as RemoteRequest;
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'RPC object required');
  check(canonicalize(value) === source, 'RPC must be canonical JSON');
  check(Object.keys(value).every(k => ['v', 'id', 'method', 'path', 'query', 'body', 'ifMatch'].includes(k)), 'unexpected RPC field');
  check(value.v === 1, 'RPC version'); id(value.id);
  check(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(value.method), 'RPC method');
  check(typeof value.path === 'string' && /^\/(?:v1|remote)\/[A-Za-z0-9_/-]+$/.test(value.path) && value.path.length <= 256, 'RPC path');
  if (value.query !== undefined) {
    check(value.query !== null && typeof value.query === 'object' && !Array.isArray(value.query), 'RPC query');
    check(Object.keys(value.query).length <= 8 && Object.entries(value.query).every(([k, v]) =>
      /^[a-z_]+$/.test(k) && typeof v === 'string' && utf8(v).length <= 4096 && !/[\x00-\x1f\x7f]/.test(v)), 'RPC query');
  }
  if (value.body !== undefined) check(value.body !== null && typeof value.body === 'object' && !Array.isArray(value.body), 'RPC body');
  if (value.ifMatch !== undefined) check(typeof value.ifMatch === 'string' && /^"[0-9a-f]{64}"$/.test(value.ifMatch), 'RPC If-Match');
  check(value.method !== 'GET' || value.body === undefined, 'GET body forbidden');
  return value;
}
