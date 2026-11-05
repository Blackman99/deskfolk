import { describe, expect, test } from 'bun:test';
import { isTap, panelPlacement, restAt } from './dock';

const vp = { width: 1440, height: 900 };

describe('restAt', () => {
  test('stays where it is let go, inside the window', () => {
    expect(restAt({ x: 300, y: 400, size: 56 }, vp)).toEqual({ x: 300, y: 400, side: null });
    expect(restAt({ x: 1350, y: 400, size: 56 }, vp)).toEqual({ x: 1350, y: 400, side: null });
  });

  test('let go near a side, it sticks there half tucked away', () => {
    expect(restAt({ x: 10, y: 400, size: 56 }, vp)).toEqual({ x: -28, y: 400, side: 'left' });
    expect(restAt({ x: -40, y: 400, size: 56 }, vp)).toEqual({ x: -28, y: 400, side: 'left' });
    expect(restAt({ x: 1440 - 56 - 20, y: 400, size: 56 }, vp)).toEqual({ x: 1412, y: 400, side: 'right' });
  });

  test('keeps clear of the nav and the bottom', () => {
    expect(restAt({ x: 300, y: 5, size: 56 }, vp).y).toBe(76);
    expect(restAt({ x: 300, y: 890, size: 56 }, vp).y).toBe(900 - 56 - 16);
  });

  test('a viewport too short to fit still returns the top bound', () => {
    expect(restAt({ x: 300, y: 50, size: 56 }, { width: 400, height: 100 }).y).toBe(76);
  });
});

describe('taps and the panel', () => {
  test('taps are small movements', () => {
    expect(isTap(2, 2)).toBe(true);
    expect(isTap(3, 3)).toBe(false);
  });

  test('the panel opens toward the page centre', () => {
    expect(panelPlacement({ x: 16, y: 100, size: 56 }, vp)).toEqual({ h: 'right', v: 'down' });
    expect(panelPlacement({ x: 1368, y: 800, size: 56 }, vp)).toEqual({ h: 'left', v: 'up' });
  });
});
