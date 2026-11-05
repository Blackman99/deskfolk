/**
 * A verlet rope for the cable in the "models" scene: points joined by fixed-length links, pulled
 * down by gravity, with either end optionally held where you say. Plain functions over plain
 * objects, so the numbers are tested here and the scene only draws the result.
 */

export type Vec = { x: number; y: number };

/** One point of the rope: where it is and where it was a step ago (its velocity). */
export type RopePoint = { x: number; y: number; px: number; py: number };

export type Rope = {
  pts: RopePoint[];
  /** The length each link keeps. */
  link: number;
};

/** The longest step the rope will take; a stalled tab's huge dt must not blow it up. */
export const MAX_DT = 1 / 30;

/** A rope of `segments` links and total `length`, laid in a straight line from `a` to `b`. */
export function createRope(a: Vec, b: Vec, segments: number, length: number): Rope {
  const n = Math.max(1, Math.floor(segments));
  const pts: RopePoint[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    pts.push({ x, y, px: x, py: y });
  }
  return { pts, link: length / n };
}

/** Change the rope's total length; the next steps pull it to the new size. */
export function setRopeLength(rope: Rope, length: number): void {
  rope.link = length / (rope.pts.length - 1);
}

/**
 * Move the rope on by `dt` seconds. `gravity` is in px/s² (positive pulls down). `pins` holds an
 * end where it is given: pass `a` and/or `b` to pin the first and/or last point there. `floorY`,
 * when given, is a ground the points cannot sink below.
 */
export function stepRope(
  rope: Rope,
  dt: number,
  gravity: number,
  iterations: number,
  pins: { a?: Vec; b?: Vec } = {},
  floorY?: number
): void {
  const h = Math.min(Math.max(dt, 0), MAX_DT);
  const { pts } = rope;
  const last = pts.length - 1;
  const damping = 0.992;
  for (let i = 0; i <= last; i++) {
    const q = pts[i];
    const vx = (q.x - q.px) * damping;
    const vy = (q.y - q.py) * damping;
    q.px = q.x;
    q.py = q.y;
    q.x += vx;
    q.y += vy + gravity * h * h;
  }
  const pin = () => {
    if (pins.a) setAt(pts[0], pins.a);
    if (pins.b) setAt(pts[last], pins.b);
  };
  pin();
  for (let it = 0; it < iterations; it++) {
    // Alternate the direction so the rope does not lean to one side.
    const forward = it % 2 === 0;
    for (let k = 0; k < last; k++) {
      const i = forward ? k : last - 1 - k;
      const p = pts[i];
      const q = pts[i + 1];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const diff = (d - rope.link) / d;
      const pPinned = (i === 0 && !!pins.a) || (i === last && !!pins.b);
      const qPinned = (i + 1 === last && !!pins.b) || (i + 1 === 0 && !!pins.a);
      const wp = pPinned ? 0 : qPinned ? 1 : 0.5;
      const wq = qPinned ? 0 : pPinned ? 1 : 0.5;
      p.x += dx * diff * wp;
      p.y += dy * diff * wp;
      q.x -= dx * diff * wq;
      q.y -= dy * diff * wq;
    }
    if (floorY !== undefined) for (const q of pts) if (q.y > floorY) q.y = floorY;
    pin();
  }
}

function setAt(q: RopePoint, v: Vec) {
  q.x = v.x;
  q.y = v.y;
  q.px = v.x;
  q.py = v.y;
}

/** The rope as an SVG path: a smooth curve through the midpoints of its links. */
export function ropePath(rope: Rope): string {
  const { pts } = rope;
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const e = pts[pts.length - 1];
  return `${d} L${e.x.toFixed(1)} ${e.y.toFixed(1)}`;
}

/**
 * The still cable for reduced motion: one quadratic curve that sags a little between two ends,
 * with the angle it arrives at `b` (radians) so a plug can face along it.
 */
export function staticCable(a: Vec, b: Vec): { d: string; angle: number } {
  const sag = 18 + Math.hypot(b.x - a.x, b.y - a.y) * 0.16;
  const cx = (a.x + b.x) / 2;
  const cy = Math.max(a.y, b.y) + sag;
  return {
    d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
    angle: Math.atan2(b.y - cy, b.x - cx)
  };
}
