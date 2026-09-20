import { join, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { productionCsp } from '../../../../deploy/remote/csp.mjs';

const root = resolve(import.meta.dir, '../../../messenger/build');
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
    if (url.search || url.pathname.startsWith('/__local-api') || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/@vite/') || url.pathname.startsWith('/src/')) return new Response(null, { status: 404, headers });
    const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (path !== root && !path.startsWith(root + sep)) return new Response(null, { status: 404, headers });
    const file = Bun.file(path);
    return new Response(path !== root && await file.exists() ? file : html, { headers: { ...headers, 'content-type': path !== root && await file.exists() ? file.type : 'text/html' } });
  },
});
console.log('Static production placeholder: http://[::1]:5186; no daemon or discovery endpoint.');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.stop(true); });
