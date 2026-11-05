import { describe, expect, test } from 'bun:test';
import { activeSection, beatAt, hopAt, hopHeight, lookToward, sectionProgress, span, spring } from './motion';

describe('sectionProgress', () => {
  test('a pinned section runs 0 to 1 while its stage stays under the nav', () => {
    // 2000 px section, 900 px screen, 60 px nav: 1160 px of travel.
    expect(sectionProgress({ top: 300, height: 2000 }, 900, 60, 'sticky')).toBe(0);
    expect(sectionProgress({ top: 60, height: 2000 }, 900, 60, 'sticky')).toBe(0);
    expect(sectionProgress({ top: 60 - 580, height: 2000 }, 900, 60, 'sticky')).toBeCloseTo(0.5);
    expect(sectionProgress({ top: 60 - 1160, height: 2000 }, 900, 60, 'sticky')).toBe(1);
    expect(sectionProgress({ top: -5000, height: 2000 }, 900, 60, 'sticky')).toBe(1);
  });

  test('a section no taller than the screen is all or nothing', () => {
    expect(sectionProgress({ top: 100, height: 600 }, 900, 60, 'sticky')).toBe(0);
    expect(sectionProgress({ top: 40, height: 600 }, 900, 60, 'sticky')).toBe(1);
  });

  test('a section in the flow starts as it comes up and ends with its bottom at 40%', () => {
    expect(sectionProgress({ top: 900, height: 700 }, 900, 60, 'flow')).toBe(0);
    expect(sectionProgress({ top: 360 - 700, height: 700 }, 900, 60, 'flow')).toBe(1);
    const mid = sectionProgress({ top: 300, height: 700 }, 900, 60, 'flow');
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('beats', () => {
  test('span eases from 0 to 1 between its marks', () => {
    expect(span(0.1, 0.2, 0.4)).toBe(0);
    expect(span(0.3, 0.2, 0.4)).toBeCloseTo(0.5);
    expect(span(0.5, 0.2, 0.4)).toBe(1);
    expect(span(0.4, 0.4, 0.4)).toBe(1);
  });

  test('beatAt counts the marks passed', () => {
    expect(beatAt(0, [0.2, 0.5, 0.8])).toBe(0);
    expect(beatAt(0.5, [0.2, 0.5, 0.8])).toBe(2);
    expect(beatAt(1, [0.2, 0.5, 0.8])).toBe(3);
  });
});

describe('activeSection', () => {
  const rects = [
    { id: 'hero', top: -900, bottom: -100 },
    { id: 'models', top: -100, bottom: 1900 },
    { id: 'sessions', top: 1900, bottom: 3900 }
  ];

  test('picks the section across the line', () => {
    expect(activeSection(rects, 400)).toBe('models');
  });

  test('picks the nearest when the line falls between sections', () => {
    expect(activeSection([{ id: 'a', top: -500, bottom: 100 }, { id: 'b', top: 700, bottom: 900 }], 400)).toBe('a');
    expect(activeSection([], 400)).toBeNull();
  });
});

describe('hops', () => {
  test('a hop starts and lands on its points and peaks halfway', () => {
    const from = { x: 0, y: 100 };
    const to = { x: 200, y: 100 };
    expect(hopAt(from, to, 0, 80)).toEqual({ x: 0, y: 100 });
    expect(hopAt(from, to, 1, 80)).toEqual({ x: 200, y: 100 });
    const mid = hopAt(from, to, 0.5, 80);
    expect(mid.x).toBeCloseTo(100);
    expect(mid.y).toBeCloseTo(20);
  });

  test('hop height scales with distance within bounds', () => {
    expect(hopHeight({ x: 0, y: 0 }, { x: 30, y: 0 })).toBe(40);
    expect(hopHeight({ x: 0, y: 0 }, { x: 300, y: 0 })).toBe(100);
    expect(hopHeight({ x: 0, y: 0 }, { x: 3000, y: 0 })).toBe(180);
  });
});

describe('spring and look', () => {
  test('a spring settles on its target', () => {
    let s = { value: 0, velocity: 0 };
    for (let i = 0; i < 240; i++) s = spring(s.value, s.velocity, 10, 1 / 60);
    expect(s.value).toBeCloseTo(10, 1);
  });

  test('a long frame does not blow the spring up', () => {
    const s = spring(0, 0, 100, 2);
    expect(Number.isFinite(s.value)).toBe(true);
    expect(Math.abs(s.value)).toBeLessThan(200);
  });

  test('looks toward the pointer, softer when it is close', () => {
    expect(lookToward({ x: 0, y: 0 }, null)).toEqual({ x: 0, y: 0 });
    const far = lookToward({ x: 0, y: 0 }, { x: 1000, y: 0 });
    expect(far.x).toBeCloseTo(1);
    const near = lookToward({ x: 0, y: 0 }, { x: 0, y: 42 });
    expect(near.y).toBeCloseTo(0.1);
  });
});
