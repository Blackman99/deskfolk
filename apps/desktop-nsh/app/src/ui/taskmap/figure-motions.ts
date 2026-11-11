/**
 * What each part of a map character does (`MapFigure.svelte`'s keyframes), as NSH motion specs in
 * the 58 x 64 box of a figure: its status (walking, talking, waiting on you, failed) and, at work,
 * each character's own way. Distances are box points (the CSS percentages of the box, worked out);
 * angles are degrees. Nothing here plays: `MapFigure` loops what it gets.
 */
import { Easing, type MotionSpec } from "nsh";
import type { FolkMotion } from "../../m/folk-motion";
import type { FigureId } from "../../m/taskmap/scene/figures";

export type Part = "fig" | "antenna" | "armL" | "armR" | "heldL" | "heldR" | "eyes" | "blink" | "mouth" | "talk";
export type Specs = Partial<Record<Part, MotionSpec>>;

type Ch = { rotate?: number; translateX?: number; translateY?: number; opacity?: number; scaleX?: number; scaleY?: number };
type Timing = Pick<MotionSpec, "duration" | "delay" | "easing" | "direction" | "iterations">;

/** Keyframes from `[percent, channels]` stops. */
function stops(list: readonly (readonly [number, Ch])[], timing: Timing): MotionSpec {
  return {
    ...timing,
    keyframes: list.map(([pct, c]) => ({
      offset: pct / 100,
      ...(c.rotate !== undefined ? { rotate: `${c.rotate}deg` } : {}),
      ...(c.translateX !== undefined ? { translateX: c.translateX } : {}),
      ...(c.translateY !== undefined ? { translateY: c.translateY } : {}),
      ...(c.opacity !== undefined ? { opacity: c.opacity } : {}),
      ...(c.scaleX !== undefined ? { scaleX: c.scaleX } : {}),
      ...(c.scaleY !== undefined ? { scaleY: c.scaleY } : {}),
    })),
  };
}

const EASE = Easing.inOut(Easing.ease);
const LINEAR = Easing.linear;
const STEP = Easing.steps(1);
const alt = (duration: number, a: Ch, b: Ch, extra: Partial<Timing> = {}): MotionSpec =>
  stops([[0, a], [100, b]], { duration, easing: EASE, direction: "alternate", ...extra });
const rot = (duration: number, from: number, to: number, extra: Partial<Timing> = {}) => alt(duration, { rotate: from }, { rotate: to }, extra);
const lift = (duration: number, to: number, extra: Partial<Timing> = {}) => alt(duration, { translateY: 0 }, { translateY: to }, extra);
/** A held pose with a cycle: percent stops of rotation only. */
const turn = (duration: number, list: readonly (readonly [number, number])[], extra: Partial<Timing> = {}) =>
  stops(list.map(([p, r]) => [p, { rotate: r }] as const), { duration, easing: EASE, ...extra });
/** Open and shut eyes: 1 outside the closed spans, 0 inside. */
const shut = (duration: number, spans: readonly (readonly [number, number])[], closed: boolean, extra: Partial<Timing> = {}) => {
  const on = closed ? 1 : 0;
  const list: (readonly [number, Ch])[] = [[0, { opacity: 1 - on }]];
  for (const [a, z] of spans) list.push([a - 0.01, { opacity: 1 - on }], [a, { opacity: on }], [z, { opacity: on }], [z + 0.01, { opacity: 1 - on }]);
  list.push([100, { opacity: 1 - on }]);
  return stops(list, { duration, easing: LINEAR, ...extra });
};

/** What a status does, with no work: the walk's bob and swing, the talk, the wave, the shake. */
function status(motion: FolkMotion, b: number): Specs {
  const blinkAt = (1300 * b) % 5200;
  const out: Specs = {
    eyes: shut(5200, [[94, 96]], false, { delay: blinkAt }),
    blink: shut(5200, [[94, 96]], true, { delay: blinkAt }),
  };
  if (motion === "running") {
    out.fig = lift(700, -2.5);
    out.armL = rot(450, 0, -22);
    out.armR = rot(450, 0, 22, { delay: 230 });
    out.antenna = rot(350, -8, 8);
  } else if (motion === "replying") {
    out.fig = lift(700, -2.5);
    out.armL = rot(260, 0, -22);
    out.armR = rot(260, 0, 22, { delay: 130 });
    out.mouth = stops([[0, { opacity: 1 }], [50, { opacity: 0 }], [100, { opacity: 1 }]], { duration: 340, easing: STEP });
    out.talk = stops([[0, { opacity: 0 }], [50, { opacity: 1 }], [100, { opacity: 0 }]], { duration: 340, easing: STEP });
  } else if (motion === "waiting") {
    out.fig = stops([[0, { translateY: 0 }], [30, { translateY: -6 }], [60, { translateY: 0 }], [100, { translateY: 0 }]], { duration: 1100, easing: EASE });
    out.armR = rot(500, -112, -146);
  } else if (motion === "failed") {
    out.fig = stops([[0, { rotate: 0 }], [25, { rotate: -6 }], [75, { rotate: 6 }], [100, { rotate: 0 }]], { duration: 500, easing: EASE, iterations: 2 });
  }
  return out;
}

/** At work, each character its own way. Anything a character does not list stays still. */
const WORK: Record<FigureId, Specs> = {
  pudding: {
    fig: lift(360, -2.5),
    armL: rot(170, 0, -22),
    armR: rot(170, 0, 22, { delay: 80 }),
  },
  mochi: {
    fig: turn(3200, [[0, -1.5], [50, 1.5], [100, -1.5]]),
    armR: turn(3200, [[0, 0], [46, 0], [60, 50], [80, 50], [92, 0], [100, 0]]),
    heldR: turn(3200, [[0, 0], [46, 0], [60, -76], [80, -76], [92, 0], [100, 0]]),
    armL: rot(800, 0, -12),
    eyes: shut(3200, [[62, 82]], false),
    blink: shut(3200, [[62, 82]], true),
  },
  taro: {
    fig: stops(
      [[0, { rotate: -3, translateY: 0 }], [25, { rotate: 0, translateY: -1.2 }], [50, { rotate: 3, translateY: 0 }], [75, { rotate: 0, translateY: -1.2 }], [100, { rotate: -3, translateY: 0 }]],
      { duration: 1000, easing: EASE },
    ),
    armR: rot(500, 0, -7),
    armL: rot(500, 0, -12, { delay: 250 }),
  },
  sakura: {
    fig: turn(2400, [[0, 0], [20, 2.5], [60, 2.5], [82, -2], [100, 0]]),
    armR: turn(2400, [[0, 0], [12, -26], [24, -16], [36, -26], [48, -16], [60, -26], [72, 0], [100, 0]]),
    heldR: turn(2400, [[0, 0], [12, -34], [24, 22], [36, -36], [48, 20], [60, -30], [72, 0], [100, 0]]),
    armL: turn(2400, [[0, 0], [10, -14], [64, -14], [78, 0], [100, 0]]),
  },
  matcha: {
    fig: lift(280, -1),
    armR: rot(280, -5, 5),
    heldR: rot(140, -24, 18),
  },
  caramel: {
    fig: stops([[0, { scaleX: 1, scaleY: 1 }], [54, { scaleX: 1, scaleY: 1 }], [58, { scaleX: 1.03, scaleY: 0.96 }], [66, { scaleX: 0.99, scaleY: 1.01 }], [74, { scaleX: 1, scaleY: 1 }], [100, { scaleX: 1, scaleY: 1 }]], { duration: 1200, easing: LINEAR }),
    armR: turn(1200, [[0, 0], [44, -28], [56, 4], [66, 0], [100, 0]]),
    heldR: turn(1200, [[0, 20], [44, -50], [56, 82], [62, 72], [68, 80], [100, 20]]),
    eyes: shut(1200, [[56, 70]], false),
    blink: shut(1200, [[56, 70]], true),
  },
  sesame: {
    fig: stops([[0, { rotate: -1, translateY: 0 }], [50, { rotate: -2.5, translateY: 0.4 }], [100, { rotate: -1, translateY: 0 }]], { duration: 3000, easing: EASE }),
    armL: turn(3000, [[0, -26], [50, -31], [100, -26]]),
    armR: turn(6000, [[0, 0], [72, 0], [78, 68], [81, 64], [84, 68], [90, 0], [100, 0]]),
  },
  blueberry: {
    fig: lift(2000, -2.9),
    armR: rot(1600, -30, -62),
    heldR: turn(1600, [[0, -30], [25, 10], [50, 32], [75, -4], [100, -30]], { easing: LINEAR }),
    armL: rot(1600, 0, -12),
  },
};

/** A pose an arm keeps while it does nothing at work (degrees), by figure. */
export const WORK_STILL: Partial<Record<FigureId, { armL?: number }>> = { matcha: { armL: -12 } };

/** A character's parts in motion: its status and, at work, its own work over it. */
export function figureSpecs(motion: FolkMotion, work: boolean, figure: FigureId, b: number): Specs {
  const base = status(motion, b);
  if (!work) return base;
  const mine = WORK[figure];
  const out: Specs = { ...base, armL: undefined, armR: undefined, antenna: rot(800, -8, 8) };
  for (const part of Object.keys(mine) as Part[]) out[part] = mine[part];
  if (figure === "taro") {
    // Eyes shut in a smile: the plain eyes and their blink are both hidden (the happy layer shows).
    delete out.eyes;
    delete out.blink;
  }
  return out;
}

/** One kind of mark the work shows (steam, notes, sparks…): what it looks like and how it plays. */
export type FxKind = "glow" | "signal" | "note" | "tick" | "steam" | "fleck" | "trail" | "drop" | "swish" | "burst" | "spark" | "page" | "shine" | "star";

export type FxLook = {
  /** Its box in box points, centred on the spot unless `at` shifts it. */
  w: number;
  h: number;
  dx: number;
  dy: number;
  shape: "disc" | "ring" | "star" | "rect" | "svg";
  color: string | readonly string[];
  /** The motion of the n-th mark. */
  motion: (n: number) => MotionSpec;
};

const loopT = (duration: number, extra: Partial<Timing> = {}): Timing => ({ duration, easing: Easing.out(Easing.ease), ...extra });
const fade = (list: readonly (readonly [number, Ch])[], timing: Timing) => stops(list, timing);

export const FX: Record<FxKind, FxLook> = {
  glow: { w: 9, h: 9, dx: -4.5, dy: -4.5, shape: "disc", color: "glow", motion: () => fade([[0, { opacity: 0.3, scaleX: 0.7, scaleY: 0.7 }], [100, { opacity: 1, scaleX: 1.1, scaleY: 1.1 }]], { duration: 800, easing: EASE, direction: "alternate" }) },
  signal: { w: 8, h: 8, dx: -4, dy: -4, shape: "ring", color: "#1b8a9c", motion: (n) => fade([[0, { opacity: 0, scaleX: 0.5, scaleY: 0.5 }], [20, { opacity: 0.95 }], [100, { opacity: 0, scaleX: 2.1, scaleY: 2.1 }]], loopT(1200, { delay: n * 600 })) },
  note: { w: 5, h: 6, dx: -2.5, dy: -3, shape: "svg", color: ["#5d4a96", "#1b7486"], motion: (n) => fade([[0, { opacity: 0, translateX: 0, translateY: 0, rotate: n ? 8 : -10, scaleX: 0.6, scaleY: 0.6 }], [15, { opacity: 1 }], [100, { opacity: 0, translateX: n ? 2 : 7.5, translateY: n ? -13.8 : -11.4, rotate: n ? -10 : 12, scaleX: 1, scaleY: 1 }]], loopT(2000, { delay: n * 1000 })) },
  tick: { w: 5.6, h: 4.7, dx: -2.8, dy: -7, shape: "svg", color: "#1b8a9c", motion: () => fade([[0, { opacity: 0, scaleX: 0.3, scaleY: 0.3 }], [40, { opacity: 0, scaleX: 0.3, scaleY: 0.3 }], [50, { opacity: 1, scaleX: 1.2, scaleY: 1.2 }], [60, { scaleX: 1, scaleY: 1 }], [85, { opacity: 1, translateY: -1.4 }], [100, { opacity: 0, translateY: -2.8 }]], loopT(2000)) },
  steam: { w: 4.6, h: 4.6, dx: -2.3, dy: -4, shape: "disc", color: "#ffffff", motion: (n) => fade([[0, { opacity: 0, translateX: 0, translateY: 0, scaleX: 0.5, scaleY: 0.5 }], [20, { opacity: 0.9 }], [50, { translateX: 1.6, translateY: -6.9, scaleX: 1, scaleY: 1 }], [100, { opacity: 0, translateX: -0.9, translateY: -15.6, scaleX: 1.6, scaleY: 1.6 }]], loopT(1800, { delay: n * 600 })) },
  fleck: { w: 2.4, h: 2.4, dx: -1.2, dy: -1.2, shape: "disc", color: ["#1b8a9c", "#f0ab3d", "#e0705c"], motion: (n) => fade([[0, { opacity: 0, translateX: 0, translateY: 0 }], [3, { opacity: 1 }], [22, { opacity: 0, translateX: n === 1 ? 6.2 : 5.5, translateY: n === 1 ? 1.4 : -4.1, scaleX: 0.6, scaleY: 0.6 }], [100, { opacity: 0 }]], loopT(2400, { delay: 290 + n * 575 })) },
  trail: { w: 12, h: 12, dx: -6, dy: -3, shape: "ring", color: ["#1b8a9c", "#f0ab3d", "#e0705c"], motion: (n) => fade([[0, { opacity: 0 }], [4, { opacity: 0.95 }], [10, { opacity: 0.95 }], [30, { opacity: 0 }], [100, { opacity: 0 }]], loopT(2400, { delay: 200 + n * 580 })) },
  drop: { w: 2, h: 2, dx: -1, dy: -1, shape: "disc", color: ["#f4ede0", "#8fb456"], motion: (n) => fade([[0, { opacity: 0, translateX: 0, translateY: 0 }], [15, { opacity: 1 }], [100, { opacity: 0, translateX: n % 2 ? -3.4 : 4.8, translateY: n % 2 ? -5.2 : -4 }]], loopT(700, { delay: n * 180 })) },
  swish: { w: 9, h: 9, dx: -4.5, dy: -4.5, shape: "ring", color: "#ffffffe6", motion: (n) => stops(n ? [[0, { opacity: 1 }], [50, { opacity: 0 }], [100, { opacity: 1 }]] : [[0, { opacity: 0 }], [50, { opacity: 1 }], [100, { opacity: 0 }]], { duration: 140, easing: STEP }) },
  burst: { w: 12, h: 12, dx: -6, dy: -6, shape: "star", color: "#ffc93a", motion: () => fade([[0, { opacity: 0, scaleX: 0.3, scaleY: 0.3, rotate: 0 }], [55, { opacity: 0, scaleX: 0.3, scaleY: 0.3, rotate: 0 }], [58, { opacity: 1, scaleX: 1.15, scaleY: 1.15, rotate: 10 }], [72, { opacity: 0, scaleX: 1.4, scaleY: 1.4, rotate: 18 }], [100, { opacity: 0 }]], { duration: 1200, easing: LINEAR }) },
  spark: { w: 1.3, h: 1.3, dx: -0.65, dy: -0.65, shape: "disc", color: "#ffd257", motion: (n) => fade([[0, { opacity: 0, translateX: 0, translateY: 0 }], [56, { opacity: 0, translateX: 0, translateY: 0 }], [58, { opacity: 1 }], [76, { opacity: 0, translateX: [6.5, -3.9, 7.3][n] ?? 6, translateY: [-5.5, -6.8, 1][n] ?? -5 }], [100, { opacity: 0 }]], { duration: 1200, easing: LINEAR }) },
  page: { w: 4.4, h: 5.6, dx: 0, dy: -2.8, shape: "rect", color: "#fbf8ef", motion: () => fade([[0, { opacity: 0, scaleX: 1 }], [40, { opacity: 0, scaleX: 1 }], [44, { opacity: 1, scaleX: 1 }], [62, { opacity: 1, scaleX: -1 }], [66, { opacity: 0, scaleX: -1 }], [100, { opacity: 0, scaleX: -1 }]], { duration: 3000, easing: EASE }) },
  shine: { w: 1.5, h: 6, dx: -2.6, dy: -3, shape: "rect", color: "#ffffff", motion: () => fade([[0, { opacity: 0, translateX: 0, rotate: 30 }], [88, { opacity: 0, translateX: 0, rotate: 30 }], [90, { opacity: 1 }], [97, { opacity: 0, translateX: 3.9, rotate: 30 }], [100, { opacity: 0 }]], { duration: 6000, easing: LINEAR }) },
  star: { w: 4.4, h: 4.4, dx: -2.2, dy: -2.2, shape: "star", color: ["#ffd257", "#fff3b0"], motion: (n) => fade([[0, { opacity: 0, translateX: 0, translateY: 0, scaleX: 0.4, scaleY: 0.4, rotate: 0 }], [15, { opacity: 1, scaleX: 1, scaleY: 1 }], [100, { opacity: 0, translateX: n % 2 ? -6.6 : 7, translateY: n % 2 ? 8.4 : 9.7, scaleX: 0.3, scaleY: 0.3, rotate: n % 2 ? -90 : 90 }]], loopT(1600, { delay: n * 400 })) },
};

/** What shows of a character's work: `n` marks of a kind, at one of its spots, in the part it moves with. */
export type Fx = { kind: FxKind; at: string; n: number };
export type WorkFx = { fig?: Fx[]; antenna?: Fx[]; armR?: Fx[]; heldL?: Fx[]; heldR?: Fx[] };

export const WORK_FX: Record<FigureId, WorkFx> = {
  pudding: { antenna: [{ kind: "glow", at: "signal", n: 1 }, { kind: "signal", at: "signal", n: 2 }] },
  mochi: { heldR: [{ kind: "steam", at: "steam", n: 3 }] },
  taro: { fig: [{ kind: "note", at: "notes", n: 2 }], heldR: [{ kind: "tick", at: "tick", n: 1 }] },
  sakura: { armR: [{ kind: "trail", at: "brush", n: 3 }], heldR: [{ kind: "fleck", at: "brush", n: 3 }] },
  matcha: { armR: [{ kind: "swish", at: "whisk", n: 2 }], heldR: [{ kind: "drop", at: "whisk", n: 4 }] },
  caramel: { heldR: [{ kind: "burst", at: "hammer", n: 1 }, { kind: "spark", at: "hammer", n: 3 }] },
  sesame: { fig: [{ kind: "shine", at: "glasses", n: 1 }], heldL: [{ kind: "page", at: "book", n: 1 }] },
  blueberry: { heldR: [{ kind: "star", at: "wand", n: 4 }] },
};
