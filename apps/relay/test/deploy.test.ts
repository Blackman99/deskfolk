import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

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
  expect(config).toContain('@private path /v1/* /__local-api /__local-api/* /@vite/* /src/* /healthz');
  expect(config).toContain('header_up X-Real-IP {remote_host}');
  expect(config).toContain('output discard');
  expect(read('deploy/remote/entrypoint.sh')).toContain('>/dev/null 2>&1');
  const csp = read('deploy/remote/csp.mjs');
  expect(csp).toContain("script-src-attr 'none'");
  expect(csp).not.toContain("script-src 'unsafe-inline'");
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).toContain("connect-src 'self'");
  expect(read('deploy/remote/Dockerfile')).toContain('pnpm --filter @real-bot/messenger build');
  expect(read('deploy/remote/Dockerfile')).not.toContain('vite preview');
});
