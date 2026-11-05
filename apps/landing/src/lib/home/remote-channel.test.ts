import { describe, expect, test } from 'bun:test';
import { INITIAL, autoState, parseMessage, reduce, rippleAt, type RemoteState } from './remote-channel';

const at = (phase: RemoteState['phase']): RemoteState => ({ ...INITIAL, phase });

describe('reduce', () => {
  test('ask only from working', () => {
    expect(reduce(at('working'), { type: 'ask' }).phase).toBe('waiting');
    for (const p of ['waiting', 'stopped', 'done'] as const) expect(reduce(at(p), { type: 'ask' })).toEqual(at(p));
  });
  test('allow and deny only from waiting', () => {
    expect(reduce(at('waiting'), { type: 'allow' }).phase).toBe('working');
    const denied = reduce(at('waiting'), { type: 'deny' });
    expect(denied.phase).toBe('working');
    expect(denied.denied).toBe(true);
    const s = at('working');
    expect(reduce(s, { type: 'allow' })).toBe(s);
    expect(reduce(s, { type: 'deny' })).toBe(s);
  });
  test('stop from working or waiting, not after', () => {
    expect(reduce(at('working'), { type: 'stop' }).phase).toBe('stopped');
    expect(reduce(at('waiting'), { type: 'stop' }).phase).toBe('stopped');
    expect(reduce(at('done'), { type: 'stop' }).phase).toBe('done');
  });
  test('resume only from stopped, and it carries on to done', () => {
    expect(reduce(at('stopped'), { type: 'resume' }).phase).toBe('done');
    expect(reduce(at('working'), { type: 'resume' }).phase).toBe('working');
  });
  test('finish and reset', () => {
    expect(reduce(at('working'), { type: 'finish' }).phase).toBe('done');
    const r = reduce({ phase: 'done', tab: 2, seq: 7, denied: true }, { type: 'reset' });
    expect(r).toEqual({ phase: 'working', tab: 0, seq: 8, denied: false });
  });
  test('tab switches, ignores a repeat and nonsense', () => {
    expect(reduce(INITIAL, { type: 'tab', tab: 3 }).tab).toBe(3);
    expect(reduce(INITIAL, { type: 'tab', tab: 0 })).toBe(INITIAL);
    expect(reduce(INITIAL, { type: 'tab', tab: 9 as never })).toBe(INITIAL);
    expect(reduce(INITIAL, { type: 'nope' } as never)).toBe(INITIAL);
  });
  test('seq grows with every change', () => {
    let s = INITIAL;
    for (const a of [{ type: 'ask' }, { type: 'allow' }, { type: 'stop' }, { type: 'resume' }] as const) {
      const n = reduce(s, a);
      expect(n.seq).toBe(s.seq + 1);
      s = n;
    }
    expect(s.phase).toBe('done');
  });
});

describe('autoState and rippleAt', () => {
  test('beats follow p', () => {
    const phases = [0, 0.2, 0.22, 0.3, 0.44, 0.45, 0.6, 0.65, 0.8, 0.85, 1].map((p) => autoState(p).phase);
    expect(phases).toEqual(['working', 'working', 'waiting', 'waiting', 'waiting', 'working', 'working', 'stopped', 'stopped', 'done', 'done']);
  });
  test('ripples run just before a beat', () => {
    expect(rippleAt(0.3)).toBeNull();
    expect(rippleAt(0.435)?.target).toBe('allow');
    expect(rippleAt(0.45)).toBeNull();
    expect(rippleAt(0.64)?.target).toBe('stop');
    expect(rippleAt(0.84)?.target).toBe('resume');
    expect(rippleAt(1)).toBeNull();
  });
});

describe('parseMessage', () => {
  test('accepts the three kinds', () => {
    expect(parseMessage({ v: 1, type: 'hello', from: 'a' })).toEqual({ v: 1, type: 'hello', from: 'a' });
    expect(parseMessage({ v: 1, type: 'action', action: { type: 'tab', tab: 2 }, from: 'a' })?.type).toBe('action');
    expect(parseMessage({ v: 1, type: 'state', state: INITIAL, from: 'a' })?.type).toBe('state');
  });
  test('rejects garbage', () => {
    const bad: unknown[] = [
      null, undefined, 1, 'x', [], {}, { v: 2, type: 'hello', from: 'a' }, { v: 1, type: 'hello' }, { v: 1, type: 'hello', from: '' },
      { v: 1, type: 'hello', from: 'x'.repeat(65) }, { v: 1, type: 'wat', from: 'a' },
      { v: 1, type: 'action', from: 'a' }, { v: 1, type: 'action', action: 'allow', from: 'a' },
      { v: 1, type: 'action', action: { type: 'explode' }, from: 'a' },
      { v: 1, type: 'action', action: { type: 'tab', tab: 4 }, from: 'a' },
      { v: 1, type: 'state', state: { ...INITIAL, phase: 'dancing' }, from: 'a' },
      { v: 1, type: 'state', state: { ...INITIAL, seq: -1 }, from: 'a' },
      { v: 1, type: 'state', state: { ...INITIAL, seq: 1.5 }, from: 'a' },
      { v: 1, type: 'state', state: { ...INITIAL, denied: 'no' }, from: 'a' },
      { v: 1, type: 'state', state: null, from: 'a' }
    ];
    for (const b of bad) expect(parseMessage(b)).toBeNull();
  });
});
