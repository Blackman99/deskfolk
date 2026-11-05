/**
 * The arithmetic behind the home page's motion: how far through its chapter the reader is, which
 * beat of a scene that is, the arc a companion hops along, and the poses Mochi and Pudding strike.
 * Plain functions, so the page's components stay about layout and the numbers are tested here.
 */

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 0 before `a`, 1 after `b`, eased in between: how far a beat that runs from a to b has got. */
export function span(p: number, a: number, b: number): number {
  if (b <= a) return p >= b ? 1 : 0;
  const t = clamp((p - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** How many of the ascending `marks` progress `p` has passed: the beat a scene is on. */
export function beatAt(p: number, marks: readonly number[]): number {
  let n = 0;
  for (const m of marks) if (p >= m) n++;
  return n;
}

/**
 * How far a chapter has been scrolled through, 0 to 1.
 * - `sticky`: the section is taller than the screen and its stage stays pinned under the nav; 0 when
 *   the section's top reaches the nav, 1 when its bottom reaches the screen's bottom.
 * - `flow`: a section in the page's normal flow (narrow screens); 0 as it comes up from the bottom,
 *   1 once its bottom has risen to 40% of the screen.
 */
export function sectionProgress(
  rect: { top: number; height: number },
  viewport: number,
  nav: number,
  mode: 'sticky' | 'flow'
): number {
  if (mode === 'sticky') {
    const travel = rect.height - (viewport - nav);
    if (travel <= 0) return rect.top <= nav ? 1 : 0;
    return clamp((nav - rect.top) / travel);
  }
  const start = viewport * 0.92;
  const end = viewport * 0.4 - rect.height;
  return clamp((start - rect.top) / (start - end));
}

/** The section a reader is on: the one that spans the line `at` px down the screen, else the nearest. */
export function activeSection(rects: { id: string; top: number; bottom: number }[], at: number): string | null {
  let best: string | null = null;
  let gap = Infinity;
  for (const r of rects) {
    if (r.top <= at && r.bottom > at) return r.id;
    const d = r.top > at ? r.top - at : at - r.bottom;
    if (d < gap) {
      gap = d;
      best = r.id;
    }
  }
  return best;
}

export type Point = { x: number; y: number };

/**
 * A hop from `from` to `to` at time `t` (0 to 1): eased along the ground, lifted on a parabola as
 * high as `height` (px, up is negative y). A short hop stays low.
 */
export function hopAt(from: Point, to: Point, t: number, height: number): Point {
  const k = clamp(t);
  const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  const lift = 4 * height * k * (1 - k);
  return { x: lerp(from.x, to.x, e), y: lerp(from.y, to.y, e) - lift };
}

/** How high a hop between two points goes: a third of the distance, at least 40 px and at most 180. */
export function hopHeight(from: Point, to: Point): number {
  return clamp(Math.hypot(to.x - from.x, to.y - from.y) / 3, 40, 180);
}

/**
 * One step of a damped spring toward `target`: returns the new value and velocity. Used for the
 * companions' lean when the page is scrolled fast and for the usage ball docking to an edge.
 */
export function spring(
  value: number,
  velocity: number,
  target: number,
  dt: number,
  stiffness = 180,
  damping = 20
): { value: number; velocity: number } {
  const step = Math.min(dt, 1 / 30);
  const a = stiffness * (target - value) - damping * velocity;
  const v = velocity + a * step;
  return { value: value + v * step, velocity: v };
}

/** Where a companion looks: the pointer's offset from its eyes, as -1…1 each way, softened with distance. */
export function lookToward(eyes: Point, pointer: Point | null, reach = 420): Point {
  if (!pointer) return { x: 0, y: 0 };
  const dx = pointer.x - eyes.x;
  const dy = pointer.y - eyes.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) return { x: 0, y: 0 };
  const k = Math.min(1, d / reach);
  return { x: (dx / d) * k, y: (dy / d) * k };
}

export type Eyes = 'dot' | 'happy' | 'wink' | 'closed';
export type Mouth = 'smile' | 'open' | 'cat';
/** A looping move of the whole figure (or of an arm, for `wave` and `type`). */
export type Move = 'breathe' | 'bob' | 'hop' | 'wave' | 'type' | 'walk' | 'sway' | 'none';

export type PoseName =
  | 'idle'
  | 'wave'
  | 'point'
  | 'cheer'
  | 'think'
  | 'work'
  | 'carry'
  | 'ask'
  | 'rest'
  | 'hop'
  | 'walk'
  | 'look';

/** How far each arm is raised from hanging (0) to straight up (180), the face, and the move. */
export type Pose = { armL: number; armR: number; eyes: Eyes; mouth: Mouth; move: Move; mark?: 'ask' | 'think' | 'rest' };

export const POSES: Record<PoseName, Pose> = {
  idle: { armL: 6, armR: 6, eyes: 'dot', mouth: 'smile', move: 'breathe' },
  wave: { armL: 6, armR: 140, eyes: 'happy', mouth: 'open', move: 'wave' },
  point: { armL: 6, armR: 92, eyes: 'dot', mouth: 'open', move: 'breathe' },
  cheer: { armL: 150, armR: 150, eyes: 'happy', mouth: 'open', move: 'hop' },
  think: { armL: 6, armR: 128, eyes: 'dot', mouth: 'cat', move: 'sway', mark: 'think' },
  work: { armL: 44, armR: 44, eyes: 'dot', mouth: 'smile', move: 'type' },
  carry: { armL: 72, armR: 72, eyes: 'dot', mouth: 'smile', move: 'walk' },
  ask: { armL: 6, armR: 158, eyes: 'dot', mouth: 'open', move: 'bob', mark: 'ask' },
  rest: { armL: 0, armR: 0, eyes: 'closed', mouth: 'smile', move: 'none', mark: 'rest' },
  hop: { armL: 58, armR: 58, eyes: 'happy', mouth: 'open', move: 'none' },
  walk: { armL: 18, armR: 18, eyes: 'dot', mouth: 'smile', move: 'walk' },
  look: { armL: 6, armR: 6, eyes: 'dot', mouth: 'open', move: 'none' }
};
