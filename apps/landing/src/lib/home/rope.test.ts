import { describe, expect, test } from 'bun:test';
import { createRope, ropePath, setRopeLength, staticCable, stepRope } from './rope';

const A = { x: 0, y: 100 };
const B = { x: 200, y: 100 };

function settle(rope: ReturnType<typeof createRope>, steps = 400, dt = 1 / 60, a = A, b = B) {
  for (let i = 0; i < steps; i++) stepRope(rope, dt, 1800, 40, { a, b });
}

describe('rope', () => {
  test('pinned ends stay where they are put', () => {
    const rope = createRope(A, B, 16, 240);
    settle(rope);
    const first = rope.pts[0];
    const last = rope.pts[rope.pts.length - 1];
    expect([first.x, first.y]).toEqual([A.x, A.y]);
    expect([last.x, last.y]).toEqual([B.x, B.y]);
  });

  test('a free end falls when only the other is pinned', () => {
    const rope = createRope(A, B, 16, 240);
    for (let i = 0; i < 200; i++) stepRope(rope, 1 / 60, 1800, 30, { a: A });
    expect(rope.pts[rope.pts.length - 1].y).toBeGreaterThan(A.y + 100);
  });

  test('links keep their length within 5% once settled', () => {
    const rope = createRope(A, B, 16, 240);
    settle(rope);
    for (let i = 0; i < rope.pts.length - 1; i++) {
      const d = Math.hypot(rope.pts[i + 1].x - rope.pts[i].x, rope.pts[i + 1].y - rope.pts[i].y);
      expect(Math.abs(d - rope.link) / rope.link).toBeLessThan(0.05);
    }
  });

  test('it sags under gravity, lowest in the middle', () => {
    const rope = createRope(A, B, 16, 240);
    settle(rope);
    const mid = rope.pts[8];
    expect(mid.y).toBeGreaterThan(A.y + 30);
    expect(mid.y).toBeGreaterThan(rope.pts[2].y);
    expect(mid.y).toBeGreaterThan(rope.pts[14].y);
  });

  test('a huge dt stays finite and bounded', () => {
    const rope = createRope(A, B, 16, 240);
    for (let i = 0; i < 50; i++) stepRope(rope, 5, 1800, 40, { a: A, b: B });
    for (const q of rope.pts) {
      expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true);
      expect(Math.abs(q.y)).toBeLessThan(1000);
    }
  });

  test('it follows a pinned end that moves, and a new length', () => {
    const rope = createRope(A, B, 16, 240);
    settle(rope, 100);
    const b2 = { x: 120, y: 60 };
    setRopeLength(rope, 160);
    settle(rope, 300, 1 / 60, A, b2);
    const e = rope.pts[rope.pts.length - 1];
    expect([e.x, e.y]).toEqual([b2.x, b2.y]);
    expect(rope.link).toBeCloseTo(10);
  });

  test('the floor holds the rope up', () => {
    const rope = createRope(A, B, 16, 400);
    for (let i = 0; i < 300; i++) stepRope(rope, 1 / 60, 1800, 30, { a: A, b: B }, 140);
    for (const q of rope.pts) expect(q.y).toBeLessThanOrEqual(140.001);
  });

  test('paths are well formed', () => {
    expect(ropePath(createRope(A, B, 4, 200))).toMatch(/^M[\d. -]+ Q/);
    expect(staticCable(A, B).d).toMatch(/^M0.0 100.0 Q100.0 /);
  });
});
