import { expect, test } from 'bun:test';
import { SCENE_BEATS, SCENE_COUNT } from '../demo/scenes';
import { BAR_MS, MIN_HOLD_MS, filmTimeline, sceneBars } from './timeline';

test('every step holds its last beat for at least MIN_HOLD_MS before the next bar line', () => {
  for (let scene = 1; scene < SCENE_COUNT; scene++) {
    const beats = SCENE_BEATS[scene];
    const last = beats[beats.length - 1];
    const length = sceneBars(scene) * BAR_MS;
    expect(length - last).toBeGreaterThanOrEqual(MIN_HOLD_MS);
    expect(length - last).toBeLessThan(MIN_HOLD_MS + BAR_MS);
  }
});

test('the parts follow one another bar by bar and fill the film', () => {
  const tl = filmTimeline();
  const { logo, hero, steps, trust, end, tail } = tl.bars;
  expect(logo).toBe(0);
  expect(steps).toHaveLength(SCENE_COUNT - 1);
  const starts = [logo, hero, ...steps, trust, end, tail, tl.totalBars];
  for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1]);
  for (let i = 0; i < steps.length; i++) {
    const next = i + 1 < steps.length ? steps[i + 1] : trust;
    expect(next - steps[i]).toBe(sceneBars(i + 1));
  }
  expect(tl.durationMs).toBe(tl.totalBars * BAR_MS);
});
