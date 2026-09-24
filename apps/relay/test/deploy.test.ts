import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { productionCsp } from '../../../deploy/remote/csp.mjs';
import { PAIR_MAILBOX_CONTRACT } from '@real-bot/remote';
import { LIMITS } from '../src/wire.ts';

const root = resolve(import.meta.dir, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('shared CSP fails without entry scripts and mailbox bounds consume the protocol contract', () => {
  expect(() => productionCsp('<html></html>')).toThrow('missing production entry scripts');
  expect(productionCsp('<script src="/entry.js"></script>')).toContain("script-src 'self'");
  expect(productionCsp('<script>boot()</script>')).toContain("script-src-attr 'none'");
  expect(productionCsp('<script src="/_app/immutable/entry.js"></script>')).not.toContain('sha256-');
  expect(LIMITS.mailbox).toBe(PAIR_MAILBOX_CONTRACT.maximumEnvelopeBytes);
  expect(LIMITS.mailboxTtlMs).toBe(PAIR_MAILBOX_CONTRACT.maximumLifetimeSeconds * 1_000);
});

test('deployment has two default-off gates, no direct relay port, and private secret file', () => {
  const compose = read('deploy/remote/compose.yaml');
  expect(compose).toContain('RELAY_ENABLED: ${RELAY_ENABLED:-0}');
  expect(compose).toContain('RELAY_PAIRING_ENABLED: ${RELAY_PAIRING_ENABLED:-0}');
  expect(compose).toContain('${REMOTE_BIND_IP:-127.0.0.1}:443:8443');
  expect(compose).toContain('RELAY_BOOTSTRAP_FILE: /run/secrets/bootstrap');
  expect(compose.split('  caddy:')[0]).not.toContain('ports:');
  expect(compose).not.toContain('privileged:');
  expect(compose.match(/read_only: true/g)).toHaveLength(2);
  expect(compose.match(/cap_drop: \[ALL\]/g)).toHaveLength(2);
  expect(read('apps/relay/Dockerfile')).toContain('USER bun');
  expect(read('deploy/remote/Dockerfile')).toContain('USER 1000:1000');
});

test('Caddy forwards exact relay routes, hides discovery/dev/API and uses hash-only script CSP', () => {
  const config = read('deploy/remote/Caddyfile');
  expect(config).toContain('@relay path /v1/relay/host /v1/relay/device /v1/relay/bootstrap /v1/pair/mailbox');
  expect(config).toContain("@illegal_query expression `{http.request.uri.query} != \"\" && !({http.request.uri.query}.matches('^(?:(?:s|o|b|a)=[0-9A-Za-z._-]+)(?:&(?:s|o|b|a)=[0-9A-Za-z._-]+)*$'))`");
  expect(config).toContain('@private path /v1/* /__local-api /__local-api/* /@vite/* /src/* /healthz');
  expect(config).toContain('header_up X-Real-IP {remote_host}');
  expect(config).toContain('output discard');
  expect(read('deploy/remote/entrypoint.sh')).toContain('>/dev/null 2>&1');
  const csp = read('deploy/remote/csp.mjs');
  expect(csp).toContain("script-src-attr 'none'");
  expect(csp).not.toContain("script-src 'unsafe-inline'");
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).toContain("connect-src 'self' wss: https:");
  expect(csp).toContain("manifest-src 'self'");
  expect(read('deploy/remote/Dockerfile')).toContain('pnpm --filter @real-bot/messenger build:hosted');
  expect(read('deploy/remote/Dockerfile')).not.toContain('vite preview');
});
