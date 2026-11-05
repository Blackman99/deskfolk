/**
 * Stills and clips of the real app, cut from live.ts films. By default only the still: the screen
 * the last step ends on (the chat, its flow board and the teaser side by side), cropped to the
 * stage, which the OG studio (/og/<lang>) and the README's desk shots start from. With `--steps`,
 * also a clip of each step named: its bars cropped to the stage, sped up so none lasts much past
 * 10 s, H.264 at 30 fps without sound; the step where you walk away keeps only a moment of the
 * empty desktop it waited on and ends soon after the window is back. Both keep the film's pixel
 * density (live.ts records at 2× by default).
 *
 *   node scripts/film/clips.ts [--from film-out] [--sets zh-light,zh-dark,en-light,en-dark] [--steps 4,6,9] [--away 6]
 *
 * Reads <from>/deskfolk-live-<lang>-<theme>.{silent.mp4,timeline.json,cues.json} (live.ts film, not the
 * recut) and writes static/media/walkthrough/<lang>-<theme>/hero.jpg, plus <NN>.mp4 for each of `--steps`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Cue, Timeline } from './audio.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANDING = path.resolve(HERE, '../..');

const { values: opts } = parseArgs({
  options: {
    from: { type: 'string', default: path.join(LANDING, 'film-out') },
    sets: { type: 'string', default: 'zh-light,zh-dark,en-light,en-dark' },
    steps: { type: 'string', default: '' },
    away: { type: 'string', default: '6' }
  }
});

/** The stage on the 1920×1080 film page (see /film/<lang>/live), a row short of its 925 so H.264 takes it. */
const STAGE = { x: 390, y: 77, w: 1480, h: 924 };
const FPS = 30;
/**
 * Quality for the 2× clips. Mostly still UI text at twice the pixels, where 30 reads as crisp as 27
 * frame by frame; a set comes to about 2.5× the bytes of the old 1× clips at the same setting, and
 * the walkthrough only loads the step on screen and the next one.
 */
const CRF = 30;
/** A clip longer than this is sped up, in half steps, until it fits under MAX_SECONDS. */
const SPEED_FROM = 11;
const MAX_SECONDS = 10;
/** The film's `.stage.out` fade starts on the trust bar; stop a frame short of it. */
const TAIL_TRIM = 0.05;
/**
 * The away step (story.ts's `leave` … `back`, step 6) holds the empty desktop for as long as the
 * render really took, half a minute to a few. Speeding that up still shows nothing for ten
 * seconds, so its clip plays at 1× and keeps this much of the stillness, cut inside it.
 */
const AWAY_SECONDS = 1.5;
/** From `leave`'s tray tick until its menu has closed and faded (film-stage.ts: 700 ms + the fade). */
const MENU_CLOSED = 0.9;
/** The cut resumes this long before `back`'s tray tick, on the same still frame. */
const BACK_LEAD = 0.3;
/** After `back`'s tick the window is in place by MENU_CLOSED; it stays this long, not until the bar line. */
const BACK_SHOWN = 1.2;

type Clip = { seconds: number; speed: number };

/** The film's device pixels per CSS pixel: its width over the 1920 CSS px of the film page. */
function scaleOf(film: string): number {
  const width = Number(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', film])
      .toString()
      .trim()
  );
  return width / 1920;
}

/** The stage in the film's own pixels, kept even for H.264. */
function cropFor(scale: number): string {
  const even = (n: number) => Math.round((n * scale) / 2) * 2;
  return `crop=${even(STAGE.w)}:${even(STAGE.h)}:${even(STAGE.x)}:${even(STAGE.y)}`;
}

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'inherit' });
}

function speedFor(seconds: number): number {
  if (seconds <= SPEED_FROM) return 1;
  return Math.ceil((seconds / MAX_SECONDS) * 2) / 2;
}

/**
 * The stillness of an away step, in seconds from its start: from `leave`'s tray menu closing to
 * just before `back` opens it again (the first and last `tick` cues in the step); and where the clip
 * ends, a moment after the window is back.
 */
function awayStill(cues: Cue[], from: number, to: number): { cut: number; resume: number; end: number } {
  const ticks = cues.filter((c) => c.type === 'tick' && c.t / 1000 >= from && c.t / 1000 < to).map((c) => c.t / 1000 - from);
  if (ticks.length < 2) throw new Error(`no leave and back tray ticks in ${from.toFixed(1)}–${to.toFixed(1)} s`);
  const still = ticks[0] + MENU_CLOSED;
  const resume = ticks[ticks.length - 1] - BACK_LEAD;
  const end = Math.min(to - from, ticks[ticks.length - 1] + MENU_CLOSED + BACK_SHOWN);
  if (resume - still <= AWAY_SECONDS) return { cut: resume, resume, end };
  return { cut: still + AWAY_SECONDS - BACK_LEAD, resume, end };
}

const wanted = new Set(opts.steps.split(',').filter(Boolean).map(Number));
const away = new Set(opts.away.split(',').filter(Boolean).map(Number));

for (const set of opts.sets.split(',').filter(Boolean)) {
  const [lang, theme] = set.split('-');
  const tag = `deskfolk-live-${lang}-${theme}`;
  const film = path.join(opts.from, `${tag}.silent.mp4`);
  const timeline = JSON.parse(readFileSync(path.join(opts.from, `${tag}.timeline.json`), 'utf-8')) as Timeline;
  const cues = JSON.parse(readFileSync(path.join(opts.from, `${tag}.cues.json`), 'utf-8')) as Cue[];
  const scale = scaleOf(film);
  const crop = cropFor(scale);
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
    const still = away.has(i + 1) ? awayStill(cues, from, ends[i]) : null;
    const kept = still ? still.end - (still.resume - still.cut) : length;
    const speed = speedFor(kept);
    steps.push({ seconds: Math.round((kept / speed) * 10) / 10, speed });
    if (!wanted.has(i + 1)) return;
    const out = path.join(dir, `${String(i + 1).padStart(2, '0')}.mp4`);
    const encode = [
      '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF), '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out
    ];
    if (still) {
      // Up to the cut and on from the resume to the end: both ends of the join are the same still desktop.
      ffmpeg([
        '-ss', from.toFixed(3), '-t', still.cut.toFixed(3), '-i', film,
        '-ss', (from + still.resume).toFixed(3), '-t', (still.end - still.resume).toFixed(3), '-i', film,
        '-filter_complex',
        `[0:v]${crop},setpts=PTS-STARTPTS[a];[1:v]${crop},setpts=PTS-STARTPTS[b];` +
          `[a][b]concat=n=2:v=1:a=0,setpts=PTS/${speed},fps=${FPS}[v]`,
        '-map', '[v]', ...encode
      ]);
    } else {
      ffmpeg([
        '-ss', from.toFixed(3), '-t', length.toFixed(3), '-i', film,
        '-vf', `${crop},setpts=(PTS-STARTPTS)/${speed},fps=${FPS}`,
        ...encode
      ]);
    }
    bytes += statSync(out).size;
  });

  // The first screen: where the last step ends, just before the trust card fades the stage.
  const hero = path.join(dir, 'hero.jpg');
  ffmpeg(['-ss', (ends[ends.length - 1] - 0.2).toFixed(3), '-i', film, '-frames:v', '1', '-vf', crop, '-q:v', '3', hero]);
  bytes += statSync(hero).size;

  console.log(
    `[clips] ${set} @${scale}×: ${steps.map((s, i) => [s, i] as const).filter(([, i]) => wanted.has(i + 1)).map(([s, i]) => `${i + 1}:${s.seconds}s${s.speed > 1 ? `@${s.speed}×` : ''}`).join(' ')} · ${(bytes / 1e6).toFixed(1)} MB`
  );
}
