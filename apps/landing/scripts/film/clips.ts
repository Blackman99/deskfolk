/**
 * The homepage walkthrough's pictures, cut from live.ts films: every step's bars cropped to the
 * stage (the window without the film's titles around it), steps that run long sped up so none
 * lasts much past 10 s, H.264 at 30 fps without sound; and the four-pane screen at the end of
 * step 9 as the first screen's still.
 *
 *   node scripts/film/clips.ts [--from film-out] [--sets zh-light,zh-dark,en-light,en-dark]
 *
 * Reads <from>/deskfolk-live-<lang>-<theme>.{silent.mp4,timeline.json} (live.ts film, not the
 * recut) and writes static/media/walkthrough/<lang>-<theme>/{01…11.mp4,hero.jpg} plus
 * src/lib/demo/clips.json, which the walkthrough reads for each clip's speed and length.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Timeline } from './audio.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANDING = path.resolve(HERE, '../..');

const { values: opts } = parseArgs({
  options: {
    from: { type: 'string', default: path.join(LANDING, 'film-out') },
    sets: { type: 'string', default: 'zh-light,zh-dark,en-light,en-dark' }
  }
});

/** The stage on the 1920×1080 film page (see /film/<lang>/live), a row short of its 925 so H.264 takes it. */
const STAGE = { x: 390, y: 77, w: 1480, h: 924 };
const FPS = 30;
/** A clip longer than this is sped up, in half steps, until it fits under MAX_SECONDS. */
const SPEED_FROM = 11;
const MAX_SECONDS = 10;
/** The film's `.stage.out` fade starts on the trust bar; stop a frame short of it. */
const TAIL_TRIM = 0.05;

type Clip = { seconds: number; speed: number };
type Manifest = { width: number; height: number; sets: Record<string, { steps: Clip[] }> };

const manifestPath = path.join(LANDING, 'src/lib/demo/clips.json');
const manifest: Manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf-8'))
  : { width: STAGE.w, height: STAGE.h, sets: {} };

const crop = `crop=${STAGE.w}:${STAGE.h}:${STAGE.x}:${STAGE.y}`;

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'inherit' });
}

function speedFor(seconds: number): number {
  if (seconds <= SPEED_FROM) return 1;
  return Math.ceil((seconds / MAX_SECONDS) * 2) / 2;
}

for (const set of opts.sets.split(',').filter(Boolean)) {
  const [lang, theme] = set.split('-');
  const tag = `deskfolk-live-${lang}-${theme}`;
  const film = path.join(opts.from, `${tag}.silent.mp4`);
  const timeline = JSON.parse(readFileSync(path.join(opts.from, `${tag}.timeline.json`), 'utf-8')) as Timeline;
  const bar = timeline.barMs / 1000;
  const starts = timeline.bars.steps.map((b) => b * bar);
  const ends = [...starts.slice(1), timeline.bars.trust * bar - TAIL_TRIM];
  const dir = path.join(LANDING, 'static/media/walkthrough', set);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const steps: Clip[] = [];
  let bytes = 0;
  starts.forEach((from, i) => {
    const length = ends[i] - from;
    const speed = speedFor(length);
    const out = path.join(dir, `${String(i + 1).padStart(2, '0')}.mp4`);
    ffmpeg([
      '-ss', from.toFixed(3), '-t', length.toFixed(3), '-i', film,
      '-vf', `${crop},setpts=(PTS-STARTPTS)/${speed},fps=${FPS}`,
      '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out
    ]);
    bytes += statSync(out).size;
    steps.push({ seconds: Math.round((length / speed) * 10) / 10, speed });
  });

  // The first screen: all four panes at the end of step 9, just before the window hides.
  const hero = path.join(dir, 'hero.jpg');
  ffmpeg(['-ss', (starts[9] - 0.2).toFixed(3), '-i', film, '-frames:v', '1', '-vf', crop, '-q:v', '3', hero]);
  bytes += statSync(hero).size;

  manifest.sets[set] = { steps };
  console.log(
    `[clips] ${set}: ${steps.map((s, i) => `${i + 1}:${s.seconds}s${s.speed > 1 ? `@${s.speed}×` : ''}`).join(' ')} · ${(bytes / 1e6).toFixed(1)} MB`
  );
}

manifest.width = STAGE.w;
manifest.height = STAGE.h;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[clips] ${path.relative(LANDING, manifestPath)}`);
