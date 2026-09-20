const assets = new Map([
  ['/', new URL('./index.html', import.meta.url)],
  ['/style.css', new URL('./style.css', import.meta.url)],
  ['/main.js', new URL('../../dist/browser/main.js', import.meta.url)],
]);
Bun.serve({ hostname: '127.0.0.1', port: 5184, fetch(request) {
  const file = assets.get(new URL(request.url).pathname);
  if (!file) return new Response('Not found', { status: 404 });
  return new Response(Bun.file(file), { headers: {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  } });
} });
