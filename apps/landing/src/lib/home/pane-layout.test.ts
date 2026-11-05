import { describe, expect, test } from 'bun:test';
import {
  actorsAt,
  BEATS,
  DIVIDER,
  edgeAt,
  floatOut,
  layoutRects,
  leaf,
  leaves,
  nextTab,
  paneAt,
  remove,
  resize,
  retab,
  split,
  splits,
  structureKey,
  treeAt,
  treeStep,
  zoneRect,
  type Split,
  type Tree
} from './pane-layout';

const ids = (t: Tree) => leaves(t).map((l) => l.id);

describe('split', () => {
  test('right puts the new pane after the old one in a row', () => {
    const t = split(leaf('a', 0), 'a', 'right', 1, 'b') as Split;
    expect(t.dir).toBe('row');
    expect(t.ratio).toBe(0.5);
    expect(ids(t)).toEqual(['a', 'b']);
    expect(leaves(t)[1].tab).toBe(1);
  });

  test('left, top and bottom put the new pane on the right side', () => {
    expect(ids(split(leaf('a', 0), 'a', 'left', 1, 'b'))).toEqual(['b', 'a']);
    const top = split(leaf('a', 0), 'a', 'top', 1, 'b') as Split;
    expect([top.dir, ids(top)]).toEqual(['col', ['b', 'a']]);
    const bottom = split(leaf('a', 0), 'a', 'bottom', 1, 'b') as Split;
    expect([bottom.dir, ids(bottom)]).toEqual(['col', ['a', 'b']]);
  });

  test('splits a nested pane and keeps the rest', () => {
    let t = split(leaf('a', 0), 'a', 'right', 1, 'b');
    t = split(t, 'b', 'bottom', 2, 'c');
    t = split(t, 'a', 'bottom', 3, 'd');
    expect(ids(t)).toEqual(['a', 'd', 'b', 'c']);
    expect(splits(t).length).toBe(3);
  });

  test('an unknown pane changes nothing', () => {
    const t = split(leaf('a', 0), 'a', 'right', 1, 'b');
    expect(split(t, 'zz', 'left', 2, 'c')).toBe(t);
  });

  test('does not change the tree it was given', () => {
    const t = leaf('a', 0);
    split(t, 'a', 'right', 1, 'b');
    expect(t).toEqual({ kind: 'leaf', id: 'a', tab: 0 });
  });

  test('every split has its own id', () => {
    let t = split(leaf('a', 0), 'a', 'right', 1, 'b');
    t = split(t, 'a', 'bottom', 2, 'c');
    const all = splits(t).map((s) => s.id);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('resize', () => {
  const t = split(leaf('a', 0), 'a', 'right', 1, 'b') as Split;

  test('sets the ratio of the named split', () => {
    expect((resize(t, t.id, 0.6) as Split).ratio).toBe(0.6);
  });

  test('keeps the ratio between 0.2 and 0.8', () => {
    expect((resize(t, t.id, 0.05) as Split).ratio).toBe(0.2);
    expect((resize(t, t.id, 0.99) as Split).ratio).toBe(0.8);
  });

  test('reaches a nested split and leaves the others', () => {
    const n = split(t, 'b', 'bottom', 2, 'c') as Split;
    const inner = splits(n).find((s) => s.id === 's-c')!;
    const r = resize(n, inner.id, 0.3) as Split;
    expect(r.ratio).toBe(0.5);
    expect((splits(r).find((s) => s.id === 's-c') as Split).ratio).toBe(0.3);
  });

  test('an unknown split changes nothing', () => {
    expect(resize(t, 'nope', 0.3)).toBe(t);
  });
});

describe('remove', () => {
  test('the sibling takes the space', () => {
    const t = split(leaf('a', 0), 'a', 'right', 1, 'b');
    expect(remove(t, 'a')).toEqual(leaf('b', 1));
    expect(remove(t, 'b')).toEqual(leaf('a', 0));
  });

  test('a nested pane leaves the rest in place', () => {
    let t = split(leaf('a', 0), 'a', 'right', 1, 'b');
    t = split(t, 'b', 'bottom', 2, 'c');
    const r = remove(t, 'c')!;
    expect(ids(r)).toEqual(['a', 'b']);
    expect(ids(remove(t, 'a')!)).toEqual(['b', 'c']);
  });

  test('the only pane leaves nothing; an unknown one changes nothing', () => {
    expect(remove(leaf('a', 0), 'a')).toBeNull();
    const t = split(leaf('a', 0), 'a', 'right', 1, 'b');
    expect(remove(t, 'zz')).toBe(t);
  });
});

describe('retab and nextTab', () => {
  test('retab swaps the tab in one pane', () => {
    const t = split(leaf('a', 0), 'a', 'right', 1, 'b');
    expect(leaves(retab(t, 'b', 4)).map((l) => l.tab)).toEqual([0, 4]);
    expect(retab(t, 'b', 1)).toBe(t);
  });

  test('nextTab is the lowest one not open', () => {
    expect(nextTab([0, 2], 5)).toBe(1);
    expect(nextTab([0, 1, 2, 3, 4], 5)).toBeNull();
  });
});

describe('layoutRects', () => {
  test('a single pane fills the box', () => {
    expect(layoutRects(leaf('a', 0), { x: 0, y: 0, w: 400, h: 300 }).get('a')).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  test('a row leaves the divider between the halves', () => {
    const t = split(leaf('a', 0), 'a', 'right', 1, 'b');
    const r = layoutRects(t, { x: 10, y: 20, w: 406, h: 300 });
    expect(r.get('a')).toEqual({ x: 10, y: 20, w: 200, h: 300 });
    expect(r.get('b')).toEqual({ x: 10 + 200 + DIVIDER, y: 20, w: 200, h: 300 });
  });

  test('a column follows its ratio', () => {
    const t = resize(split(leaf('a', 0), 'a', 'bottom', 1, 'b'), 's-b', 0.25);
    const r = layoutRects(t, { x: 0, y: 0, w: 100, h: 406 });
    expect(r.get('a')!.h).toBe(100);
    expect(r.get('b')!.y).toBe(100 + DIVIDER);
    expect(r.get('b')!.h).toBe(300);
  });

  test('every pane and divider add up to the box', () => {
    let t = split(leaf('a', 0), 'a', 'right', 1, 'b');
    t = split(t, 'b', 'bottom', 2, 'c');
    const r = layoutRects(t, { x: 0, y: 0, w: 506, h: 306 });
    expect(r.get('a')!.w + DIVIDER + r.get('b')!.w).toBe(506);
    expect(r.get('b')!.h + DIVIDER + r.get('c')!.h).toBe(306);
  });

  test('paneAt finds the pane under a point and none in the gap', () => {
    const t = split(leaf('a', 0), 'a', 'right', 1, 'b');
    const r = layoutRects(t, { x: 0, y: 0, w: 406, h: 100 });
    expect(paneAt(r, { x: 50, y: 50 })).toBe('a');
    expect(paneAt(r, { x: 300, y: 50 })).toBe('b');
    expect(paneAt(r, { x: 203, y: 50 })).toBeNull();
  });
});

describe('edgeAt', () => {
  const r = { x: 100, y: 50, w: 400, h: 200 };

  test('the nearest edge band wins', () => {
    expect(edgeAt(r, { x: 110, y: 150 })).toBe('left');
    expect(edgeAt(r, { x: 490, y: 150 })).toBe('right');
    expect(edgeAt(r, { x: 300, y: 55 })).toBe('top');
    expect(edgeAt(r, { x: 300, y: 245 })).toBe('bottom');
  });

  test('the middle replaces', () => {
    expect(edgeAt(r, { x: 300, y: 150 })).toBe('center');
  });

  test('a corner goes to whichever edge is nearer in proportion', () => {
    // 20 px in from the left is 5% of the width; 20 px down is 10% of the height.
    expect(edgeAt(r, { x: 120, y: 70 })).toBe('left');
    expect(edgeAt(r, { x: 140, y: 60 })).toBe('top');
  });

  test('outside is nothing', () => {
    expect(edgeAt(r, { x: 50, y: 150 })).toBeNull();
    expect(edgeAt(r, { x: 300, y: 300 })).toBeNull();
    expect(edgeAt({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0 })).toBeNull();
  });

  test('a narrower band makes a bigger centre', () => {
    expect(edgeAt(r, { x: 150, y: 150 }, 0.1)).toBe('center');
    expect(edgeAt(r, { x: 150, y: 150 }, 0.3)).toBe('left');
  });
});

describe('zoneRect', () => {
  const r = { x: 10, y: 20, w: 200, h: 100 };
  test('takes the half of that edge', () => {
    expect(zoneRect(r, 'left')).toEqual({ x: 10, y: 20, w: 100, h: 100 });
    expect(zoneRect(r, 'right')).toEqual({ x: 110, y: 20, w: 100, h: 100 });
    expect(zoneRect(r, 'top')).toEqual({ x: 10, y: 20, w: 200, h: 50 });
    expect(zoneRect(r, 'bottom')).toEqual({ x: 10, y: 70, w: 200, h: 50 });
    expect(zoneRect(r, 'center')).toEqual(r);
  });
});

describe('structureKey', () => {
  test('ignores ratios, notices panes, tabs and directions', () => {
    const t = split(leaf('a', 0), 'a', 'right', 1, 'b') as Split;
    expect(structureKey(resize(t, t.id, 0.7))).toBe(structureKey(t));
    expect(structureKey(retab(t, 'b', 2))).not.toBe(structureKey(t));
    expect(structureKey(split(leaf('a', 0), 'a', 'bottom', 1, 'b'))).not.toBe(structureKey(t));
  });
});

describe('the scripted layout', () => {
  test('starts with one pane showing the first tab', () => {
    expect(leaves(treeAt(treeStep(0)))).toEqual([leaf('a', 0)]);
  });

  test('splits at each drop and not before', () => {
    expect(treeStep(0.299)).toBe(0);
    expect(treeStep(0.3)).toBe(1);
    expect(treeStep(0.549)).toBe(1);
    expect(treeStep(0.55)).toBe(2);
    expect(treeStep(0.75)).toBe(3);
    expect(treeStep(1)).toBe(3);
  });

  test('ends with four panes in the right places', () => {
    const t = treeAt(3);
    expect(leaves(t).map((l) => [l.id, l.tab])).toEqual([
      ['a', 0],
      ['d', 3],
      ['b', 1],
      ['c', 2]
    ]);
    const s = t as Split;
    expect(s.dir).toBe('row');
    expect((s.a as Split).dir).toBe('col');
    expect((s.b as Split).dir).toBe('col');
  });

  test('is a pure function of p: the same step gives the same tree', () => {
    expect(treeAt(treeStep(0.6))).toBe(treeAt(treeStep(0.7)));
  });

  test('the floating tab is out only at the end', () => {
    expect(floatOut(0.89)).toBe(false);
    expect(floatOut(0.9)).toBe(true);
    expect(floatOut(1)).toBe(true);
  });

  test('each beat has one carrier, out then back, and nobody carries between beats', () => {
    for (const b of BEATS) {
      const mid = actorsAt((b.from + b.drop) / 2)[b.who]!;
      expect(mid.phase).toBe('out');
      expect(mid.tab).toBe(b.tab);
      expect(mid.t).toBeCloseTo(0.5);
      const after = actorsAt((b.drop + b.back) / 2)[b.who]!;
      expect(after.phase).toBe('back');
    }
    expect(actorsAt(0.1)).toEqual({});
    expect(actorsAt(0.39)).toEqual({});
    expect(actorsAt(1)).toEqual({});
  });

  test('a drop aims into the layout as it is before the split', () => {
    const second = actorsAt(0.5).mochi!;
    expect(ids(second.before)).toEqual(['a', 'b']);
    expect(second.at).toEqual({ leafId: 'b', edge: 'bottom' });
    expect(actorsAt(0.2).pudding!.before).toBe(treeAt(0));
    expect(actorsAt(0.85).mochi!.at).toBeNull();
  });

  test('beats do not overlap', () => {
    for (let i = 1; i < BEATS.length; i++) expect(BEATS[i].from).toBeGreaterThanOrEqual(BEATS[i - 1].back);
  });
});
