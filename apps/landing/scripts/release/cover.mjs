// Share covers for the 0.1.0 film, one per platform size and language: cover.html captured at each size.
//   node cover.mjs [--lang zh|en]   → <out>/covers/<lang>-<name>-<w>x<h>.jpg (both languages when --lang is left out)
// Served like render.mjs: the page and film.css from here, the fonts from /System/Library, the reel's sprites.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.RELEASE_OUT || path.resolve(HERE, '../../film-out/release');
const REEL = process.env.REEL_OUT || path.resolve(HERE, '../../film-out/reel');
const args = process.argv.slice(2);
const langs = args.includes('--lang') ? [args[args.indexOf('--lang') + 1]] : ['zh', 'en'];
// name, width, height: the sizes the platforms ask for
const SIZES = [
  ['16x9', 1920, 1080], // YouTube, Bilibili, X, a landscape WeChat Channels video
  ['16x10', 1920, 1200], // Bilibili's recommended cover ratio
  ['4x3', 1440, 1080],
  ['1x1', 1080, 1080], // Weibo, Moments, Instagram
  ['3x4', 1080, 1440], // Xiaohongshu, WeChat Channels
  ['9x16', 1080, 1920] // Douyin, Shorts, Reels
];

const FONTS = { 'SFNS.ttf': '/System/Library/Fonts/SFNS.ttf', 'SFNSMono.ttf': '/System/Library/Fonts/SFNSMono.ttf' };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const root = url.startsWith('/sprites/') ? REEL : HERE;
  const file = url.startsWith('/fonts/') ? FONTS[url.slice(7)] : path.join(root, path.normalize(url));
  if (!file || (!url.startsWith('/fonts/') && !file.startsWith(root)) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const dir = path.join(OUT, 'covers');
fs.mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--force-color-profile=srgb'] });
try {
  for (const lang of langs) for (const [name, w, h] of SIZES) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    page.on('pageerror', e => console.error('pageerror', e.message));
    await page.goto(`${origin}/cover.html?lang=${lang}&w=${w}&h=${h}`);
    await page.waitForFunction(() => window.coverReady === true, null, { timeout: 30000 });
    const file = path.join(dir, `${lang}-${name}-${w}x${h}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
    await page.close();
    console.log(file);
  }
} finally {
  await browser.close();
  server.close();
}
