/**
 * One character of the map (`MapFigure.svelte`, ADR 0097) in its actor box (58 x 64 points): its
 * own figure, its face to you, its avatar on its pin; it moves as its status has it. At work each
 * character does its own work, with what it wears and holds (`figure-motions.ts`). The box is in
 * the town's units: the scene scales it with the camera, so nothing here knows the zoom.
 */
import { Image, View, createMotion, effect, reduceMotion, type Motion, type MotionSpec, type ViewRef } from "nsh";
import type { FolkMotion } from "../../m/folk-motion";
import { figureOrigin, type DrawnFigure, type FigureImage } from "../../m/taskmap/scene/figures";
import { FX, WORK_FX, WORK_STILL, figureSpecs, type Fx, type Part } from "./figure-motions";

const BOX_W = 58;
const BOX_H = 64;
const FILL = { position: "absolute", left: 0, top: 0, width: BOX_W, height: BOX_H } as const;

type Tint = { color: string; alpha: number } | null;

/** Plays `spec` over and over on `m` while there is one, and rests it after. */
function loop(m: Motion, spec: () => MotionSpec | undefined): void {
  effect(() => {
    const s = reduceMotion() ? undefined : spec();
    if (s) void m.play({ ...s, iterations: s.iterations ?? "infinite" });
    else m.reset();
  });
}

/** A picture of the figure in its place in the box, with the hour's colour over it when `tint`. */
function Pic(props: { im: FigureImage; tint?: Tint; opacity?: unknown; style?: Record<string, unknown> }) {
  const place = () => ({ position: "absolute" as const, left: props.im.x, top: props.im.y, width: props.im.w, height: props.im.h });
  return (
    <>
      <Image src={props.im.href} style={{ ...place(), ...(props.opacity !== undefined ? { opacity: props.opacity as number } : {}), ...(props.style as object) }} accessible={false} />
      <If when={props.tint}>
        {(tint) => <Image src={props.im.href} style={{ ...place(), tintColor: tint().color, opacity: tint().alpha }} accessible={false} />}
      </If>
    </>
  );
}

const STAR = "50,0 61,39 100,50 61,61 50,100 39,61 0,50 39,39";
const svg = (body: string, view: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}">${body}</svg>`)}`;
const MARKS = {
  star: (c: string) => svg(`<polygon points="${STAR}" fill="${c}"/>`, "0 0 100 100"),
  ring: (c: string) => svg(`<path d="M1.5 3.2A4.6 4.6 0 0 1 8.5 3.2" fill="none" stroke="${c}" stroke-width="1.3" stroke-linecap="round"/>`, "0 0 10 10"),
  ringL: (c: string) => svg(`<path d="M3.2 1.5A4.6 4.6 0 0 0 3.2 8.5" fill="none" stroke="${c}" stroke-width=".8" stroke-linecap="round"/>`, "0 0 10 10"),
  ringR: (c: string) => svg(`<path d="M6.8 1.5A4.6 4.6 0 0 1 6.8 8.5" fill="none" stroke="${c}" stroke-width=".8" stroke-linecap="round"/>`, "0 0 10 10"),
  note: (c: string) => svg(`<ellipse cx="4" cy="9.3" rx="2.5" ry="1.8" transform="rotate(-22 4 9.3)" fill="${c}"/><path d="M5.7 9.2V1h1.3c.2 1.7 2.8 2.3 2.6 4.6-.7-1-1.5-1.5-2.6-1.6v5.2z" fill="${c}"/>`, "0 0 10 12"),
  tick: (c: string) => svg(`<path d="M2 6.2l3.1 3L11 2" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`, "0 0 13 11"),
};

/** `count` marks of one kind of work, rising off a spot of the character. */
function Marks(props: { fx: Fx; spot: readonly [number, number] }) {
  const look = FX[props.fx.kind];
  const colors = Array.isArray(look.color) ? look.color : [look.color as string];
  return (
    <View style={{ position: "absolute", left: props.spot[0], top: props.spot[1], width: 0, height: 0, pointerEvents: "none" }}>
      {Array.from({ length: props.fx.n }, (_, n) => {
        const m = createMotion({ initial: { opacity: 0 } });
        loop(m, () => look.motion(n));
        const color = colors[n % colors.length]!;
        const box = { position: "absolute" as const, left: look.dx, top: look.dy, width: look.w, height: look.h, opacity: m.opacity, transform: [...m.transform] };
        if (look.shape === "disc")
          return props.fx.kind === "glow" ? (
            <View style={{ ...box, borderRadius: look.w, backgroundImage: "radial-gradient(circle, rgba(190,250,255,.95) 0%, rgba(60,190,210,.5) 38%, rgba(27,138,156,0) 70%)" }} />
          ) : (
            <View style={{ ...box, borderRadius: look.w, backgroundColor: color }} />
          );
        if (look.shape === "rect") return <View style={{ ...box, borderRadius: 0.6, backgroundColor: color }} />;
        const src =
          look.shape === "star" ? MARKS.star(color)
          : look.shape === "ring" ? (props.fx.kind === "swish" ? (n ? MARKS.ringR(color) : MARKS.ringL(color)) : MARKS.ring(color))
          : props.fx.kind === "note" ? MARKS.note(color)
          : MARKS.tick(color);
        return <Image src={src} style={box} accessible={false} />;
      })}
    </View>
  );
}

export function MapFigure(props: {
  fig: DrawnFigure & { avatar: string | null };
  motion: FolkMotion;
  /** At work where it stands (not walking between places): it does its own work. */
  work: boolean;
  /** Its index among the characters, which keeps it blinking out of step with the others. */
  b: number;
  /** A subagent's figure is smaller (< 1). */
  scale: number;
  /** The hour's light on the figure, a colour laid over it, or null by day. */
  tint: Tint;
}) {
  const fig = () => props.fig;
  const specs = () => figureSpecs(props.motion, props.work, fig().figure, props.b);

  const parts: Record<Part, Motion> = {
    fig: createMotion(),
    antenna: createMotion(),
    armL: createMotion(),
    armR: createMotion(),
    heldL: createMotion(),
    heldR: createMotion(),
    eyes: createMotion(),
    blink: createMotion({ initial: { opacity: 0 } }),
    mouth: createMotion(),
    talk: createMotion({ initial: { opacity: 0 } }),
  };
  (Object.keys(parts) as Part[]).forEach((part) => loop(parts[part], () => specs()[part]));

  const is = (kind: FolkMotion) => props.motion === kind;
  const taroWork = () => props.work && fig().figure === "taro";
  const spot = (name: string): readonly [number, number] => {
    const m = /left:([\d.]+)%;top:([\d.]+)%/.exec(fig().spots[name] ?? "");
    return m ? [(Number(m[1]) / 100) * BOX_W, (Number(m[2]) / 100) * BOX_H] : [0, 0];
  };
  const fx = (list: Fx[] | undefined) => (props.work ? list ?? [] : []);
  const marks = (at: keyof typeof WORK_FX.pudding) => fx(WORK_FX[fig().figure][at]).map((f) => <Marks fx={f} spot={spot(f.at)} />);
  const shrink = () => [{ translateX: 29 * (1 - props.scale) }, { translateY: 60.16 * (1 - props.scale) }, { scale: props.scale }];
  // The pose an arm keeps with no motion: waving hand up while waiting on you.
  const armRStill = () => (is("waiting") && !props.work && reduceMotion() ? -128 : 0);
  const armLStill = () => (props.work ? WORK_STILL[fig().figure]?.armL ?? 0 : 0);
  const aboutBody = (): { transformOrigin: string } => ({ transformOrigin: "50% 89%" });

  return (
    <View
      testID={`taskmap-figure-${props.b}`}
      accessible={false}
      style={{ ...FILL, pointerEvents: "none", transformOrigin: "0% 0%", transform: shrink() }}
    >
      <View style={{ ...FILL, ...aboutBody(), transform: [...parts.fig.transform] }}>
        <Pic im={fig().body} tint={props.tint} />
        <If when={fig().antenna}>
          {(antenna) => (
            <View style={{ ...FILL, transformOrigin: figureOrigin(fig().antennaAt), transform: [...parts.antenna.transform] }}>
              <Pic im={antenna()} tint={props.tint} />
              {marks("antenna")}
            </View>
          )}
        </If>
        <Pic im={fig().eyes} opacity={taroWork() ? 0 : parts.eyes.opacity} />
        <Pic im={fig().blink} opacity={taroWork() ? 0 : parts.blink.opacity} />
        <If when={taroWork()}>
          <Pic im={fig().happy} />
        </If>
        <View style={{ ...FILL, transformOrigin: figureOrigin(fig().mouthAt), transform: [{ scaleY: is("failed") ? -1 : 1 }] }}>
          <Pic im={fig().mouth} opacity={parts.mouth.opacity} />
        </View>
        <View style={{ ...FILL, opacity: parts.talk.opacity }}>
          <Pic im={fig().talk} />
        </View>
        <If when={fig().front}>{(front) => <Pic im={front()} />}</If>
        <If when={fig().avatar}>
          {(avatar) => (
            <>
              <Pic im={fig().pin} />
              <Image
                src={avatar()}
                style={{
                  position: "absolute",
                  left: fig().chest[0] - fig().chestR,
                  top: fig().chest[1] - fig().chestR,
                  width: fig().chestR * 2,
                  height: fig().chestR * 2,
                  borderRadius: fig().chestR,
                  objectFit: "cover",
                }}
                accessible={false}
              />
            </>
          )}
        </If>
        {marks("fig")}
        <View style={{ ...FILL, transformOrigin: figureOrigin(fig().shoulderL), transform: [{ rotate: `${armLStill()}deg` }, ...parts.armL.transform] }}>
          <Pic im={fig().armL} tint={props.tint} />
          <If when={fig().heldL}>
            {(held) => (
              <View style={{ ...FILL, transformOrigin: figureOrigin(fig().handL), transform: [...parts.heldL.transform] }}>
                <Pic im={held()} tint={props.tint} />
                {marks("heldL")}
              </View>
            )}
          </If>
        </View>
        <View style={{ ...FILL, transformOrigin: figureOrigin(fig().shoulderR), transform: [{ rotate: `${armRStill()}deg` }, ...parts.armR.transform] }}>
          <Pic im={fig().armR} tint={props.tint} />
          {marks("armR")}
          <If when={fig().heldR}>
            {(held) => (
              <View style={{ ...FILL, transformOrigin: figureOrigin(fig().handR), transform: [...parts.heldR.transform] }}>
                <Pic im={held()} tint={props.tint} />
                {marks("heldR")}
              </View>
            )}
          </If>
        </View>
      </View>
    </View>
  );
}
