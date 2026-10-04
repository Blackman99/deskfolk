// Capture promo.html frame by frame (see build.sh and docs/development.md).
//   node render.mjs --lang zh --out <dir> [--fps 60] [--workers 8]   -> <dir>/frames-<lang>/%05d.jpg + <dir>/cues-<lang>.json
//   node render.mjs --lang zh --out <dir> --stills 5.5,24.9          -> <dir>/stills/<lang>-<t>.png
//   node render.mjs --lang zh --out <dir> --poster 37.3              -> <dir>/poster-<lang>.png (play button + duration)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const lang = args.lang || 'zh';
const fps = Number(args.fps || 60);
const workers = Number(args.workers || 8);
const out = path.resolve(args.out || path.join(here, '../../film-out/motion'));
fs.mkdirSync(out, { recursive: true });

// promo.html asks for fonts/<file>; those are the system's own font files, never copied into the repo.
const SYSTEM_FONTS = '/System/Library/Fonts';
const types = { '.html': 'text/html; charset=utf-8', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = name.startsWith('/fonts/') ? path.join(SYSTEM_FONTS, path.basename(name)) : path.join(here, path.basename(name));
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/promo.html?lang=${lang}`;

const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text'] });
async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.error('pageerror', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('console', m.text()); });
  await page.goto(url);
  await page.evaluate(() => window.ready);
  return page;
}

const first = await openPage();
const meta = await first.evaluate(() => ({ duration: window.DURATION, cues: window.CUES }));

if (args.stills) {
  fs.mkdirSync(path.join(out, 'stills'), { recursive: true });
  const times = String(args.stills).split(',').map(Number);
  for (const t of times) {
    await first.evaluate(t => window.seek(t), t);
    await first.screenshot({ path: path.join(out, 'stills', `${lang}-${t.toFixed(2)}.png`) });
  }
  console.log(`${times.length} stills in ${path.join(out, 'stills')}`);
} else if (args.poster) {
  const t = Number(args.poster);
  await first.evaluate(({ t, duration }) => {
    window.seek(t);
    const m = Math.floor(duration / 60), s = String(Math.round(duration % 60)).padStart(2, '0');
    const o = document.createElement('div');
    o.innerHTML = `
      <div style="position:absolute;left:960px;top:712px;width:170px;height:170px;margin:-85px 0 0 -85px;border-radius:50%;
        background:rgba(255,255,255,.96);box-shadow:0 18px 50px rgba(0,22,28,.45);display:flex;align-items:center;justify-content:center">
        <svg width="64" height="72" viewBox="0 0 64 72" style="margin-left:12px"><path d="M6 4 L60 36 L6 68 Z" fill="#0f6776" stroke="#0f6776" stroke-width="8" stroke-linejoin="round"/></svg>
      </div>
      <div style="position:absolute;right:56px;bottom:48px;padding:12px 22px;border-radius:14px;background:rgba(4,30,36,.72);
        color:#fff;font:600 40px 'Folk Rounded',sans-serif;letter-spacing:.5px">${m}:${s}</div>`;
    o.style.cssText = 'position:absolute;inset:0;z-index:70';
    document.getElementById('stage').appendChild(o);
  }, { t, duration: meta.duration });
  await first.screenshot({ path: path.join(out, `poster-${lang}.png`) });
  console.log(`poster at ${t}s -> ${path.join(out, `poster-${lang}.png`)}`);
} else {
  fs.writeFileSync(path.join(out, `cues-${lang}.json`), JSON.stringify({ duration: meta.duration, cues: meta.cues }, null, 1));
  const frames = path.join(out, `frames-${lang}`);
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  const total = Math.round(meta.duration * fps);
  const pages = [first];
  for (let i = 1; i < workers; i++) pages.push(await openPage());
  let next = 0, done = 0;
  const started = Date.now();
  await Promise.all(pages.map(async page => {
    while (next < total) {
      const f = next++;
      await page.evaluate(t => window.seek(t), f / fps);
      await page.screenshot({ path: path.join(frames, `${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 94 });
      if (++done % 1000 === 0) console.log(`${done}/${total} frames`);
    }
  }));
  console.log(`${total} frames in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
await browser.close();
server.close();
