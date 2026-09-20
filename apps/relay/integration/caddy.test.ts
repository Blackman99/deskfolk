import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DeviceSession, HostSession, identityPublic, utf8 } from '@real-bot/remote';
import { productionCsp } from '../../../deploy/remote/csp.mjs';
import { deadline, DEVICE, fixture, HOST } from '../test/helpers.ts';

const root = resolve(import.meta.dir, '../../..');
const caddy = process.env.CADDY_BIN ?? 'caddy';
const directory = mkdtempSync(join(tmpdir(), 'rb-edge-'));
const script = 'document.documentElement.dataset.fixture = "ready";';
const html = `<!doctype html><title>Relay edge fixture</title><script>${script}</script>`;
const assetPath = '/_app/immutable/entry/fixture.01234567.js';
const asset = 'export const fixture = true;';
let httpOrigin: string, httpsOrigin: string, ca: string;
let processHandle: Bun.Subprocess | undefined;
let relay: Awaited<ReturnType<typeof fixture>> | undefined;

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(`fixture command failed: ${args[0]}: ${stderr}`);
  return stdout;
}
function freePort(): number {
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null) });
  const port = reservation.port!; reservation.stop(true); return port;
}
const request = (path: string, secure = true, init: RequestInit = {}) => fetch(`${secure ? httpsOrigin : httpOrigin}${path}`, {
  ...init, redirect: 'manual', ...(secure ? { tls: { ca } } : {}),
});

beforeAll(async () => {
  expect(await command([caddy, 'build-info'])).toContain('v2.10.2');
  const config = join(directory, 'certificate.cnf');
  writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n');
  const certPath = join(directory, 'certificate.pem'), keyPath = join(directory, 'private.key');
  await command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', keyPath, '-out', certPath]);
  ca = readFileSync(certPath, 'utf8');
  const httpPort = freePort(); let httpsPort = freePort();
  while (httpsPort === httpPort) httpsPort = freePort();
  httpOrigin = `http://localhost:${httpPort}`; httpsOrigin = `https://localhost:${httpsPort}`;
  relay = await fixture({ origin: httpsOrigin, trustedProxyIp: '127.0.0.1' }, { origin: httpsOrigin, ca });
  const staticRoot = join(directory, 'static');
  mkdirSync(join(staticRoot, '_app/immutable/entry'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), html); writeFileSync(join(staticRoot, assetPath), asset);
  const cspPath = join(directory, 'csp.caddy');
  writeFileSync(cspPath, `header Content-Security-Policy "${productionCsp(html)}"\n`);
  const production = readFileSync(join(root, 'deploy/remote/Caddyfile'), 'utf8');
  const local = production.replace('admin off', 'admin off\n\tdefault_bind 127.0.0.1')
    .replace('http_port 8080', `http_port ${httpPort}`).replace('https_port 8443', `https_port ${httpsPort}`)
    .replaceAll('{$RELAY_DOMAIN}', 'localhost').replace('{$ACME_EMAIL}', 'fixture@localhost.invalid')
    .replace('tls {', `tls ${certPath} ${keyPath} {`)
    .replace('/etc/caddy/csp.caddy', cspPath).replaceAll('root * /srv', `root * ${staticRoot}`)
    .replace('reverse_proxy relay:8080', `reverse_proxy 127.0.0.1:${relay.port}`);
  const caddyfile = join(directory, 'Caddyfile'); writeFileSync(caddyfile, local);
  const adapted = JSON.parse(await command([caddy, 'adapt', '--config', caddyfile, '--adapter', 'caddyfile']));
  const servers = Object.values(adapted.apps.http.servers) as Array<{ automatic_https?: { disable?: boolean; disable_redirects?: boolean } }>;
  expect(servers.some(server => server.automatic_https?.disable_redirects)).toBe(true);
  expect(servers.every(server => server.automatic_https?.disable !== true)).toBe(true);
  processHandle = Bun.spawn([caddy, 'run', '--config', caddyfile, '--adapter', 'caddyfile'], {
    stdout: 'ignore', stderr: 'ignore', env: { ...process.env, XDG_DATA_HOME: join(directory, 'data'), XDG_CONFIG_HOME: join(directory, 'config') },
  });
  for (let i = 0; i < 100; i++) {
    if (processHandle.exitCode !== null) throw new Error('Caddy fixture exited');
    try { if ((await request('/')).status === 200) return; } catch {}
    await Bun.sleep(20);
  }
  throw new Error('Caddy fixture did not become ready');
}, 15_000);

afterAll(async () => {
  try { if (processHandle) { processHandle.kill(); await deadline(processHandle.exited); } }
  finally { await relay?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP rejects query canaries before a query-free HTTPS redirect; HTTPS also refuses queries', async () => {
  const canary = 'review-canary-private-material';
  for (const secure of [false, true]) {
    for (const path of ['/', '/v1/relay/bootstrap', '/__local-api', '/.well-known/acme-challenge/fixture', '/onboarding%3Flabel=encoded', '/onboarding%23section', '/onboarding%252Fchild']) {
      const response = await request(`${path}?secret=${canary}`, secure);
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('server')).toBeNull();
      expect(await response.text()).not.toContain(canary);
    }
  }
  for (const path of ['/', '/onboarding', '/.well-known/acme-challenge/unknown']) {
    const response = await request(path, false);
    expect(response.status).toBe(308); expect(response.headers.get('location')).toBe(`https://localhost${path}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});

test('HTTP redirects preserve escaped path delimiters without changing host or HTTPS navigation', async () => {
  for (const path of ['/onboarding%3Flabel=review-canary', '/onboarding%23section', '/onboarding%252Fchild', '/%2Fother.invalid/onboarding%3Flabel=fixture']) {
    const redirect = await request(path, false);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe(`https://localhost${path}`);
    const destination = new URL(redirect.headers.get('location')!);
    expect(destination.origin).toBe('https://localhost');
    expect(destination.pathname).toBe(path);
    expect(destination.search).toBe(''); expect(destination.hash).toBe('');
    const direct = await request(path);
    // Only map the production HTTPS port to the owned fixture listener.
    const followed = await request(destination.pathname + destination.search);
    expect(direct.status).toBe(200); expect(followed.status).toBe(direct.status);
    expect(await direct.text()).toBe(html); expect(await followed.text()).toBe(html);
  }
});

test('real HTTPS headers cache only existing immutable assets, never shell/errors/missing fallback', async () => {
  const shell = await request('/');
  expect(shell.status).toBe(200); expect(await shell.text()).toBe(html);
  expect(shell.headers.get('cache-control')).toBe('no-store');
  expect(shell.headers.get('content-security-policy')).toBe(productionCsp(html));
  expect(shell.headers.get('content-security-policy')).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`);
  expect(shell.headers.get('server')).toBeNull();
  for (const method of ['GET', 'HEAD']) {
    const response = await request(assetPath, true, { method });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('server')).toBeNull();
    if (method === 'GET') {
      expect(await response.text()).toBe(asset);
      const conditional = await request(assetPath, true, { headers: { 'if-none-match': response.headers.get('etag')! } });
      expect(conditional.status).toBe(304);
      expect(conditional.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    }
  }
  for (const path of ['/_app/immutable/missing.js', '/__local-api', '/v1/settings', '/@vite/client', '/src/main.ts']) {
    const response = await request(path);
    expect(response.status).toBe(404); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toBe(html);
  }
  const invalidMethod = await request(assetPath, true, { method: 'POST' });
  expect(invalidMethod.status).toBe(405); expect(invalidMethod.headers.get('cache-control')).toBe('no-store');
  const invalidRange = await request(assetPath, true, { headers: { range: 'bytes=99999-' } });
  expect(invalidRange.status).toBe(416); expect(invalidRange.headers.get('cache-control')).toBe('no-store');
  const fallback = await request('/onboarding');
  expect(fallback.status).toBe(200); expect(await fallback.text()).toBe(html);
  expect(fallback.headers.get('cache-control')).toBe('no-store');
});

test('HTTPS bootstrap and WSS host/device links exchange actual Noise and revoke through real Caddy', async () => {
  const f = relay!;
  const bootstrap = await f.enroll();
  expect(bootstrap.status).toBe(201); expect(bootstrap.headers.get('cache-control')).toBe('no-store');
  const control = await f.host(); await f.register(control); const route = await f.route(control);
  const binding = { hostId: HOST, deviceId: DEVICE, trustEpoch: 1, protocolVersion: 1, relayOrigin: httpsOrigin };
  const device = new DeviceSession({ binding, identity: f.deviceKeys, peer: identityPublic(f.hostKeys) });
  let claimed = false;
  const host = new HostSession({ binding, identity: f.hostKeys, peer: identityPublic(f.deviceKeys), recentRttMs: 0,
    isTrusted: () => true, claimReplay: () => { if (claimed) return false; claimed = true; return true; } });
  try {
    route.device.binary(device.start()); route.link.binary(host.accept(await route.link.next() as Uint8Array));
    device.accept(await route.device.next() as Uint8Array);
    const canary = utf8('TLS-fixture-private-command');
    route.device.binary(device.send(1, canary)); expect(host.receive(await route.link.next() as Uint8Array).body).toEqual(canary);
    route.link.binary(host.send(2, canary)); expect(device.receive(await route.device.next() as Uint8Array).body).toEqual(canary);
    await f.command(control, 'revoke_device', { device_id: DEVICE });
    await deadline(Promise.all([route.device.closed, route.link.closed]));
    expect((await f.command(control, 'health')).routes).toBe(0);
    expect(JSON.stringify(f.logs)).not.toContain('TLS-fixture-private-command');
  } finally { device.close(); host.close(); }
  // Three genuine upgrades already consumed this IP's budget; spoofed headers cannot reset it.
  for (let i = 0; i < 8; i++) {
    const response = await request('/v1/relay/host', true, { headers: { 'x-real-ip': `192.0.2.${i}`, 'x-forwarded-for': `192.0.2.${i}` } });
    expect(response.status).toBe(i < 7 ? 400 : 429);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
}, 10_000);
