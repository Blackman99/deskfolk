/**
 * The town itself (`MapScene.svelte`, ADR 0096): ground, buildings, plates and characters, drawn in
 * a world of VIEW_W x VIEW_H picture points that the camera moves and scales. The ground, trees,
 * lamps and buildings are painted on one Canvas in the world's transform; plates, badges and labels
 * keep their size on screen at any zoom, so they are views placed by the camera; the characters are
 * views at the town's scale. The pointer is read here and handed up as pans, turns and picks; the
 * camera's arithmetic lives with the map.
 */
import { Canvas, Easing, Image, PanResponder, Path2D, Text, View, colorScheme, createMotion, effect, reduceMotion, signal, token, type JSX, type Motion, type ViewRef } from "nsh";
import type { Copy } from "../../m/copy";
import type { ModelSource } from "../../m/model-source";
import type { Frame, FrameActor, FrameBlock } from "../../m/taskmap/frame";
import type { DrawnFigure } from "../../m/taskmap/scene/figures";
import { mix } from "../../m/taskmap/scene/geometry";
import { onWheel } from "../../platform/wheel";
import { tip } from "../tip";
import { cssColor } from "../styles";
import { glide } from "./glide";
import { MapFigure } from "./MapFigure";
import { MapLogo } from "./MapLogo";
import { wheelMove } from "./scene-wheel";

type T = Copy["taskmap"];
type Cam = { tx: number; ty: number; k: number };
type Figure = DrawnFigure & { avatar: string | null };

// A fixed field of stars over the top of the view, the same every night: [x %, y %, radius].
const STARS: readonly (readonly [number, number, number])[] = Array.from({ length: 48 }, (_, i) => {
  const r = (n: number) => (((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1) + 1) % 1;
  return [r(1), r(2) * 0.52, r(3) > 0.82 ? 1.4 : 0.8] as const;
});

const STATUS_DOT: Record<string, string> = { work: "#16a34a", walk: "#95a2a8", idle: "#c3cfd3", fail: "#dc2626", back: "#16a34a", none: "#c3cfd3" };

/** A colour with any alpha dropped, for `mix`. */
const solid = (c: string) => (/^#[0-9a-f]{8}$/i.test(c) ? c.slice(0, 7) : c);
/** Each character's colour is picked against a light plate; on a dark one it is lifted toward the text colour. */
const whoInk = (color: string) => {
  const c = cssColor(color);
  if (colorScheme() !== "dark" || !/^#[0-9a-f]{6}/i.test(c)) return c;
  try {
    return mix(solid(c), solid(String(token("ink"))), 0.4);
  } catch {
    return c;
  }
};

const points = (s: string): [number, number][] =>
  s.trim() ? s.trim().split(/\s+/).map((p) => p.split(",").map(Number) as [number, number]) : [];
const polygon = (s: string): Path2D => {
  const pts = points(s);
  return new Path2D(pts.length ? `M${pts.map(([x, y]) => `${x},${y}`).join("L")}Z` : "");
};
function inside(pts: readonly [number, number][], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Plays `spec` on `m` over and over, and rests it with reduced motion. */
function repeat(m: Motion, spec: Parameters<Motion["play"]>[0]): void {
  effect(() => {
    if (reduceMotion()) m.reset();
    else void m.play({ ...(spec as object), iterations: "infinite" } as never);
  });
}

/**
 * A view whose point `(fx, fy)` (0..1 of its own size) stands at `(x, y)`: placed once the view has
 * been measured, so a plate or a badge sits on its anchor whatever its text.
 */
function Anchored(props: { x: number; y: number; fx: number; fy: number; dx?: number; dy?: number; z: number; testID?: string; class?: string; style?: Record<string, unknown>; children?: JSX.Element }) {
  const w = signal(0);
  const h = signal(0);
  return (
    <View
      testID={props.testID}
      class={props.class}
      onLayout={(e) => {
        w.set(e.bounds.size.width);
        h.set(e.bounds.size.height);
      }}
      style={{
        position: "absolute",
        left: props.x - w() * props.fx + (props.dx ?? 0),
        top: props.y - h() * props.fy + (props.dy ?? 0),
        zIndex: props.z,
        opacity: w() > 0 ? 1 : 0,
        ...props.style,
      }}
    >
      {props.children}
    </View>
  );
}

/** What rises off a working building (`.tm-fx`): three marks, in the kind of its archetype. */
function BlockFx(props: { archetype: string; color: string }) {
  const kind = () => props.archetype;
  const rect = () => ["bible", "board", "scratch", "mail"].includes(kind());
  const blink = () => ["clips", "review", "film"].includes(kind());
  const square = () => ["keys", "paint"].includes(kind());
  return (
    <>
      {[0, 1, 2].map((n) => {
        const m = createMotion({ initial: { opacity: 0 } });
        const left = [-3, 2, -8][n]!;
        const delay = n * 600;
        effect(() => {
          const k = kind();
          if (reduceMotion()) return m.reset();
          if (blink()) void m.play({ duration: 1100, delay, iterations: "infinite", keyframes: [{ offset: 0, opacity: 0, scaleX: 0.6, scaleY: 0.6 }, { offset: 0.4, opacity: 1, scaleX: 1.6, scaleY: 1.6 }, { offset: 1, opacity: 0, scaleX: 0.6, scaleY: 0.6 }] });
          else if (rect()) void m.play({ duration: 2200, delay, iterations: "infinite", keyframes: [{ offset: 0, opacity: 0, translateX: 0, translateY: 0, rotate: "0deg" }, { offset: 0.2, opacity: 1 }, { offset: 1, opacity: 0, translateX: 12, translateY: -24, rotate: "160deg" }] });
          else if (square()) void m.play({ duration: 1800, delay, iterations: "infinite", keyframes: [{ offset: 0, opacity: 0, translateX: 0, translateY: 0, rotate: "45deg", scaleX: 0.4, scaleY: 0.4 }, { offset: 0.3, opacity: 1 }, { offset: 1, opacity: 0, translateX: -9, translateY: -28, rotate: "225deg", scaleX: 1, scaleY: 1 }] });
          else void m.play({ duration: k === "tools" ? 2400 : 1800, delay, iterations: "infinite", keyframes: [{ offset: 0, opacity: 0, translateX: 0, translateY: 0, scaleX: 0.6, scaleY: 0.6 }, { offset: 0.15, opacity: 0.9 }, { offset: 1, opacity: 0, translateX: 7, translateY: -30, scaleX: 1.5, scaleY: 1.5 }] });
        });
        const size = () => (kind() === "tools" ? 9 : rect() ? [7, 5] : blink() ? 6 : 6);
        const w = () => (Array.isArray(size()) ? (size() as number[])[0]! : (size() as number));
        const h = () => (Array.isArray(size()) ? (size() as number[])[1]! : (size() as number));
        return (
          <View
            style={{
              position: "absolute",
              left: kind() === "tools" ? -4 : left,
              top: -3,
              width: w(),
              height: h(),
              borderRadius: rect() || square() ? 1 : w(),
              backgroundColor: kind() === "tools" ? "#aab3ba" : rect() ? "#fbf8ef" : blink() ? "#ffe680" : props.color,
              opacity: m.opacity,
              transform: [...m.transform],
            }}
          />
        );
      })}
    </>
  );
}

export function MapScene(props: {
  frame: Frame;
  /** Whose model each character works on, by index: the logo on its badge, its name beside the model in the badge's tooltip. */
  logos: readonly ModelSource[];
  /** Each character's figure and the avatar on its pin, by index. */
  figures: readonly Figure[];
  /** The hour's light on the figures, a colour laid over them, or null by day. */
  tint: { color: string; alpha: number } | null;
  colors: readonly string[];
  cam: Cam;
  /** How long the camera glides to where it is asked (0 while dragging or turning). */
  camMs: number;
  walkMs: number;
  sel: number;
  hover: number;
  follow: number;
  labels: { ext: string; ws: string; town: string };
  t: T;
  onPan: (dx: number, dy: number) => void;
  onTurn: (degrees: number) => void;
  onZoom: (factor: number, x: number, y: number) => void;
  onPick: (place: number) => void;
  onHover: (place: number) => void;
  onFollow: (character: number) => void;
  onDeselect: () => void;
  onDragging: (turning: boolean | null) => void;
}) {
  const frame = () => props.frame;
  const cam = () => props.cam;
  const sx = (x: number) => x * cam().k + cam().tx;
  const sy = (y: number) => y * cam().k + cam().ty;
  const world = (x: number, y: number): [number, number] => [(x - cam().tx) / cam().k, (y - cam().ty) / cam().k];

  // --- The pointer: a drag pans (turns with Shift or Option, or the right button), a tap picks ---
  let turning = false;
  let moved = false;
  let dragEnd = 0;
  let right: { x: number; y: number } | null = null;
  const fresh = () => Date.now() - dragEnd > 120;
  const panning = signal(false);

  /** The building under a point of the view (the nearest in front), or -1. */
  const blockAt = (x: number, y: number): number => {
    const [wx, wy] = world(x, y);
    let best = -1;
    let bestZ = -Infinity;
    frame().blocks.forEach((b, q) => {
      const pts = points(b.hit).map(([px, py]) => [px + b.l, py + b.t] as [number, number]);
      if (b.z >= bestZ && inside(pts, wx, wy)) {
        best = q;
        bestZ = b.z;
      }
    });
    return best;
  };

  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.hypot(g.dx, g.dy) >= 4,
    onPanResponderGrant: () => {
      moved = true;
      panning.set(!turning);
      props.onDragging(turning);
    },
    onPanResponderMove: (_e, g) => {
      const dx = g.dx - last.x;
      const dy = g.dy - last.y;
      last = { x: g.dx, y: g.dy };
      if (turning) props.onTurn(dx * 0.4);
      else props.onPan(dx, dy);
    },
    onPanResponderRelease: () => finish(),
    onPanResponderTerminate: () => finish(),
  });
  let last = { x: 0, y: 0 };
  function finish(): void {
    panning.set(false);
    if (moved) {
      dragEnd = Date.now();
      props.onDragging(null);
    }
    moved = false;
    last = { x: 0, y: 0 };
  }

  // --- The wheel zooms and a sideways swipe turns ---
  let sceneRef: ViewRef | null = null;
  onWheel(
    () => sceneRef,
    (e, at) => {
      const move = wheelMove(e);
      if ("turn" in move) props.onTurn(move.turn);
      else props.onZoom(move.zoom, at.x, at.y);
    },
  );

  // --- The camera and the walk glide to where they are asked ---
  const shownCam = glide(() => [cam().tx, cam().ty, cam().k], () => props.camMs);
  const view = () => {
    const [tx, ty, k] = shownCam();
    return { tx: tx!, ty: ty!, k: k! };
  };
  const vx = (x: number) => x * view().k + view().tx;
  const vy = (y: number) => y * view().k + view().ty;

  // --- The sky stays put as the town pans and zooms ---
  const sky = (
    <Canvas
      class="absolute left-0 top-0 right-0 bottom-0"
      style={{ pointerEvents: "none" }}
      draw={(cx, size) => {
        const s = frame().sky;
        if (s.stars > 0) {
          cx.fillStyle = "#f4f1e6";
          cx.globalAlpha = s.stars;
          for (const [x, y, r] of STARS) {
            cx.beginPath();
            cx.arc(x * size.width, y * size.height, r, 0, Math.PI * 2);
            cx.fill();
          }
          cx.globalAlpha = 1;
        }
        const body = s.body;
        if (!body || body.alpha <= 0) return;
        cx.globalAlpha = body.alpha;
        const x = body.x * size.width;
        const y = body.y * size.height;
        if (body.kind === "sun") {
          const warm = body.warm;
          const glow = cx.createRadialGradient(x, y, 12, x, y, 63);
          glow.addColorStop(0, warm > 0.5 ? "rgba(255,150,80,.5)" : "rgba(255,236,170,.45)");
          glow.addColorStop(1, "rgba(255,200,120,0)");
          cx.fillStyle = glow;
          cx.beginPath();
          cx.arc(x, y, 63, 0, Math.PI * 2);
          cx.fill();
          const core = cx.createRadialGradient(x, y, 0, x, y, 17);
          core.addColorStop(0, mix("#fff7d6", "#ffb55c", warm));
          core.addColorStop(0.75, mix("#fff7d6", "#ffb55c", warm));
          core.addColorStop(1, mix("#ffe7a0", "#ff9a4a", warm));
          cx.fillStyle = core;
          cx.beginPath();
          cx.arc(x, y, 17, 0, Math.PI * 2);
          cx.fill();
        } else {
          cx.save();
          cx.translate(x - 15, y - 15);
          cx.scale(15 / 14, 15 / 14);
          cx.clip(new Path2D("M-50-50H80V80H-50ZM29.5 9.5a10 10 0 1 0 -20 0a10 10 0 1 0 20 0Z"), "evenodd");
          cx.fillStyle = "#f4efdc";
          cx.beginPath();
          cx.arc(14, 14, 12, 0, Math.PI * 2);
          cx.fill();
          cx.restore();
        }
        cx.globalAlpha = 1;
      }}
    />
  );

  // --- The world canvas: ground, trees, lamps, buildings ---
  const ground = (
    <Canvas
      class="absolute left-0 top-0 right-0 bottom-0"
      style={{ pointerEvents: "none" }}
      draw={(cx) => {
        const f = frame();
        const c = view();
        cx.save();
        cx.setTransform(c.k, 0, 0, c.k, c.tx, c.ty);
        cx.lineJoin = "round";
        cx.fillStyle = "rgba(23,38,42,.13)";
        cx.fill(new Path2D(f.ground.shadow));
        for (const slab of f.slabs) {
          for (const p of slab.puffs) {
            cx.fillStyle = p.fill;
            cx.beginPath();
            cx.ellipse(Number(p.x), Number(p.y), p.rx, Number(p.ry), 0, 0, Math.PI * 2);
            cx.fill();
          }
          for (const face of slab.faces) {
            const path = new Path2D(face.d);
            cx.fillStyle = face.fill;
            cx.fill(path);
            cx.strokeStyle = face.stroke;
            cx.lineWidth = 1;
            cx.stroke(path);
          }
        }
        cx.lineCap = "round";
        const roads = new Path2D(f.ground.roads);
        cx.strokeStyle = f.roadEdge;
        cx.lineWidth = 15;
        cx.stroke(roads);
        cx.strokeStyle = f.roadFill;
        cx.lineWidth = 12;
        cx.stroke(roads);
        // Shadows over the ground and roads, each island's only on its own top. Lamps pool their light at night.
        if (f.shadows.alpha > 0) {
          const cast = (top: string, shade: string) => {
            if (!shade) return;
            cx.save();
            cx.clip(new Path2D(top));
            cx.globalAlpha = f.shadows.alpha;
            cx.fillStyle = "#1d2636";
            cx.fill(new Path2D(shade));
            cx.restore();
          };
          cast(f.ground.tops.town, f.shadows.town + f.shadows.island);
          cast(f.ground.tops.ws, f.shadows.ws);
          cast(f.ground.tops.ext, f.shadows.ext);
        }
        if (f.night > 0) {
          cx.globalAlpha = f.night;
          for (const lamp of f.lamps) {
            cx.save();
            cx.translate(lamp.l + 6, lamp.t + 33);
            cx.scale(1, 0.5);
            const pool = cx.createRadialGradient(0, 0, 0, 0, 0, 30);
            pool.addColorStop(0, "rgba(255,217,138,.6)");
            pool.addColorStop(1, "rgba(255,217,138,0)");
            cx.fillStyle = pool;
            cx.beginPath();
            cx.arc(0, 0, 30, 0, Math.PI * 2);
            cx.fill();
            cx.restore();
          }
          cx.globalAlpha = 1;
        }
        // What stands, back to front.
        type Item = { z: number; paint: () => void };
        const items: Item[] = [];
        for (const tree of f.trees) {
          items.push({
            z: tree.z,
            paint: () => {
              cx.save();
              cx.translate(tree.l, tree.t);
              const part = (d: string, fill: string) => {
                cx.fillStyle = fill;
                cx.fill(new Path2D(d));
              };
              if (tree.pine) {
                part("M13.5 34h3v8h-3z", "#9a7b5f");
                part("M15 4L4 34l11 5z", "#86bf7d");
                part("M15 4l11 30-11 5z", "#5f9a5e");
              } else {
                part("M13.5 28h3v14h-3z", "#9a7b5f");
                cx.fillStyle = "#74b366";
                cx.beginPath();
                cx.arc(15, 20, 12, 0, Math.PI * 2);
                cx.fill();
                part("M15 8a12 12 0 0 0 0 24z", "#93cc7f");
              }
              cx.restore();
            },
          });
        }
        for (const lamp of f.lamps) {
          items.push({
            z: lamp.z,
            paint: () => {
              cx.save();
              cx.translate(lamp.l, lamp.t);
              cx.fillStyle = "#6b7178";
              cx.fillRect(5, 8, 2, 26);
              if (f.night > 0) {
                const glow = cx.createRadialGradient(6, 6, 0, 6, 6, 4 + f.night * 13);
                glow.addColorStop(0, `rgba(255,211,110,${0.8 * f.night})`);
                glow.addColorStop(1, "rgba(255,211,110,0)");
                cx.fillStyle = glow;
                cx.beginPath();
                cx.arc(6, 6, 4 + f.night * 13, 0, Math.PI * 2);
                cx.fill();
              }
              cx.fillStyle = mix("#eeeae0", "#ffd36e", f.night);
              cx.beginPath();
              cx.arc(6, 6, 4, 0, Math.PI * 2);
              cx.fill();
              cx.restore();
            },
          });
        }
        f.blocks.forEach((block, q) => {
          items.push({
            z: block.z,
            paint: () => {
              cx.save();
              cx.translate(block.l, block.t);
              if (props.sel === q) {
                const ring = polygon(block.ring);
                cx.fillStyle = "rgba(18,28,32,.08)";
                cx.fill(ring);
                cx.strokeStyle = "#121c20";
                cx.lineWidth = 1.6;
                cx.setLineDash([4, 3]);
                cx.stroke(ring);
                cx.setLineDash([]);
              }
              cx.lineWidth = 0.8;
              for (const face of block.faces) {
                const poly = polygon(face.pts);
                cx.fillStyle = face.fill;
                cx.fill(poly);
                cx.strokeStyle = face.stroke;
                cx.stroke(poly);
              }
              cx.restore();
            },
          });
        });
        items.sort((a, b) => a.z - b.z);
        for (const item of items) item.paint();
        cx.restore();
      }}
    />
  );

  const label = (text: string, at: { x: number; y: number }, testID: string, mono = false) => (
    <Anchored testID={testID} x={vx(at.x)} y={vy(at.y)} fx={0.5} fy={0} z={40} class="px-2 py-px rounded-full bg-pane/85" style={{ pointerEvents: "none" }}>
      <Text class={`text-[11px] text-ink-secondary ${mono ? "font-mono" : ""}`}>{text}</Text>
    </Anchored>
  );

  return (
    <View
      testID="taskmap-view"
      ref={(node: ViewRef) => (sceneRef = node)}
      role="group"
      accessibilityState={{ busy: panning() }}
      class="absolute left-0 top-0 right-0 bottom-0 overflow-hidden"
      {...pan.panHandlers}
      onPressDown={(e) => {
        turning = e.modifiers.shift || e.modifiers.alt;
        last = { x: 0, y: 0 };
      }}
      onPress={(e) => {
        if (!fresh()) return;
        const q = blockAt(e.position.x, e.position.y);
        if (q >= 0) props.onPick(q);
        else props.onDeselect();
      }}
      onMouseMove={(e) => {
        if (e.pressedButton === "right") {
          if (!right) {
            right = { x: e.position.x, y: e.position.y };
            props.onDragging(true);
          }
          props.onTurn((e.position.x - right.x) * 0.4);
          right = { x: e.position.x, y: e.position.y };
          return;
        }
        if (right) {
          right = null;
          props.onDragging(null);
        }
        if (!e.pressedButton) props.onHover(blockAt(e.position.x, e.position.y));
      }}
      onMouseLeave={() => {
        if (right) {
          right = null;
          props.onDragging(null);
        }
        props.onHover(-1);
      }}
    >
      {sky}
      {ground}

      {label(props.labels.ext, frame().ground.lb.ext, "taskmap-region-ext")}
      {label(props.labels.ws, frame().ground.lb.ws, "taskmap-region-ws")}
      {label(props.labels.town, frame().ground.lb.town, "taskmap-region-town", true)}

      <Each of={frame().blocks.filter((b) => b.fx.on)} key={(b) => b.district.key}>
        {(block) => (
          <View style={{ position: "absolute", left: vx(block().l + block().fx.x), top: vy(block().t + block().fx.y), width: 0, height: 0, zIndex: block().z, transformOrigin: "0% 0%", transform: [{ scale: view().k }], pointerEvents: "none" }}>
            <BlockFx archetype={block().district.archetype} color={cssColor(block().district.color)} />
          </View>
        )}
      </Each>

      <Each of={frame().blocks} key={(b) => b.district.key}>
        {(block, q) => <Plate block={block()} q={q()} />}
      </Each>

      <Each of={frame().actors} key={(a) => a.key}>
        {(actor) => <Actor actor={actor()} />}
      </Each>

      <Each of={frame().actors} key={(a) => a.key}>
        {(actor) => <Badge actor={actor()} />}
      </Each>
    </View>
  );

  /** A building's plate: its name and count, and who is there doing what. */
  function Plate(p: { block: FrameBlock; q: number }) {
    const b = () => p.block;
    const on = () => props.sel === p.q;
    const hot = () => props.hover === p.q;
    const bob = createMotion();
    effect(() => {
      if (b().flag && !reduceMotion()) void bob.play({ duration: 1100, keyframes: { translateY: [0, -5, 0] }, easing: Easing.inOut(Easing.ease), iterations: "infinite" });
      else bob.reset();
    });
    return (
      <Anchored x={vx(b().px)} y={vy(b().plateY)} fx={0.5} fy={1} z={on() || hot() ? 360 : 300}>
        <View
          role="button"
          testID={`taskmap-plate-${b().district.key}`}
          accessibilityLabel={props.t.insp.aria(b().name, Number(b().n) || 0, on())}
          accessibilityState={{ selected: on() }}
          tooltip={tip(b().name)}
          onPress={() => {
            if (fresh()) props.onPick(p.q);
          }}
          onMouseEnter={() => props.onHover(p.q)}
          onMouseLeave={() => props.onHover(-1)}
          class={`items-center px-[7px] pt-[2px] pb-[3px] rounded-[8px] border bg-pane/95 ${on() ? "border-ink" : hot() ? "border-muted-light" : "border-line"}`}
          style={{ maxWidth: 180, boxShadow: "0 1px 3px rgba(18,28,32,.14)" }}
        >
          <If when={b().flag}>
            <View
              testID={`taskmap-quest-flag-${b().district.key}`}
              class="absolute w-[20px] h-[20px] rounded-full items-center justify-center bg-mustard"
              style={{ left: "50%", top: -25, marginLeft: -10, transform: [...bob.transform], boxShadow: `0 0 0 2px ${token("pane")}, 0 2px 6px rgba(18,28,32,.3)` }}
            >
              <Text class="text-[13px] font-extrabold text-on-mustard">!</Text>
            </View>
          </If>
          <View class="flex-row items-center justify-center gap-1">
            <View class="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{ backgroundColor: cssColor(b().district.color) }} />
            <If when={!b().compact || hot() || on()}>
              <Text class="shrink min-w-0 text-[12px] font-bold text-ink line-clamp-1">{b().name}</Text>
            </If>
            <Text class="shrink-0 font-mono text-[10.5px] font-medium text-ink-muted">{String(b().n)}</Text>
          </View>
          <Each of={b().lines}>
            {(line) => (
              <View class="flex-row items-center justify-center gap-[3px]">
                <If when={props.logos[line().b]}>{(logo) => <MapLogo source={logo()} size={12} />}</If>
                <Text class="text-[10px] line-clamp-1" style={{ color: whoInk(props.colors[line().b] ?? "#146a7c") }}>
                  {line().text}
                  <Text class="text-ink-muted">{line().model}</Text>
                </Text>
              </View>
            )}
          </Each>
        </View>
      </Anchored>
    );
  }

  /** A character at its place on the town: its shadow, its figure and the hit that follows it. */
  function Actor(p: { actor: FrameActor }) {
    const a = () => p.actor;
    // Where it stands and whether it is there at all glide, as they did under CSS transitions.
    const at = glide(() => [a().x, a().y, a().present ? 1 : 0], () => props.walkMs);
    const fig = () => props.figures[a().b];
    const c = () => view();
    return (
      <View
        testID={`taskmap-actor-${a().b}`}
        style={{
          position: "absolute",
          left: vx(at()[0]!),
          top: vy(at()[1]!),
          width: 58,
          height: 64,
          zIndex: a().z,
          opacity: at()[2]!,
          transformOrigin: "0% 0%",
          transform: [{ scale: c().k }],
          pointerEvents: "box-none",
        }}
      >
        <If when={frame().cast.alpha > 0}>
          <View
            style={{
              position: "absolute",
              left: 20,
              top: 55,
              width: Math.round(frame().cast.len * a().scale + 18),
              height: 10,
              borderRadius: 999,
              backgroundImage: "linear-gradient(90deg, rgb(23,38,42), rgba(23,38,42,.3))",
              transformOrigin: "9px 50%",
              transform: [{ rotate: `${frame().cast.angle}deg` }],
              opacity: frame().cast.alpha,
              pointerEvents: "none",
            }}
          />
        </If>
        <View
          style={{
            position: "absolute",
            left: 12,
            top: 55,
            width: 34,
            height: 8,
            borderRadius: 17,
            backgroundColor: "rgba(23,38,42,.25)",
            boxShadow: props.follow === a().b ? `0 0 0 2px ${cssColor(props.colors[a().b] ?? "#146a7c")}` : undefined,
            pointerEvents: "none",
          }}
        />
        <If when={fig()}>
          {(f) => <MapFigure fig={f()} motion={a().motion} work={a().status === "work"} b={a().b} scale={a().scale} tint={props.tint} />}
        </If>
        <If when={a().present}>
          <View
            role="button"
            testID={`taskmap-actor-hit-${a().b}`}
            accessibilityLabel={props.follow === a().b ? props.t.stopFollowOf(a().short) : props.t.followOf(a().short)}
            onPress={() => props.onFollow(a().b)}
            style={{ position: "absolute", left: 8, top: 4, width: 42, height: 56, borderRadius: 12, pointerEvents: "auto" }}
          />
        </If>
      </View>
    );
  }

  /** The badge over a character's head: its logo or face, status, name and model. Screen-sized at any zoom. */
  function Badge(p: { actor: FrameActor }) {
    const a = () => p.actor;
    const at = glide(() => [a().x, a().y, a().present ? 1 : 0], () => props.walkMs);
    const fig = () => props.figures[a().b];
    const side = () => a().side;
    return (
      <If when={a().present}>
        <Anchored
          testID={`taskmap-badge-${a().b}`}
          x={vx(at()[0]!) + 29 * view().k}
          y={vy(at()[1]!) + a().badgeTop * view().k - a().lift * 28}
          fx={side() < 0 ? 1 : side() > 0 ? 0 : 0.5}
          fy={1}
          dx={side() < 0 ? 14.5 : side() > 0 ? -14.5 : 0}
          z={a().z + 100}
          style={{ pointerEvents: "none", opacity: at()[2]! }}
        >
          <View
            tooltip={tip(props.t.ranBy(props.logos[a().b]?.name ?? "", a().modelShort))}
            class={`items-center gap-1 h-[26px] rounded-full border-[1.5px] bg-pane/95 ${side() < 0 ? "flex-row-reverse pl-2 pr-[2px]" : "flex-row pl-[2px] pr-2"}`}
            style={{ borderColor: cssColor(props.colors[a().b] ?? "#146a7c"), boxShadow: "0 1px 3px rgba(18,28,32,.18)" }}
          >
            <View class="relative shrink-0">
              <If when={fig()?.avatar} else={<If when={props.logos[a().b]}>{(logo) => <MapLogo source={logo()} size={20} />}</If>}>
                {(src) => <Image src={src()} class="bg-ground" style={{ width: 20, height: 20, borderRadius: 10, objectFit: "cover" }} accessible={false} />}
              </If>
              <View
                class="absolute w-[8px] h-[8px] rounded-full border-[1.5px] border-pane"
                style={{ right: -3, bottom: -2, backgroundColor: STATUS_DOT[a().status] }}
              />
            </View>
            <Text class="text-[11px] font-bold" style={{ color: whoInk(props.colors[a().b] ?? "#146a7c") }}>{a().short}</Text>
            <If when={a().hasModel}>
              <View class="flex-row items-center gap-[3px]">
                <If when={fig()?.avatar && props.logos[a().b]}>{() => <MapLogo source={props.logos[a().b]!} size={11} />}</If>
                <Text class="text-[10px] font-semibold text-ink-muted">{a().modelShort}</Text>
              </View>
            </If>
          </View>
        </Anchored>
      </If>
    );
  }
}
