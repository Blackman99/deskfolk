import { join, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { productionCsp } from '../../../../deploy/remote/csp.mjs';

// The phone's page as the relay serves it: `bun apps/desktop-nsh/scripts/phone-package.ts --build`.
const root = resolve(process.env.PHONE_SITE ?? resolve(import.meta.dir, '../../../desktop-nsh/build/phone/Deskfolk'));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const csp = productionCsp(html);
const server = Bun.serve({
  hostname: '::1', port: 5186,
  async fetch(request) {
    const url = new URL(request.url);
    const headers = {
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': csp,
    };
    const idQuery = /^(?:(?:s|o|b|a|k)=[0-9A-Za-z._-]+)(?:&(?:s|o|b|a|k)=[0-9A-Za-z._-]+)*$/;
    if ((url.search && !idQuery.test(url.search.slice(1))) || url.pathname.startsWith('/__local-api') || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/@vite/') || url.pathname.startsWith('/src/')) {
      return new Response(null, { status: 404, headers });
    }
    const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (path !== root && !path.startsWith(root + sep)) return new Response(null, { status: 404, headers });
    const file = Bun.file(path);
    const found = path !== root && await file.exists();
    // A file named by its content that is not there is a 404, never the page (as the Caddyfile's `@hashed`).
    if (!found && /\.[0-9a-f]{10}[./]/.test(url.pathname)) return new Response(null, { status: 404, headers });
    return new Response(found ? file : html, { headers: { ...headers, 'content-type': found ? file.type : 'text/html' } });
  },
});
console.log('Static production placeholder: http://[::1]:5186; no daemon or discovery endpoint.');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.stop(true); });
