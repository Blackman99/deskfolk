import { describe, expect, test } from 'bun:test';
import { beats, cardAt, foldTranscript, forkPath, itemShown, typedPerLine, type Line } from './logic';

const lines: Line[] = [
  { who: 'you', text: 'abcd' },
  { who: 'claude', text: 'ef' },
  { who: 'tool', text: 'Read(x)' },
  { who: 'tool', text: 'Edit(x)' },
  { who: 'claude', text: 'gh' }
];

describe('sessions logic', () => {
  test('beats run in order and finish', () => {
    expect(beats(0).typed).toBe(0);
    expect(beats(0.3).typed).toBe(1);
    expect(beats(0.3).sheet).toBe(0);
    expect(beats(0.45).sheet).toBe(1);
    expect(beats(0.45).fly).toBe(0);
    expect(beats(0.65).fly).toBe(1);
    expect(beats(1).fork).toBe(1);
  });

  test('typing fills lines in order', () => {
    expect(typedPerLine(lines, 0)).toEqual([0, 0, 0, 0, 0]);
    expect(typedPerLine(lines, 1)).toEqual([4, 2, 7, 7, 2]);
    const half = typedPerLine(lines, 0.5);
    expect(half.reduce((a, b) => a + b, 0)).toBe(11);
    expect(half[0]).toBe(4);
  });

  test('tool runs fold into one item that remembers its first line', () => {
    const items = foldTranscript(lines);
    expect(items.map((i) => i.kind)).toEqual(['you', 'claude', 'fold', 'claude']);
    const fold = items[2];
    expect(fold.kind === 'fold' && fold.n).toBe(2);
    expect(fold.src).toBe(2);
  });

  test('chat items appear one after another', () => {
    expect(itemShown(0.5, 0)).toBe(0);
    expect(itemShown(0.9, 3)).toBe(1);
    expect(itemShown(0.7, 0)).toBe(1);
  });

  test('the card starts on the row and ends on the slot', () => {
    const a = { x: 100, y: 50, w: 200, h: 40 };
    const b = { x: 10, y: 120, w: 80, h: 24 };
    expect(cardAt(a, b, 0)).toEqual(a);
    expect(cardAt(a, b, 1).x).toBe(10);
    expect(cardAt(a, b, 1).y).toBeCloseTo(120);
  });

  test('the fork runs sideways for side by side windows and down for stacked ones', () => {
    const side = forkPath({ x: 0, y: 100 }, { x: 100, y: 140 });
    expect(side.stem.startsWith('M0 100 L40 100')).toBe(true);
    const down = forkPath({ x: 20, y: 0 }, { x: 22, y: 100 });
    expect(down.stem.startsWith('M20 0 L20 40')).toBe(true);
    expect(down.into.endsWith('22 100')).toBe(true);
  });
});
