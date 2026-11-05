import { describe, expect, test } from 'bun:test';
import { CAP, SAMPLE_ROWS, capCrossIndex, formatTokens, totals } from './ledger';

describe('ledger', () => {
  test('totals keep reported and estimated apart', () => {
    expect(totals(SAMPLE_ROWS)).toEqual({ reported: 2.64, estimated: 0.83 });
    expect(totals([])).toEqual({ reported: 0, estimated: 0 });
  });

  test('the cap is crossed on the last sample row, near row seven', () => {
    expect(capCrossIndex(SAMPLE_ROWS, CAP)).toBe(6);
    expect(capCrossIndex(SAMPLE_ROWS.slice(0, 6), CAP)).toBe(-1);
    expect(capCrossIndex(SAMPLE_ROWS, 0.84)).toBe(0);
  });

  test('every row points at a real message and mixes both kinds', () => {
    for (const r of SAMPLE_ROWS) expect(r.message).toBeLessThan(4);
    expect(new Set(SAMPLE_ROWS.map((r) => r.kind)).size).toBe(2);
  });

  test('formatTokens', () => {
    expect(formatTokens(980)).toBe('980');
    expect(formatTokens(12400)).toBe('12.4k');
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(99960)).toBe('100k');
    expect(formatTokens(120400)).toBe('120k');
    expect(formatTokens(2_300_000)).toBe('2.3M');
  });
});
