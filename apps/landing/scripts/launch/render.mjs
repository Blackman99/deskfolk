// Renders film.html frame by frame: every frame is film.seek(t), captured over CDP and piped to ffmpeg.
//   node render.mjs --lang zh|en [--fps 60] [--workers 8] [--out <file.mp4>]   → <out>, plus <lang>-cues.json for mix.py
//   node render.mjs --lang zh --stills 0,2.5,11.8 [--dir <folder>]            → PNG stills
// Work files go to apps/landing/film-out/launch (LAUNCH_OUT overrides). The fonts are the Mac's own SF Pro and SF Mono,
// served from /System/Library over /fonts/* (file:// font loads are blocked); PingFang SC is used by name. Never copy them
// into the repo.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.LAUNCH_OUT || path.resolve(HERE, '../../film-out/launch');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const lang = opt('--lang', 'zh');
const fps = Number(opt('--fps', 60));
const workers = Number(opt('--workers', 8));
const stills = opt('--stills', null);

const FONTS = { 'SFNS.ttf': '/System/Library/Fonts/SFNS.ttf', 'SFNSMono.ttf': '/System/Library/Fonts/SFNSMono.ttf' };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = url.startsWith('/fonts/') ? FONTS[url.slice(7)] : path.join(HERE, url === '/' ? 'film.html' : path.normalize(url));
    if (!file || (!url.startsWith('/fonts/') && !file.startsWith(HERE)) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function openPage(browser, origin) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('pageerror', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('console', m.text()); });
  await page.goto(`${origin}/film.html?lang=${lang}`);
  await page.waitForFunction(() => window.film && window.film.ready === true, null, { timeout: 30000 });
  return { page, cdp: await ctx.newCDPSession(page) };
}

async function grab({ page, cdp }, t) {
  await page.evaluate(t => window.film.seek(t), t);
  // raw CDP captures CSS pixels unless clip.scale is given
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 }, optimizeForSpeed: true });
  return Buffer.from(data, 'base64');
}

const run = (cmd, a) => new Promise((r, j) => spawn(cmd, a, { stdio: 'inherit' }).on('close', c => (c === 0 ? r() : j(new Error(`${cmd} exited ${c}`)))));

fs.mkdirSync(OUT, { recursive: true });
const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'] });
try {
  if (stills) {
    const dir = path.resolve(opt('--dir', path.join(OUT, 'stills')));
    fs.mkdirSync(dir, { recursive: true });
    const p = await openPage(browser, origin);
    for (const s of stills.split(',')) {
      const f = path.join(dir, `${lang}-${Number(s).toFixed(2).padStart(5, '0')}.png`);
      fs.writeFileSync(f, await grab(p, Number(s)));
      console.log(f);
    }
  } else {
    const probe = await openPage(browser, origin);
    const meta = await probe.page.evaluate(() => ({ duration: window.film.duration, cues: window.film.cues, keys: window.film.keys }));
    fs.writeFileSync(path.join(OUT, `${lang}-cues.json`), JSON.stringify(meta, null, 1));
    await probe.page.context().close();
    const total = Math.round(meta.duration * fps);
    const out = path.resolve(opt('--out', path.join(OUT, `${lang}-silent.mp4`)));
    const segDir = path.join(OUT, `seg-${lang}`);
    fs.mkdirSync(segDir, { recursive: true });
    const per = Math.ceil(total / workers), t0 = Date.now();
    let done = 0;
    // each worker renders a contiguous range into its own near-lossless segment; the segments are joined without re-encoding
    const segs = (await Promise.all(Array.from({ length: workers }, async (_, w) => {
      const a = w * per, b = Math.min(total, a + per);
      if (a >= b) return null;
      const p = await openPage(browser, origin);
      const seg = path.join(segDir, `seg-${String(w).padStart(2, '0')}.mp4`);
      const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'fast', '-crf', '8', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', seg], { stdio: ['pipe', 'inherit', 'inherit'] });
      for (let i = a; i < b; i++) {
        if (!ff.stdin.write(await grab(p, i / fps))) await new Promise(r => ff.stdin.once('drain', r));
        if (++done % 300 === 0) console.log(`${done}/${total} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
      ff.stdin.end();
      await new Promise((r, j) => ff.on('close', c => (c === 0 ? r() : j(new Error('ffmpeg ' + c)))));
      await p.page.context().close();
      return seg;
    }))).filter(Boolean);
    const list = path.join(segDir, 'list.txt');
    fs.writeFileSync(list, segs.map(s => `file '${s}'`).join('\n'));
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
    console.log(`${out}: ${total} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
} finally {
  await browser.close();
  server.close();
}
