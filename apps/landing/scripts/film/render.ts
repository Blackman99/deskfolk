/**
 * Renders the promo film: starts a landing dev server, opens /film/<lang> in headless
 * Chromium under a fake clock, and steps it one frame at a time — timers through
 * Playwright's clock, CSS and Svelte transitions by pausing every animation and seeking
 * it — so each frame is exact however slow the capture is. Frames go straight into
 * ffmpeg; the soundtrack (audio.ts) is composed to the same timeline and mixed with
 * interface sounds on the cues the page recorded.
 *
 *   pnpm --filter @real-bot/landing film                       zh, light, 1080p60
 *   pnpm --filter @real-bot/landing film -- --lang en --theme dark
 *   pnpm --filter @real-bot/landing film -- --music track.mp3  your own track under the interface sounds
 *   pnpm --filter @real-bot/landing film -- --remix --music track.mp3   keep the last full render's picture, redo the sound
 *   pnpm --filter @real-bot/landing film -- --from 20 --seconds 8 --fps 30   a quick look at one stretch
 *
 * Needs ffmpeg on PATH and Playwright's Chromium (`npx playwright install chromium`).
 * Output lands in apps/landing/film-out/.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { composeMusic, composeSfx, loadMusic, mixdown, writeWav, type Cue, type Timeline } from './audio.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANDING = path.resolve(HERE, '../..');
// SvelteKit and Tailwind find their configs from the working directory.
process.chdir(LANDING);

const { values: opts } = parseArgs({
  options: {
    lang: { type: 'string', default: 'zh' },
    theme: { type: 'string', default: 'light' },
    fps: { type: 'string', default: '60' },
    scale: { type: 'string', default: '1' },
    music: { type: 'string' },
    silent: { type: 'boolean', default: false },
    remix: { type: 'boolean', default: false },
    from: { type: 'string', default: '0' },
    seconds: { type: 'string' },
    port: { type: 'string', default: '5288' },
    url: { type: 'string' },
    out: { type: 'string', default: path.join(LANDING, 'film-out') }
  }
});

const lang = opts.lang === 'en' ? 'en' : 'zh';
const theme = opts.theme === 'dark' ? 'dark' : 'light';
const fps = Number(opts.fps);
const scale = Number(opts.scale);
const fromMs = Math.round(Number(opts.from) * 1000);
const outDir = path.resolve(opts.out);
mkdirSync(outDir, { recursive: true });

const W = 1920;
const H = 1080;

/**
 * Runs in the page before anything else. Every animation is paused the first time a
 * step sees it and from then on only moves when the renderer says a frame has passed.
 */
const DRIVER = `(() => {
  const seen = new WeakMap();
  window.__filmDriver = {
    step(dt) {
      for (const a of document.getAnimations()) {
        let st = seen.get(a);
        if (!st) {
          if (a.playState === 'idle') continue;
          a.pause();
          a.currentTime = 0;
          seen.set(a, { time: 0, done: false });
          continue;
        }
        if (st.done) continue;
        st.time += dt;
        const end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
        if (Number.isFinite(end) && st.time >= end) {
          st.done = true;
          a.finish();
        } else {
          a.currentTime = st.time;
        }
      }
    }
  };
})();`;

function log(msg: string) {
  process.stdout.write(`[film] ${msg}\n`);
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`dev server did not answer at ${url}`);
}

/**
 * A dev server of our own, with no file watching and no HMR: another edit landing in
 * the tree mid-render (a version bump in package.json restarts Vite) must not reload the page.
 */
async function startDevServer(port: number): Promise<ViteDevServer> {
  const server = await createServer({
    root: LANDING,
    configFile: path.join(LANDING, 'vite.config.ts'),
    logLevel: 'warn',
    server: { port, strictPort: true, hmr: false, watch: null }
  });
  await server.listen();
  process.on('SIGINT', () => {
    void server.close().finally(() => process.exit(130));
  });
  return server;
}

function write(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (stream.write(chunk)) resolve();
    else stream.once('drain', () => resolve());
  });
}

function loudnormArgs(file: string): string {
  const target = 'I=-14:TP=-1.5:LRA=11';
  const res = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']);
  const err = res.stderr.toString();
  if (res.status !== 0) throw new Error(`ffmpeg loudness pass failed:\n${err}`);
  const json = JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1));
  return (
    `loudnorm=${target}:measured_I=${json.input_i}:measured_TP=${json.input_tp}` +
    `:measured_LRA=${json.input_lra}:measured_thresh=${json.input_thresh}:offset=${json.target_offset}:linear=true`
  );
}

type Capture = { tag: string; timeline: Timeline; cues: Cue[]; silentPath: string; partial: boolean; lengthMs: number };

const tag = `deskfolk-${lang}-${theme}-${H * scale}p${fps}`;

async function capture(): Promise<Capture> {
  const own = !opts.url;
  const base = opts.url ?? `http://localhost:${opts.port}`;
  const pageUrl = `${base}/film/${lang}?theme=${theme}`;
  const vite = own ? await startDevServer(Number(opts.port)) : null;
  try {
    log(`waiting for ${pageUrl}`);
    await waitForServer(pageUrl, 90_000);
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: scale,
      colorScheme: theme,
      reducedMotion: 'no-preference'
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => log(`page error: ${e.message}`));
    await page.addInitScript(DRIVER);
    await page.clock.install({ time: new Date('2026-09-26T06:00:00Z') });
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __film?: { ready: boolean } }).__film?.ready, null, {
      polling: 100,
      timeout: 60_000
    });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 1000);

    const timeline = (await page.evaluate(
      () => (window as unknown as { __film: { timeline: Timeline } }).__film.timeline
    )) as Timeline;
    const totalMs = timeline.durationMs;
    const lengthMs = Math.min(totalMs - fromMs, opts.seconds ? Number(opts.seconds) * 1000 : Infinity);
    const frames = Math.round((lengthMs / 1000) * fps);
    log(`${(totalMs / 1000).toFixed(1)} s film, rendering ${(lengthMs / 1000).toFixed(1)} s from ${fromMs / 1000} s: ${frames} frames at ${fps} fps`);

    await page.evaluate(() => (window as unknown as { __film: { start: () => void } }).__film.start());
    let reloaded = false;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) reloaded = true;
    });
    const step = (dt: number) =>
      page.evaluate((d) => (window as unknown as { __filmDriver: { step: (d: number) => void } }).__filmDriver.step(d), dt);

    // Fast-forward to --from without capturing, still stepping animations so they land where they should.
    let elapsed = 0;
    while (elapsed < fromMs) {
      const dt = Math.min(50, fromMs - elapsed);
      await page.clock.runFor(dt);
      await step(dt);
      elapsed += dt;
    }

    const partial = fromMs > 0 || lengthMs < totalMs;
    const silentPath = path.join(outDir, `${tag}${partial ? '-part' : ''}.silent.mp4`);
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-y', '-v', 'error',
        '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(fps), '-i', '-',
        '-vf', 'scale=out_color_matrix=bt709:flags=lanczos,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-tune', 'animation',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-movflags', '+faststart',
        silentPath
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] }
    );
    const encoded = new Promise<void>((resolve, reject) =>
      ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
    );

    const cdp = await context.newCDPSession(page);
    const started = Date.now();
    let clock = 0;
    for (let i = 0; i < frames; i++) {
      const target = Math.round((i * 1000) / fps);
      const dt = target - clock;
      if (dt > 0) {
        await page.clock.runFor(dt);
        await step(dt);
        clock = target;
      } else if (i === 0) {
        await step(0);
      }
      if (reloaded) throw new Error(`the page navigated away at frame ${i}; the film state is gone`);
      // Without a scaled clip, a raw CDP capture comes back in CSS pixels whatever the device scale.
      const shot = (await cdp.send('Page.captureScreenshot', {
        format: 'png',
        optimizeForSpeed: true,
        clip: { x: 0, y: 0, width: W, height: H, scale }
      })) as { data: string };
      await write(ffmpeg.stdin!, Buffer.from(shot.data, 'base64'));
      if (i % (fps * 2) === 0 || i === frames - 1) {
        const rate = (i + 1) / ((Date.now() - started) / 1000);
        log(`frame ${i + 1}/${frames}  ${rate.toFixed(1)} fps  eta ${Math.round((frames - i - 1) / rate)} s`);
      }
    }
    ffmpeg.stdin!.end();
    await encoded;

    // Cues from a partial render only cover what was played, so the full soundtrack needs a full render.
    const cues = (await page.evaluate(() => (window as unknown as { __film: { cues: Cue[] } }).__film.cues)) as Cue[];
    await browser.close();
    writeFileSync(path.join(outDir, `${tag}.timeline.json`), JSON.stringify(timeline, null, 2));
    writeFileSync(path.join(outDir, `${tag}${partial ? '-part' : ''}.cues.json`), JSON.stringify(cues, null, 2));
    log(`video: ${silentPath} (${cues.length} sound cues)`);
    return { tag, timeline, cues, silentPath, partial, lengthMs };
  } finally {
    await vite?.close();
  }
}

/** Composes (or loads) the music, lays the interface sounds on the cues, normalizes and muxes. */
function soundtrack({ tag, timeline, cues, silentPath, partial, lengthMs }: Capture): void {
  const totalMs = timeline.durationMs;
  const music = opts.music ? loadMusic(path.resolve(opts.music), totalMs) : composeMusic(timeline);
  const sfx = composeSfx(cues, totalMs);
  const mix = mixdown(music, sfx, -27);
  const suffix = partial ? '-part' : '';
  const mixPath = path.join(outDir, `${tag}${suffix}.mix.wav`);
  writeWav(path.join(outDir, `${tag}.music.wav`), music);
  writeWav(path.join(outDir, `${tag}${suffix}.sfx.wav`), sfx);
  writeWav(mixPath, mix);

  const finalPath = path.join(outDir, `${tag}${suffix}.mp4`);
  const norm = loudnormArgs(mixPath);
  execFileSync(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-i', silentPath,
      '-ss', String(fromMs / 1000), '-t', String(lengthMs / 1000), '-i', mixPath,
      '-map', '0:v', '-map', '1:a',
      '-af', `${norm},aresample=48000`,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
      '-shortest', '-movflags', '+faststart',
      finalPath
    ],
    { stdio: 'inherit' }
  );
  log(`film: ${finalPath}`);
}

/** --remix: reuse a full render's picture and cues, redo only the sound (say, with --music). */
function previousCapture(): Capture {
  const read = (file: string) => JSON.parse(readFileSync(path.join(outDir, file), 'utf-8'));
  const timeline = read(`${tag}.timeline.json`) as Timeline;
  return {
    tag,
    timeline,
    cues: read(`${tag}.cues.json`) as Cue[],
    silentPath: path.join(outDir, `${tag}.silent.mp4`),
    partial: false,
    lengthMs: timeline.durationMs
  };
}

async function main() {
  if (opts.remix) {
    soundtrack(previousCapture());
    return;
  }
  const shot = await capture();
  if (!opts.silent) soundtrack(shot);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
