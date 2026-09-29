/**
 * Recuts a live film: steps that take long in real time (the team's many hops while the poster
 * and teaser are made) are fast-forwarded to whole bars, with a speed badge on the stage while
 * they run, then the music is composed to the new timeline and the sound laid on the moved cues.
 *
 *   node scripts/film/recut.ts [--lang zh] [--theme light] [--speed 6=4,3=2.5] [--music track.mp3]
 *
 * Reads film-out/deskfolk-live-<lang>-<theme>.{silent.mp4,timeline.json,cues.json} from
 * live.ts film and writes film-out/deskfolk-live-<lang>-<theme>-cut.mp4.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import type { Cue, Timeline } from './audio.ts';
import { scoreAndMux } from './mux.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANDING = path.resolve(HERE, '../..');

const { values: opts } = parseArgs({
  options: {
    lang: { type: 'string', default: 'zh' },
    theme: { type: 'string', default: 'light' },
    speed: { type: 'string', default: '6=4,3=2.5' },
    music: { type: 'string' },
    out: { type: 'string', default: path.join(LANDING, 'film-out') }
  }
});
const outDir = path.resolve(opts.out);
const tag = `deskfolk-live-${opts.lang === 'en' ? 'en' : 'zh'}-${opts.theme === 'dark' ? 'dark' : 'light'}`;
const speeds = new Map(
  opts.speed
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split('=').map(Number) as [number, number])
);

/** Where the stage's top-right corner is on the 1920×1080 film page (see /film/<lang>/live), in CSS px. */
const STAGE_RIGHT = 390 + 1480;
const STAGE_TOP = 77;
/** The recording's device pixels per CSS pixel (live.ts --scale); badges and their place follow it. */
const SCALE =
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', path.join(outDir, `${tag}.silent.mp4`)])
      .toString()
      .trim()
  ) / 1920;

const timeline = JSON.parse(readFileSync(path.join(outDir, `${tag}.timeline.json`), 'utf-8')) as Timeline;
const cues = JSON.parse(readFileSync(path.join(outDir, `${tag}.cues.json`), 'utf-8')) as Cue[];
const bar = timeline.barMs;
const { bars } = timeline;

type Segment = { from: number; to: number; step: number | null };
const segments: Segment[] = [{ from: bars.logo, to: bars.steps[0], step: null }];
bars.steps.forEach((start, i) => segments.push({ from: start, to: bars.steps[i + 1] ?? bars.trust, step: i + 1 }));
segments.push({ from: bars.trust, to: timeline.totalBars, step: null });

let cursor = 0;
const plan = segments.map((s) => {
  const length = s.to - s.from;
  const wanted = s.step ? (speeds.get(s.step) ?? 1) : 1;
  const newLength = Math.max(1, Math.round(length / wanted));
  const factor = length / newLength;
  const at = cursor;
  cursor += newLength;
  return { ...s, length, newLength, factor, at };
});

/** Cues move with their segment; a fast-forwarded one keeps only the sounds that mark events. */
const KEEP_FAST = new Set(['receive', 'alert', 'notify', 'whoosh', 'pop']);
const moved: Cue[] = [];
for (const c of cues) {
  const p = plan.find((s) => c.t >= s.from * bar && c.t < s.to * bar);
  if (!p) continue;
  if (p.factor > 1.2 && !KEEP_FAST.has(c.type)) continue;
  const t = Math.round(p.at * bar + (c.t - p.from * bar) / p.factor);
  const last = moved[moved.length - 1];
  if (p.factor > 1.2 && last && last.type === c.type && t - last.t < 250) continue;
  moved.push({ t, type: c.type });
}

const newTimeline: Timeline = {
  ...timeline,
  totalBars: cursor,
  durationMs: cursor * bar,
  bars: {
    logo: 0,
    hero: bars.hero,
    steps: plan.filter((p) => p.step).map((p) => p.at),
    trust: plan[plan.length - 1].at,
    end: plan[plan.length - 1].at + (bars.end - bars.trust),
    tail: plan[plan.length - 1].at + (bars.tail - bars.trust)
  }
};

async function badges(): Promise<Map<number, string>> {
  const files = new Map<number, string>();
  const shown = [...new Set(plan.filter((p) => p.factor > 1.2).map((p) => Math.round(p.factor)))];
  if (!shown.length) return files;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 400, height: 120 }, deviceScaleFactor: SCALE });
  for (const f of shown) {
    await page.setContent(`<html><body style="margin:0;background:transparent">
      <div id="b" style="display:inline-flex;align-items:center;gap:10px;padding:10px 18px;border-radius:999px;
        background:rgba(18,28,32,.78);color:#fff;font:600 24px -apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;
        box-shadow:0 8px 24px -8px rgba(0,0,0,.4)">
        <svg width="26" height="18" viewBox="0 0 26 18"><path d="M1 1l11 8-11 8zM13 1l11 8-11 8z" fill="#fff"/></svg>${f}×
      </div></body></html>`);
    const file = path.join(outDir, `badge-${f}x.png`);
    await page.locator('#b').screenshot({ path: file, omitBackground: true });
    files.set(f, file);
  }
  await browser.close();
  return files;
}

async function main() {
  const badgeFiles = await badges();
  const inputs = ['-i', path.join(outDir, `${tag}.silent.mp4`)];
  const parts: string[] = [`[0:v]split=${plan.length}${plan.map((_, i) => `[s${i}]`).join('')}`];
  plan.forEach((p, i) => {
    parts.push(`[s${i}]trim=start=${(p.from * bar) / 1000}:end=${(p.to * bar) / 1000},setpts=(PTS-STARTPTS)/${p.factor.toFixed(6)}[v${i}]`);
  });
  parts.push(`${plan.map((_, i) => `[v${i}]`).join('')}concat=n=${plan.length}:v=1:a=0,fps=60[cut]`);
  let last = 'cut';
  let n = 1;
  for (const [f, file] of badgeFiles) {
    inputs.push('-i', file);
    const spans = plan
      .filter((p) => p.factor > 1.2 && Math.round(p.factor) === f)
      .map((p) => `between(t,${((p.at * bar) / 1000 + 0.3).toFixed(2)},${(((p.at + p.newLength) * bar) / 1000 - 0.3).toFixed(2)})`)
      .join('+');
    parts.push(`[${last}][${n}:v]overlay=x=${Math.round((STAGE_RIGHT - 24) * SCALE)}-w:y=${Math.round((STAGE_TOP + 22) * SCALE)}:enable='${spans}'[o${n}]`);
    last = `o${n}`;
    n++;
  }
  const cutPath = path.join(outDir, `${tag}-cut.silent.mp4`);
  execFileSync(
    'ffmpeg',
    ['-y', '-v', 'error', ...inputs, '-filter_complex', parts.join(';'), '-map', `[${last}]`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', cutPath],
    { stdio: 'inherit' }
  );
  writeFileSync(path.join(outDir, `${tag}-cut.timeline.json`), JSON.stringify(newTimeline, null, 2));
  writeFileSync(path.join(outDir, `${tag}-cut.cues.json`), JSON.stringify(moved, null, 2));
  for (const p of plan) {
    if (p.factor !== 1) console.log(`[recut] step ${p.step}: ${p.length} bars → ${p.newLength} (${p.factor.toFixed(2)}×)`);
  }
  console.log(`[recut] ${timeline.totalBars} bars → ${newTimeline.totalBars} bars (${(newTimeline.durationMs / 1000).toFixed(1)} s)`);
  const film = scoreAndMux({ silentPath: cutPath, timeline: newTimeline, cues: moved, outDir, tag: `${tag}-cut`, music: opts.music });
  console.log(`[recut] film: ${film}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
