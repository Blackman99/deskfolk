// Captures the 0.2.0 release film's task map shot from the app's own MapScene, one PNG per film frame.
//   node capture.mjs --lang zh|en --messenger <apps/messenger of a checkout> [--frames 150] [--port 5281] [--out <dir>]
// It starts that checkout's visual-harness Vite (vite.visual.config.ts) on its own port and serves story.js in place
// of the harness's taskmap-scene story. Run it against a worktree's messenger, never the tree a dev server is
// running from: the harness shares that tree's Vite cache. The frames go to <out> (default
// film-out/release-0.2/map-<lang>/NNNN.png), where render.mjs serves them to film.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const lang = opt('--lang', 'zh');
const frames = Number(opt('--frames', 150));
const port = Number(opt('--port', 5281));
const messenger = path.resolve(opt('--messenger', path.resolve(HERE, '../../../../messenger')));
const OUT = process.env.RELEASE_OUT || path.resolve(HERE, '../../../film-out/release-0.2');
const out = path.resolve(opt('--out', path.join(OUT, `map-${lang}`)));
const FPS = 30;
const story = fs.readFileSync(path.join(HERE, 'story.js'), 'utf8');
const W = 1300, H = 604;

fs.mkdirSync(out, { recursive: true });
const vite = spawn(path.join(messenger, 'node_modules/.bin/vite'), ['--config', 'vite.visual.config.ts', '--port', String(port), '--strictPort'], { cwd: messenger, stdio: ['ignore', 'pipe', 'inherit'] });
const base = `http://localhost:${port}/tests/visual/index.html`;
try {
  for (let i = 0; ; i++) {
    if (i > 120) throw new Error('the harness Vite did not come up');
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.route('**/tests/visual/taskmap-scene-story.ts*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: story }));
  const t0 = Date.now();
  for (let f = 0; f < frames; f++) {
    await page.goto(`${base}?story=taskmap-scene&theme=light&lang=${lang}&f=${f}&n=${frames}`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'yes', null, { timeout: 30000 });
    // The characters' work loops, posed at this frame's time, so the shot plays them through.
    await page.evaluate(async (ms) => {
      await document.fonts.ready;
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, (f / FPS) * 1000);
    await page.screenshot({ path: path.join(out, `${String(f + 1).padStart(4, '0')}.png`), clip: { x: 0, y: 0, width: W, height: H } });
    if ((f + 1) % 30 === 0) console.log(`${f + 1}/${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  await browser.close();
  console.log(`${out}: ${frames} frames`);
} finally {
  vite.kill();
}
