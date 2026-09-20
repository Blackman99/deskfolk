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
});
