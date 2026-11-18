/**
 * A folk avatar acting out its Bot's status (`folkMotion`), as `FolkAvatar.svelte` does. It stacks
 * the layers its stored SVG is drawn from (the SVG itself cannot carry them here: a native SVG draws
 * no embedded images), so it is the same face; it has no fill, fills its box, and may reach past the
 * box when it hops or waves. With reduced motion each status keeps a still pose: raised hand, closed
 * eyes, frown.
 */
import { Easing, Image, Text, View, cleanup, computed, createMotion, effect, signal, token, type Motion, type MotionSpec } from "nsh";
import { LoopsHeld, reduceMotion } from "./interface/motion";
import { FOLK_GEOMETRY, FOLK_RAISED_ARM_DEG, folkHash, folkLayerSrc, folkLook, folkPart, type FolkPart } from "@real-bot/protocol";
import type { FolkMotion } from "../m/folk-motion";
import { figureSpecs, WORK_STILL, type Specs } from "./taskmap/figure-motions";

const origin = ([x, y]: readonly [number, number]) => `${x * 100}% ${y * 100}%`;
const FILL = { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none" } as const;
const SWEAT = "M76 40C72 47 72 51 76 51C80 51 80 47 76 40Z";

/**
 * Plays `spec` over and over on `m` while `on()` holds, and rests it after. Gives whether it plays:
 * bind `m`'s values only then. On the web NSH writes every bound animated value on every animation
 * frame of the page; a rested motion is where `reset` leaves it (unmoved, opaque), which the part's
 * own style shows without it.
 */
function loop(m: Motion, on: () => boolean, spec: () => MotionSpec | null): () => boolean {
  const playing = computed(() => on() && !reduceMotion() && spec() !== null);
  effect(() => {
    const s = playing() ? spec() : null;
    if (s) void m.play({ ...s, iterations: "infinite" });
    else m.reset();
  });
  return playing;
}

/**
 * How often a folk blinks, when in that wait its lids start down, and how long they take to be open
 * again: the Svelte keyframes' 93% to 97% of 5.2 s.
 */
const BLINK_EVERY_MS = 5200;
const BLINK_AT_MS = BLINK_EVERY_MS * 0.93;
const BLINK_MS = BLINK_EVERY_MS * 0.04;
const BLINK_OPEN = { opacity: [{ offset: 0, value: 1 }, { offset: 0.25, value: 0 }, { offset: 0.75, value: 0 }, { offset: 1, value: 1 }] };
const BLINK_SHUT = { opacity: [{ offset: 0, value: 0 }, { offset: 0.25, value: 1 }, { offset: 0.75, value: 1 }, { offset: 1, value: 0 }] };

const step = Easing.steps(1);

/**
 * A character's work, as it works on the task map (`figureSpecs`), for an avatar `edge` points
 * wide: the angles carry over, the distances (box points of a map figure, whose body is some 45 of
 * them; here it is 0.19 m of the 0.31 m square) are scaled to it.
 */
function avatarWork(motion: FolkMotion, character: Parameters<typeof figureSpecs>[2], edge: number): Specs {
  const k = (edge * (0.19 / 0.31)) / 45;
  const scaled = (spec: MotionSpec | undefined): MotionSpec | undefined => {
    if (!spec || !Array.isArray(spec.keyframes)) return spec;
    return {
      ...spec,
      keyframes: spec.keyframes.map((frame) => ({
        ...frame,
        ...(typeof frame.translateX === "number" ? { translateX: frame.translateX * k } : {}),
        ...(typeof frame.translateY === "number" ? { translateY: frame.translateY * k } : {}),
      })),
    };
  };
  const specs = figureSpecs(motion, true, character, 0);
  return { fig: scaled(specs.fig), antenna: specs.antenna, armL: specs.armL, armR: specs.armR, heldL: specs.heldL, heldR: specs.heldR };
}

export function FolkAvatar(props: {
  /** The Bot's stored avatar (a folk's SVG, whose mask id holds the name hash). */
  avatar: string;
  motion?: FolkMotion;
  testID?: string;
}) {
  const motion = () => props.motion ?? "idle";
  const hash = () => folkHash(props.avatar) ?? 0;
  const look = () => folkLook(hash());
  /** The character's own layer for a part, as an image source, or null when it has none. */
  const part = (name: FolkPart) => {
    const layer = folkPart(look(), name);
    return layer ? folkLayerSrc(layer) : null;
  };
  /** Folks in one list blink out of step. */
  const blinkDelay = () => (hash() % 52) * 100;
  const is = (kind: FolkMotion) => motion() === kind;
  /** The box's edge in points: percentages of it are the pixels a transform moves by. */
  const edge = signal(0);
  const still = () => reduceMotion();
  /** Under a page that covers it (the phone's roster), it holds still. */
  const held = LoopsHeld();
  const free = () => !held();

  const fig = createMotion();
  const armL = createMotion();
  const armR = createMotion();
  const heldL = createMotion();
  const heldR = createMotion();
  const antennaM = createMotion();
  const eyes = createMotion();
  const eyesClosed = createMotion({ initial: { opacity: 0 } });
  const mouthA = createMotion();
  const mouthB = createMotion();
  const shadowM = createMotion();
  const markM = [createMotion(), createMotion(), createMotion()];

  // Thinking or replying, it works its own way, as its character does on the task map.
  const working = () => is("running") || is("replying");
  const work = () => avatarWork(motion(), look().character, edge());
  const figOn = loop(fig, () => free() && motion() !== "idle", () => {
    switch (motion()) {
      case "running":
      case "replying": return work().fig ?? null;
      case "waiting": return { duration: 1500, keyframes: { translateY: [0, 0, -0.11 * edge(), 0, 0], scaleX: [1, 1.06, 0.97, 1.05, 1], scaleY: [1, 0.93, 1.04, 0.95, 1] } };
      case "failed": return { duration: 3200, keyframes: { rotate: ["-3deg", "-1deg"] }, direction: "alternate", easing: Easing.inOut(Easing.ease) };
      case "held": return { duration: 3600, keyframes: { scaleX: [1, 1.025], scaleY: [1, 0.985] }, direction: "alternate" };
      default: return null;
    }
  });
  const armLOn = loop(armL, () => free() && working(), () => work().armL ?? null);
  const armROn = loop(armR, () => free() && (working() || is("waiting")), () =>
    is("waiting") ? { duration: 500, keyframes: { rotate: ["-112deg", "-146deg"] }, direction: "alternate" } : (work().armR ?? null));
  const heldLOn = loop(heldL, () => free() && working(), () => work().heldL ?? null);
  const heldROn = loop(heldR, () => free() && working(), () => work().heldR ?? null);
  const antennaOn = loop(antennaM, () => free() && working(), () => work().antenna ?? null);
  /** An arm a character keeps still at work (matcha's), in degrees. */
  const stillArmL = () => (working() && !still() ? (WORK_STILL[look().character]?.armL ?? 0) : 0);
  // Every folk blinks now and then; asleep it keeps its eyes shut. One blink at a time from a timer,
  // not a loop: between blinks the eyes hold no animated value and nothing moves, so a page of idle
  // folks draws no frames for them.
  const blinking = signal(false);
  effect(() => {
    if (is("held") || still() || held()) return;
    let timer: ReturnType<typeof setTimeout>;
    const blink = () => {
      blinking.set(true);
      void eyes.play({ duration: BLINK_MS, keyframes: BLINK_OPEN });
      void eyesClosed.play({ duration: BLINK_MS, keyframes: BLINK_SHUT }).then(() => blinking.set(false));
      timer = setTimeout(blink, BLINK_EVERY_MS);
    };
    timer = setTimeout(blink, blinkDelay() + BLINK_AT_MS);
    cleanup(() => {
      clearTimeout(timer);
      blinking.set(false);
    });
  });
  const mouthAOn = loop(mouthA, () => free() && is("replying"), () => ({ duration: 340, keyframes: { opacity: [{ offset: 0, value: 1, easing: step }, { offset: 0.5, value: 0, easing: step }, { offset: 1, value: 1 }] } }));
  const mouthBOn = loop(mouthB, () => free() && is("replying"), () => ({ duration: 340, keyframes: { opacity: [{ offset: 0, value: 0, easing: step }, { offset: 0.5, value: 1, easing: step }, { offset: 1, value: 0 }] } }));
  const shadowOn = loop(shadowM, () => free() && is("waiting"), () => ({ duration: 1500, keyframes: { scale: [1, 1, 0.75, 1, 1], opacity: [1, 1, 0.5, 1, 1] } }));
  const markOn = markM.map((m, i) =>
    loop(m, () => free() && (is("running") || is("held") || is("failed")), () => {
      if (is("running")) return { duration: 1200, delay: i * 200, keyframes: { opacity: [0.25, 1, 0.25, 0.25], translateY: [0, -0.03 * edge(), 0, 0] } };
      if (is("held")) return { duration: 2700, delay: i * 900, keyframes: { opacity: [0, 1, 0], translateX: [0, 0.06 * edge(), 0.12 * edge()], translateY: [0.18 * edge(), 0.02 * edge(), -0.14 * edge()] } };
      return i === 0 ? { duration: 2400, keyframes: { opacity: [0, 1, 0], translateY: [0, 0.04 * edge(), 0.22 * edge()] }, easing: Easing.in(Easing.ease) } : null;
    }),
  );

  // The poses it keeps with no motion: a raised hand, closed eyes, a frown, eyes up or down.
  const raised = () => (look().wave && is("idle")) || (still() && is("waiting"));
  const closed = () => is("held");
  const eyeShift = () => (is("running") ? -0.025 : is("failed") ? 0.009 : 0) * edge();
  const frown = () => (is("failed") ? -1 : 1);
  const figPose = () => (is("failed") ? [{ scaleX: 1.04 }, { scaleY: 0.95 }] : []);
  const mark = (i: number) => markM[i]!;
  /** A motion's transform and opacity while it plays (`loop`); its rest, unmoved and opaque, otherwise. */
  const turn = (on: () => boolean, m: Motion) => (on() ? [...m.transform] : []);
  const fade = (on: () => boolean, m: Motion) => (on() ? m.opacity : 1);

  return (
    <View testID={props.testID} accessible={false} class="relative w-full h-full" style={{ overflow: "visible" }} onLayout={(e) => edge.set(e.bounds.size.width)}>
      <View
        class="rounded-full bg-folk-shadow"
        style={{ position: "absolute", left: "27%", right: "27%", bottom: "-2%", height: "9%", pointerEvents: "none", transform: turn(shadowOn, shadowM), opacity: fade(shadowOn, shadowM) }}
      />
      <View style={{ ...FILL, transform: [{ scaleX: look().mirror ? -1 : 1 }] }}>
        <View style={{ ...FILL, transformOrigin: "50% 98%", transform: [...figPose(), ...turn(figOn, fig)] }}>
          <Image src={part("body")!} style={FILL} />
          <If when={part("antenna")}>
            {(src) => <Image src={src()} style={{ ...FILL, transformOrigin: origin(FOLK_GEOMETRY.antenna), transform: turn(antennaOn, antennaM) }} />}
          </If>
          {/* Each arm turns about its shoulder with what its hand holds, which turns about the hand. */}
          <View style={{ ...FILL, transformOrigin: origin(FOLK_GEOMETRY.shoulderL), transform: [{ rotate: `${stillArmL()}deg` }, ...turn(armLOn, armL)] }}>
            <Image src={part("arm-l")!} style={FILL} />
            <If when={part("held-l")}>
              {(src) => <Image src={src()} style={{ ...FILL, transformOrigin: origin(FOLK_GEOMETRY.handL), transform: turn(heldLOn, heldL) }} />}
            </If>
          </View>
          <View
            style={{
              ...FILL,
              transformOrigin: origin(FOLK_GEOMETRY.shoulderR),
              transform: [{ rotate: raised() ? `${-FOLK_RAISED_ARM_DEG}deg` : is("waiting") ? "-128deg" : "0deg" }, ...turn(armROn, armR)],
            }}
          >
            <Image src={part("arm-r")!} style={FILL} />
            <If when={part("held-r")}>
              {(src) => <Image src={src()} style={{ ...FILL, transformOrigin: origin(FOLK_GEOMETRY.handR), transform: turn(heldROn, heldR) }} />}
            </If>
          </View>
          <Image
            src={folkLayerSrc(`eyes-${look().eyes}`)}
            style={{ ...FILL, opacity: closed() ? 0 : blinking() ? eyes.opacity : 1, transform: [{ translateY: eyeShift() }] }}
          />
          <Image
            src={folkLayerSrc("eyes-closed")}
            style={{ ...FILL, opacity: closed() ? 1 : blinking() ? eyesClosed.opacity : 0, transform: [{ translateY: eyeShift() }] }}
          />
          <Image
            src={folkLayerSrc(`mouth-${look().mouth}`)}
            style={{ ...FILL, transformOrigin: origin(FOLK_GEOMETRY.mouth), opacity: fade(mouthAOn, mouthA), transform: [{ scaleY: frown() }] }}
          />
          <Image
            src={folkLayerSrc("mouth-open")}
            style={{ ...FILL, transformOrigin: origin(FOLK_GEOMETRY.mouth), opacity: is("replying") ? fade(mouthBOn, mouthB) : 0 }}
          />
          <If when={part("front")}>{(src) => <Image src={src()} style={FILL} />}</If>
        </View>
      </View>
      <If when={is("running")}>
        <View style={FILL}>
          {[74, 83, 92].map((x, i) => (
            <View
              class="rounded-full bg-brand"
              style={{ position: "absolute", left: `${x - 3.6}%`, top: "4.4%", width: "7.2%", height: "7.2%", opacity: fade(markOn[i]!, mark(i)), transform: turn(markOn[i]!, mark(i)) }}
            />
          ))}
        </View>
      </If>
      <If when={is("failed")}>
        <View style={FILL}>
          <Image
            src={`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${SWEAT}" fill="${token("brand")}" fill-opacity="0.55"/></svg>`)}`}
            style={{ ...FILL, opacity: fade(markOn[0]!, mark(0)), transform: turn(markOn[0]!, mark(0)) }}
          />
        </View>
      </If>
      <If when={is("held")}>
        <View style={FILL}>
          {[20, 16, 13].map((size, i) => (
            <Text
              class="font-bold text-brand"
              style={{ position: "absolute", left: "74%", top: "4%", fontSize: size * 0.5, opacity: fade(markOn[i]!, mark(i)), transform: turn(markOn[i]!, mark(i)) }}
            >
              z
            </Text>
          ))}
        </View>
      </If>
    </View>
  );
}
