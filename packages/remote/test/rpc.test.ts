import { expect, test } from 'bun:test';
import { canonicalBytes, parseRemoteRequest, utf8 } from '../src/index.ts';
const id = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

test('shared RPC requires canonical bounded exact envelope and never arbitrary HTTP headers or URL', () => {
  const request = { v: 1, id, method: 'GET', path: '/v1/workspace/file', query: { path: 'notes/test.json' } } as const;
  expect(parseRemoteRequest(canonicalBytes(request))).toEqual(request);
  for (const changed of [
    { ...request, v: 2 }, { ...request, id: 'not-stable' }, { ...request, method: 'CONNECT' },
    { ...request, path: 'https://evil.test/v1/bots' }, { ...request, path: '/v1/../remote/action' },
    { ...request, path: '/v1/%62ots' }, { ...request, headers: { Authorization: 'secret' } },
    { ...request, body: {} }, { ...request, query: { path: 3 } }, { ...request, ifMatch: '*' },
  ]) expect(() => parseRemoteRequest(canonicalBytes(changed))).toThrow();
  expect(() => parseRemoteRequest(utf8(JSON.stringify(request)))).toThrow();
  expect(() => parseRemoteRequest(utf8('{"v":1,"v":1}'))).toThrow();
  expect(() => parseRemoteRequest(new Uint8Array(1024 * 1024 + 1))).toThrow();
  const id26 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const stacked = {
    v: 1, id, method: 'GET', path: '/v1/spend/summary',
    query: {
      bot_id: '', from: '2026-01-01T00:00:00.000Z', group_by: 'day', kind: 'turn,judgement',
      model: 'fast', provider_id: id26, session_id: id26, to: '2026-02-01T00:00:00.000Z', tz: 'America/New_York',
    },
  } as const;
  expect(parseRemoteRequest(canonicalBytes(stacked))).toEqual(stacked);
  const page = {
    v: 1 as const, id, method: 'GET' as const, path: '/v1/spend',
    query: {
      bot_id: '', from: '2026-01-01T00:00:00.000Z', kind: 'turn,judgement', limit: '50',
      cursor: `2026-01-02T00:00:00.000Z|${id26}`, model: 'fast', provider_id: id26,
      session_id: id26, to: '2026-02-01T00:00:00.000Z',
    },
  };
  expect(parseRemoteRequest(canonicalBytes(page))).toEqual(page);
  expect(() => parseRemoteRequest(canonicalBytes({ ...request, query: { ...stacked.query, extra: '1' } }))).toThrow();
  expect(() => parseRemoteRequest(canonicalBytes({ ...stacked, query: { ...stacked.query, extra: '1' } }))).toThrow();
});
