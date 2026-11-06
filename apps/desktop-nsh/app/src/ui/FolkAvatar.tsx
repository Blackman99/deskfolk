/**
 * A folk avatar acting out its Bot's status (`folkMotion`), as `FolkAvatar.svelte` does. It stacks
 * the layers its stored SVG is drawn from (the SVG itself cannot carry them here: a native SVG draws
 * no embedded images), so it is the same face; it has no fill, fills its box, and may reach past the
 * box when it hops or waves. With reduced motion each status keeps a still pose: raised hand, closed
 * eyes, frown.
 */
import { Easing, Image, Text, View, createMotion, effect, reduceMotion, signal, token, type Motion, type MotionSpec } from "nsh";
import { FOLK_GEOMETRY, FOLK_RAISED_ARM_DEG, folkHash, folkLayerSrc, folkLook } from "@real-bot/protocol";
import type { FolkMotion } from "../m/folk-motion";

const origin = ([x, y]: readonly [number, number]) => `${x * 100}% ${y * 100}%`;
const FILL = { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none" } as const;
const SWEAT = "M80 26C76 33 76 37 80 37C84 37 84 33 80 26Z";

/** Plays `spec` over and over on `m` while `on()` holds, and rests it after. */
function loop(m: Motion, on: () => boolean, spec: () => MotionSpec | null): void {
  effect(() => {
    const s = on() && !reduceMotion() ? spec() : null;
    if (s) void m.play({ ...s, iterations: "infinite" });
    else m.reset();
  });
}

const step = Easing.steps(1);

export function FolkAvatar(props: {
  /** The Bot's stored avatar (a folk's SVG, whose mask id holds the name hash). */
  avatar: string;
  motion?: FolkMotion;
  testID?: string;
}) {
  const motion = () => props.motion ?? "idle";
  const hash = () => folkHash(props.avatar) ?? 0;
  const look = () => folkLook(hash());
  /** Folks in one list blink out of step. */
  const blinkDelay = () => (hash() % 52) * 100;
  const is = (kind: FolkMotion) => motion() === kind;
  /** The box's edge in points: percentages of it are the pixels a transform moves by. */
  const edge = signal(0);
  const still = () => reduceMotion();

  const fig = createMotion();
  const armL = createMotion();
  const armR = createMotion();
  const eyes = createMotion();
  const eyesClosed = createMotion();
  const mouthA = createMotion();
  const mouthB = createMotion();
  const shadowM = createMotion();
  const markM = [createMotion(), createMotion(), createMotion()];

  loop(fig, () => motion() !== "idle", () => {
    switch (motion()) {
      case "running": return { duration: 2800, keyframes: { rotate: ["-4deg", "4deg"] }, direction: "alternate", easing: Easing.inOut(Easing.ease) };
      case "replying": return { duration: 500, keyframes: { translateY: [0, -0.03 * edge()], scaleX: [1, 0.99], scaleY: [1, 1.01] }, direction: "alternate" };
      case "waiting": return { duration: 1500, keyframes: { translateY: [0, 0, -0.11 * edge(), 0, 0], scaleX: [1, 1.06, 0.97, 1.05, 1], scaleY: [1, 0.93, 1.04, 0.95, 1] } };
      case "failed": return { duration: 3200, keyframes: { rotate: ["-3deg", "-1deg"] }, direction: "alternate", easing: Easing.inOut(Easing.ease) };
      case "held": return { duration: 3600, keyframes: { scaleX: [1, 1.025], scaleY: [1, 0.985] }, direction: "alternate" };
      default: return null;
    }
  });
  loop(armL, () => is("replying"), () => ({ duration: 260, keyframes: { rotate: ["0deg", "-24deg"] }, direction: "alternate" }));
  loop(armR, () => is("replying") || is("waiting"), () =>
    is("waiting")
      ? { duration: 500, keyframes: { rotate: ["-112deg", "-146deg"] }, direction: "alternate" }
      : { duration: 260, delay: 130, keyframes: { rotate: ["0deg", "24deg"] }, direction: "alternate" });
  // Every folk blinks now and then; asleep it keeps its eyes shut.
  loop(eyes, () => !is("held"), () => ({
    duration: 5200,
    delay: blinkDelay(),
    keyframes: { opacity: [{ offset: 0, value: 1 }, { offset: 0.93, value: 1 }, { offset: 0.94, value: 0 }, { offset: 0.96, value: 0 }, { offset: 0.97, value: 1 }, { offset: 1, value: 1 }] },
  }));
  loop(eyesClosed, () => !is("held"), () => ({
    duration: 5200,
    delay: blinkDelay(),
    keyframes: { opacity: [{ offset: 0, value: 0 }, { offset: 0.93, value: 0 }, { offset: 0.94, value: 1 }, { offset: 0.96, value: 1 }, { offset: 0.97, value: 0 }, { offset: 1, value: 0 }] },
  }));
  loop(mouthA, () => is("replying"), () => ({ duration: 340, keyframes: { opacity: [{ offset: 0, value: 1, easing: step }, { offset: 0.5, value: 0, easing: step }, { offset: 1, value: 1 }] } }));
  loop(mouthB, () => is("replying"), () => ({ duration: 340, keyframes: { opacity: [{ offset: 0, value: 0, easing: step }, { offset: 0.5, value: 1, easing: step }, { offset: 1, value: 0 }] } }));
  loop(shadowM, () => is("waiting"), () => ({ duration: 1500, keyframes: { scale: [1, 1, 0.75, 1, 1], opacity: [1, 1, 0.5, 1, 1] } }));
  markM.forEach((m, i) =>
    loop(m, () => is("running") || is("held") || is("failed"), () => {
      if (is("running")) return { duration: 1200, delay: i * 200, keyframes: { opacity: [0.25, 1, 0.25, 0.25], translateY: [0, -0.03 * edge(), 0, 0] } };
      if (is("held")) return { duration: 2700, delay: i * 900, keyframes: { opacity: [0, 1, 0], translateX: [0, 0.06 * edge(), 0.12 * edge()], translateY: [0.18 * edge(), 0.02 * edge(), -0.14 * edge()] } };
      return i === 0 ? { duration: 2400, keyframes: { opacity: [0, 1, 0], translateY: [0, 0.04 * edge(), 0.22 * edge()] }, easing: Easing.in(Easing.ease) } : null;
    }),
  );

  // The poses it keeps with no motion: a raised hand, closed eyes, a frown, eyes up or down.
  const raised = () => (look().wave && is("idle")) || (still() && is("waiting"));
  const closed = () => is("held");
  const eyeShift = () => (is("running") ? -0.035 : is("failed") ? 0.012 : 0) * edge();
  const frown = () => (is("failed") ? -1 : 1);
  const figPose = () => (is("failed") ? [{ scaleX: 1.04 }, { scaleY: 0.95 }] : []);
  const mark = (i: number) => markM[i]!;
  const dim = (m: Motion) => ({ opacity: m.opacity });

  return (
    <View testID={props.testID} accessible={false} class="relative w-full h-full" style={{ overflow: "visible" }} onLayout={(e) => edge.set(e.bounds.size.width)}>
      <View
        class="rounded-full bg-folk-shadow"
        style={{ position: "absolute", left: "18%", right: "18%", bottom: "-2%", height: "9%", pointerEvents: "none", transform: [...shadowM.transform], opacity: shadowM.opacity }}
      />
      <View style={{ ...FILL, transform: [{ scaleX: look().mirror ? -1 : 1 }] }}>
        <View style={{ ...FILL, transformOrigin: "50% 98%", transform: [...figPose(), ...fig.transform] }}>
          <Image src={folkLayerSrc("body")} style={FILL} />
          <Image
            src={folkLayerSrc("arm-l")}
            style={{ ...FILL, transformOrigin: origin(FOLK_GEOMETRY.shoulderL), transform: [...armL.transform] }}
          />
          <Image
            src={folkLayerSrc("arm-r")}
            style={{
              ...FILL,
              transformOrigin: origin(FOLK_GEOMETRY.shoulderR),
              transform: [{ rotate: raised() ? `${-FOLK_RAISED_ARM_DEG}deg` : is("waiting") ? "-128deg" : "0deg" }, ...armR.transform],
            }}
          />
          <Image
            src={folkLayerSrc(`eyes-${look().eyes}`)}
            style={{ ...FILL, opacity: closed() ? 0 : eyes.opacity, transform: [{ translateY: eyeShift() }] }}
          />
          <Image
            src={folkLayerSrc("eyes-closed")}
            style={{ ...FILL, opacity: closed() ? 1 : eyesClosed.opacity, transform: [{ translateY: eyeShift() }] }}
          />
          <Image
            src={folkLayerSrc(`mouth-${look().mouth}`)}
            style={{ ...FILL, transformOrigin: origin(FOLK_GEOMETRY.mouth), opacity: mouthA.opacity, transform: [{ scaleY: frown() }] }}
          />
          <Image
            src={folkLayerSrc("mouth-open")}
            style={{ ...FILL, transformOrigin: origin(FOLK_GEOMETRY.mouth), opacity: is("replying") ? mouthB.opacity : 0 }}
          />
          <If when={look().accessory}>{(acc) => <Image src={folkLayerSrc(`acc-${acc()}`)} style={FILL} />}</If>
        </View>
      </View>
      <If when={is("running")}>
        <View style={FILL}>
          {[74, 83, 92].map((x, i) => (
            <View
              class="rounded-full bg-brand"
              style={{ position: "absolute", left: `${x - 3.6}%`, top: "4.4%", width: "7.2%", height: "7.2%", opacity: mark(i).opacity, transform: [...mark(i).transform] }}
            />
          ))}
        </View>
      </If>
      <If when={is("failed")}>
        <View style={FILL}>
          <Image
            src={`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${SWEAT}" fill="${token("brand")}" fill-opacity="0.55"/></svg>`)}`}
            style={{ ...FILL, opacity: mark(0).opacity, transform: [...mark(0).transform] }}
          />
        </View>
      </If>
      <If when={is("held")}>
        <View style={FILL}>
          {[20, 16, 13].map((size, i) => (
            <Text
              class="font-bold text-brand"
              style={{ position: "absolute", left: "74%", top: "4%", fontSize: size * 0.5, opacity: mark(i).opacity, transform: [...mark(i).transform] }}
            >
              z
            </Text>
          ))}
        </View>
      </If>
    </View>
  );
}
