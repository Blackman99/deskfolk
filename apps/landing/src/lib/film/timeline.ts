import { SCENE_BEATS, SCENE_COUNT } from '$lib/demo/scenes';

/**
 * The promo film plays the walkthrough on a clock instead of on scroll. Every part
 * starts on a bar line of the soundtrack, so the music can be composed to the cut:
 *
 *   logo · hero · steps 1..11 · trust · end card · tail
 *
 * A step lasts its last beat plus at least MIN_HOLD_MS, rounded up to whole bars.
 */

export const BPM = 96;
export const BEAT_MS = 60000 / BPM;
export const BAR_MS = BEAT_MS * 4;
export const MIN_HOLD_MS = 1200;

const LOGO_BARS = 1;
const HERO_BARS = 2;
const TRUST_BARS = 2;
const END_BARS = 2;
const TAIL_BARS = 1;

export type FilmTimeline = {
  bpm: number;
  barMs: number;
  totalBars: number;
  durationMs: number;
  /** Start bar of each part; `steps[i]` is walkthrough scene i + 1. */
  bars: { logo: number; hero: number; steps: number[]; trust: number; end: number; tail: number };
};

/** A sound the soundtrack places on the picture, in ms from the film's first frame. */
export type FilmCue = { t: number; type: CueType };

export type CueType =
  | 'click'
  | 'key'
  | 'send'
  | 'receive'
  | 'pop'
  | 'alert'
  | 'confirm'
  | 'notify'
  | 'whoosh'
  | 'tick';

export function sceneBars(scene: number): number {
  const beats = SCENE_BEATS[scene] ?? [];
  const last = beats.length > 0 ? beats[beats.length - 1] : 0;
  return Math.ceil((last + MIN_HOLD_MS) / BAR_MS);
}

export function filmTimeline(): FilmTimeline {
  let bar = 0;
  const logo = bar;
  bar += LOGO_BARS;
  const hero = bar;
  bar += HERO_BARS;
  const steps: number[] = [];
  for (let scene = 1; scene < SCENE_COUNT; scene++) {
    steps.push(bar);
    bar += sceneBars(scene);
  }
  const trust = bar;
  bar += TRUST_BARS;
  const end = bar;
  bar += END_BARS;
  const tail = bar;
  bar += TAIL_BARS;
  return {
    bpm: BPM,
    barMs: BAR_MS,
    totalBars: bar,
    durationMs: bar * BAR_MS,
    bars: { logo, hero, steps, trust, end, tail }
  };
}
