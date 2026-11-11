/**
 * A picture and its boxes (`ImageAnnotator.svelte`): in annotate mode a drag on the picture draws a
 * box (a press is a small one); while its remark is written the box can be moved and its corners
 * dragged, Escape drops it. The marks already made are numbered in order, in three looks by state
 * (accent solid for pending, dotted for a draft, grey for resolved), dashed when the picture has
 * changed since. Boxes are fractions of the picture, so they follow it however it is fitted.
 *
 * The picture is fitted by hand (at most its natural size, as wide as the area allows, top centre)
 * so the layer of boxes sits on exactly its pixels. NSH has no canvas read-back, so a finished box
 * hands the preview its anchor without the cropped picture (`crop` is never given).
 */
import { Image, keymap, PanResponder, signal, Text, View, effect, untracked, type PanResponderGestureState, type ViewRef } from "nsh";
import { validateAnchor, type Annotation, type ImageRegionAnchor } from "@real-bot/protocol";
import {
  anchorBox,
  anchorFromBox,
  finishNewBox,
  handleCorner,
  isCompactBox,
  regionMarks,
  resizeByGrab,
  resolveNaturalSize,
  thickenSliver,
  toNormFree,
  type RegionMark,
} from "../../m/annotations/image-region.ts";
import { boxBetween, isClick, moveBox, toNorm, type DrawnRect, type EncodedCrop, type Handle, type NormBox, type NormPoint, type Size } from "../../m/annotations/region-box.ts";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { tip } from "../tip";

/** Everything this surface says; the preview passes it in from `copy.ts`. */
export type ImageAnnotatorLabels = {
  /** Hover text on the image while annotate mode is on. */
  region: string;
  /** A drawn annotation for a screen reader: its number and its remark. */
  mark: (n: number, remark: string) => string;
  /** Hover text on the box that is waiting for its remark. */
  pending: string;
  /** Hover text on that box's corner handles. */
  resize: string;
  /** Added under the remark on a mark whose image has changed since. */
  stale: string;
};

/** What a finished pick hands the preview: the anchor, and (never here) how to cut its crop. */
export type ImageRegionDraft = { anchor: ImageRegionAnchor; crop?: () => Promise<EncodedCrop | null> };

const HANDLES: Handle[] = ["nw", "ne", "sw", "se"];
const COMPACT_HANDLES: Handle[] = ["se"];
const FLASH_MS = 1400;
const PEEK_SHOW_MS = 3000;

type Gesture =
  /**
   * `to` is where the finger last moved, on the layer: the box ends there. The release's own gesture
   * state is no place (its `moveX`, `moveY` are of the fingers still down, none, so 0).
   */
  | { kind: "new"; start: NormPoint; from: { x: number; y: number }; to: { x: number; y: number } }
  | { kind: "move"; box: NormBox }
  /** `grab` is the corner minus where the handle was pressed, so the corner does not jump. */
  | { kind: "resize"; handle: Handle; box: NormBox; grab: NormPoint };

const pct = (v: number) => `${(v * 100).toFixed(3)}%` as `${number}%`;
const boxStyle = (box: NormBox) => ({ position: "absolute" as const, left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) });

export function ImageAnnotator(props: {
  /** The image's URL (a `data:` URL). */
  src: string;
  alt: string;
  isSvg: boolean;
  /** The SVG's source, for its size when it declares none; optional. */
  svgText?: string | null;
  /** This file's image-region rows, in display order: drawn numbered 1..n. */
  annotations: Annotation[];
  /** Scroll to this one and flash it. */
  focusId: string | null;
  /** Bumped on every request to go to `focusId`, so the one already focused is revealed again. */
  focusSeq?: number;
  /** Annotate mode: a drag or a press on the image makes a box. */
  active: boolean;
  /** Whether a new box may be made at all; existing ones are drawn either way. */
  enabled: boolean;
  labels: ImageAnnotatorLabels;
  /** A box was chosen; the preview opens the composer. */
  onDraft: (draft: ImageRegionDraft) => void;
  /** A press on an existing mark. */
  onPick: (id: string) => void;
  /** The anchor awaiting its remark: drawn with handles, movable and resizable whatever `active` and `enabled` say. */
  pending?: ImageRegionAnchor | null;
  onPendingChange?: (anchor: ImageRegionAnchor) => void;
  /** Escape while choosing, or with a box pending. */
  onCancel?: () => void;
  /**
   * Outside annotate mode, and with no box waiting, a press on the picture enlarges it; left out,
   * the picture is only a picture. `from` is the picture's own view, for the enlargement to grow
   * out of (`imageOrigin`).
   */
  onOpen?: (from: ViewRef | null) => void;
  /** The enlarge button's name. */
  openLabel?: string;
  /**
   * The picture's size when the caller already knows it (a read of the file): boxes are laid out
   * from it until the picture reports its own. NSH's headless runner never loads pictures, so
   * tests give one.
   */
  naturalSize?: Size;
  testID?: string;
}) {
  /** The area the picture is fitted in. */
  const room = signal<Size>({ width: 0, height: 0 });
  /** The picture's own size, once it has loaded (an SVG's by its own rules). */
  const measured = signal<Size | null>(null);
  /** Its size: what the picture reported, else what the caller knew before it loaded. */
  const natural = (): Size | null => measured() ?? props.naturalSize ?? null;
  const liveBox = signal<NormBox | null>(null);
  /** The pending box as this component last drew it, until the `pending` prop catches up. */
  const localPending = signal<NormBox | null>(null);
  const dragging = signal(false);
  /** Whether the pending box had one handle when the gesture began: kept until it ends. */
  const compactAtStart = signal(false);
  const flashId = signal<string | null>(null);
  const peekId = signal<string | null>(null);

  let gesture: Gesture | null = null;
  /** Where the layer's top left is on the surface, so a finger's page position is a place on the picture. */
  let origin = { x: 0, y: 0 };
  let layerRef: ViewRef | null = null;
  let pictureRef: ViewRef | null = null;
  let seenPending: ImageRegionAnchor | null | undefined = undefined;
  let seenSrc: string | undefined = undefined;
  let peekHide: ReturnType<typeof setTimeout> | null = null;

  /** At most its natural size, as large as the room allows, against the top, centred. */
  const drawn = (): DrawnRect | null => {
    const n = natural();
    const r = room();
    if (!n || r.width <= 0 || r.height <= 0) return null;
    const k = Math.min(1, r.width / n.width, r.height / n.height);
    const width = n.width * k;
    return { left: (r.width - width) / 2, top: 0, width, height: n.height * k };
  };
  /** The layer's own coordinates: its top left is 0, 0. */
  const local = (): DrawnRect => {
    const d = drawn();
    return { left: 0, top: 0, width: d?.width ?? 0, height: d?.height ?? 0 };
  };
  const marks = () => regionMarks(props.annotations);
  const pendingBox = () => localPending() ?? (props.pending ? anchorBox(props.pending) : null);
  const pendingNatural = (): Size | null => (props.pending ? { width: props.pending.natural_width, height: props.pending.natural_height } : natural());
  const creating = () => props.active && props.enabled && !pendingBox() && natural() !== null;
  const compactNow = () => {
    const box = pendingBox();
    const d = drawn();
    return box !== null && d !== null && isCompactBox(box, d);
  };
  // A handle that vanished mid-drag would lose its finger, so the layout holds until release.
  const compact = () => (dragging() ? compactAtStart() : compactNow());
  const openable = () => Boolean(props.onOpen) && !props.active && !pendingBox() && !dragging();
  const engaged = () => (props.active && props.enabled) || pendingBox() !== null || dragging();
  const markTitle = (mark: RegionMark) => (mark.stale ? `${mark.body}\n${props.labels.stale}` : mark.body);

  function measure(): void {
    void layerRef?.measure().then((m) => {
      if (m) origin = { x: m.pagePosition.x, y: m.pagePosition.y };
    });
  }

  const at = (g: PanResponderGestureState) => ({ x: g.moveX - origin.x, y: g.moveY - origin.y });

  function finish(): Gesture | null {
    const g = gesture;
    gesture = null;
    dragging.set(false);
    liveBox.set(null);
    return g;
  }

  /** Drop a gesture half-way: a new box vanishes, a moved one goes back. */
  function abort(): void {
    const g = finish();
    if (g && g.kind !== "new") localPending.set(g.box);
  }

  function begin(next: Gesture): void {
    gesture = next;
    compactAtStart.set(compactNow());
    dragging.set(true);
    peekId.set(null);
  }

  function propose(box: NormBox): void {
    const size = natural();
    if (!size) return;
    const anchor = anchorFromBox(box, size);
    if (!validateAnchor("image_region", anchor).ok) return;
    localPending.set(anchorBox(anchor));
    props.onDraft({ anchor });
  }

  function move(g: PanResponderGestureState): void {
    const gs = gesture;
    const d = local();
    if (!gs || d.width <= 0) return;
    if (gs.kind === "new") {
      const to = at(g);
      gs.to = to;
      if (!liveBox() && isClick(gs.from, to)) return;
      liveBox.set(boxBetween(gs.start, toNorm(to.x, to.y, d)));
    } else if (gs.kind === "move") {
      localPending.set(moveBox(gs.box, g.dx / d.width, g.dy / d.height));
    } else {
      const to = at(g);
      localPending.set(resizeByGrab(gs.box, gs.handle, toNormFree(to.x, to.y, d), gs.grab));
    }
  }

  function release(): void {
    const gs = gesture;
    if (!gs) return;
    const moved = localPending();
    finish();
    const d = local();
    if (gs.kind === "new") {
      const size = natural();
      if (d.width <= 0 || !size) return;
      const to = gs.to;
      propose(finishNewBox({ client: gs.from, norm: gs.start }, { client: to, norm: toNorm(to.x, to.y, d) }, size));
      return;
    }
    const size = pendingNatural();
    if (!size || !moved) return;
    const box = thickenSliver(moved, size);
    localPending.set(box);
    // Compared as stored: a press that did not move can still differ by float noise, (x + w) - x.
    const anchor = anchorFromBox(box, size);
    const before = anchorFromBox(gs.box, size);
    if (anchor.x === before.x && anchor.y === before.y && anchor.w === before.w && anchor.h === before.h) return;
    props.onPendingChange?.(anchor);
  }

  const layerPan = PanResponder.create({
    onStartShouldSetPanResponder: () => creating() && gesture === null,
    onPanResponderGrant: (e, g) => {
      // The finger went down on the layer itself: its own position on the surface follows.
      origin = { x: e.pageX - e.locationX, y: e.pageY - e.locationY };
      const from = { x: g.x0 - origin.x, y: g.y0 - origin.y };
      const d = local();
      begin({ kind: "new", from, to: from, start: toNorm(from.x, from.y, d) });
    },
    onPanResponderMove: (_e, g) => move(g),
    onPanResponderRelease: () => release(),
    onPanResponderTerminate: () => abort(),
    onPanResponderTerminationRequest: () => false,
  });

  // The box waiting for its remark stays movable and resizable for as long as it is drawn, even
  // when the preview has switched annotate mode or new picks off while the composer is open.
  const movePan = PanResponder.create({
    onStartShouldSetPanResponder: () => pendingBox() !== null && gesture === null,
    onPanResponderGrant: () => {
      const box = pendingBox();
      if (box) begin({ kind: "move", box });
    },
    onPanResponderMove: (_e, g) => move(g),
    onPanResponderRelease: () => release(),
    onPanResponderTerminate: () => abort(),
    onPanResponderTerminationRequest: () => false,
  });

  const handlePan = (handle: Handle) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => pendingBox() !== null && gesture === null,
      onPanResponderGrant: (_e, g) => {
        const box = pendingBox();
        if (!box) return;
        const pointer = at(g);
        const point = toNormFree(pointer.x, pointer.y, local());
        const corner = handleCorner(box, handle);
        begin({ kind: "resize", handle, box, grab: { x: corner.x - point.x, y: corner.y - point.y } });
      },
      onPanResponderMove: (_e, g) => move(g),
      onPanResponderRelease: () => release(),
      onPanResponderTerminate: () => abort(),
      onPanResponderTerminationRequest: () => false,
    });
  const handlePans = Object.fromEntries(HANDLES.map((h) => [h, handlePan(h)])) as Record<Handle, ReturnType<typeof handlePan>>;

  function onMarkPress(id: string): void {
    peekId.set(null);
    props.onPick(id);
  }

  function peek(id: string): void {
    // A long press shows the remark, as hovering does for a mouse.
    peekId.set(id);
    if (peekHide) clearTimeout(peekHide);
    peekHide = setTimeout(() => {
      if (peekId() === id) peekId.set(null);
    }, PEEK_SHOW_MS);
  }

  /* ------------------------------------------------------------ effects */

  // A new image: whatever was measured or half-drawn belonged to the old one.
  effect(() => {
    const next = props.src;
    untracked(() => {
      if (seenSrc !== undefined && next !== seenSrc) {
        if (gesture) finish();
        measured.set(null);
        localPending.set(null);
      }
      seenSrc = next;
    });
  });

  // The preview took over the pending box (or dropped it): draw its copy from now on.
  effect(() => {
    const next = props.pending ?? null;
    untracked(() => {
      if (next === seenPending) return;
      seenPending = next;
      if (gesture && gesture.kind !== "new") finish();
      localPending.set(null);
    });
  });

  // Leaving annotate mode, or picks turned off, drops a box being dragged out and the local copy of
  // a pending one. A move or resize already under the finger is left to finish.
  effect(() => {
    const on = props.active;
    const allowed = props.enabled;
    untracked(() => {
      if (on && allowed) return;
      if (gesture?.kind === "new") finish();
      if (!gesture) localPending.set(null);
    });
  });

  // Held until the picture is shown: a flash on a box still hidden is never seen.
  effect(() => {
    const id = props.focusId;
    void props.focusSeq;
    if (!id || drawn() === null) return;
    untracked(() => flashId.set(id));
    const timer = setTimeout(() => {
      if (flashId() === id) flashId.set(null);
    }, FLASH_MS);
    return () => {
      clearTimeout(timer);
      untracked(() => {
        if (flashId() === id) flashId.set(null);
      });
    };
  });

  // Escape cancels the pick before the pane gets it.
  keymap.bind(
    "escape",
    () => {
      if (!engaged()) return;
      // A box still being dragged out, with nothing pending, is only dropped: one Escape is one
      // step back, and leaving annotate mode is the next one.
      if (gesture?.kind === "new" && !props.pending) {
        finish();
        localPending.set(null);
        return;
      }
      const hadLocal = gesture !== null || localPending() !== null;
      if (gesture) finish();
      localPending.set(null);
      if (!props.onCancel && !hadLocal) return;
      props.onCancel?.();
    },
    { when: "always" },
  );

  const handle = narrowWindow() ? 40 : 16;

  return (
    <View
      testID={props.testID ?? "image-annotator"}
      class="flex-1 min-h-0 min-w-0"
      onLayout={(e) => {
        room.set({ width: e.bounds.size.width, height: e.bounds.size.height });
        measure();
      }}
    >
      <View
        role={props.onOpen ? "button" : undefined}
        testID="image-annotator-picture"
        ref={(node: ViewRef) => (pictureRef = node)}
        accessibilityLabel={props.openLabel}
        onPress={() => {
          if (openable()) props.onOpen?.(pictureRef);
        }}
        class={openable() ? "absolute cursor-zoom-in" : "absolute"}
        style={drawn() ? { left: drawn()!.left, top: 0, width: drawn()!.width, height: drawn()!.height } : { left: 0, top: 0, width: "100%", height: "100%" }}
      >
        <Image
          src={props.src}
          accessibilityLabel={props.alt}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
          onLoad={(e) =>
            measured.set(
              resolveNaturalSize(
                { naturalWidth: e.size.width, naturalHeight: e.size.height },
                { svg: props.isSvg, svgText: props.svgText ?? null, drawn: { width: e.size.width, height: e.size.height } },
              ),
            )
          }
        />
      </View>
      <If when={drawn()}>
        {(d: () => DrawnRect) => (
          <View
            testID="image-annotator-layer"
            ref={(node: ViewRef) => {
              layerRef = node;
              measure();
            }}
            tooltip={creating() ? tip(props.labels.region) : undefined}
            onLayout={() => measure()}
            {...layerPan.panHandlers}
            class="absolute"
            // Over the picture: outside annotate mode a press goes through to it (it enlarges), and
            // only the marks and the pending box, its children, take presses of their own.
            style={{
              left: d().left,
              top: d().top,
              width: d().width,
              height: d().height,
              pointerEvents: creating() ? "auto" : "box-none",
              cursor: creating() ? "crosshair" : undefined,
            }}
          >
            <Each of={marks()} key={(mark: RegionMark) => mark.id}>
              {(mark: () => RegionMark) => (
                <View
                  role="button"
                  testID={`image-mark-${mark().id}`}
                  accessibilityLabel={props.labels.mark(mark().n, mark().body)}
                  tooltip={tip(markTitle(mark()))}
                  onPress={() => onMarkPress(mark().id)}
                  onLongPress={() => peek(mark().id)}
                  // While annotating the boxes let a drag through; their numbers still open them.
                  style={{ ...boxStyle(mark().box), pointerEvents: creating() ? "none" : "auto", boxShadow: flashId() === mark().id ? "0 0 0 6px rgba(0,128,128,0.35)" : undefined }}
                  class={`cursor-pointer select-none border-2 rounded-[2px] ${
                    mark().status === "resolved" ? "border-ink-muted/75 bg-ink-muted/10" : mark().status === "draft" ? "border-brand bg-brand/8" : "border-brand bg-brand/14"
                  } ${mark().status === "draft" ? "border-dotted" : mark().stale ? "border-dashed" : ""}`}
                >
                  <View
                    testID={`image-mark-number-${mark().id}`}
                    role="button"
                    onPress={() => onMarkPress(mark().id)}
                    style={{ position: "absolute", left: -9, top: -9, pointerEvents: "auto", boxShadow: shadow("md") }}
                    class={`cursor-pointer select-none min-w-[18px] h-[18px] px-1 rounded-full items-center justify-center border ${
                      mark().status === "draft" ? "bg-pane border-dotted border-brand" : mark().stale ? "border-dashed border-pane" : "border-transparent"
                    } ${mark().status === "resolved" ? "bg-ink-muted" : mark().status === "draft" ? "" : "bg-brand"}`}
                  >
                    <Text class={`font-mono text-[11px] font-semibold ${mark().status === "draft" ? "text-brand" : "text-pane"}`}>{String(mark().n)}</Text>
                  </View>
                  <If when={peekId() === mark().id}>
                    <View
                      testID="image-mark-peek"
                      style={{ position: "absolute", left: 0, top: "100%", marginTop: 6, maxWidth: 260, boxShadow: shadow("md") }}
                      class="px-2 py-[6px] border border-line rounded-(--radius-sm) bg-pane"
                    >
                      <Text class="text-[12px] leading-[1.4] text-ink">{markTitle(mark())}</Text>
                    </View>
                  </If>
                </View>
              )}
            </Each>
            <If when={liveBox()}>
              {(box: () => NormBox) => <View testID="image-live-box" accessible={false} style={boxStyle(box())} class="border-2 border-dashed border-brand bg-brand/12" />}
            </If>
            <If when={pendingBox()}>
              {(box: () => NormBox) => (
                <View
                  testID="image-pending-box"
                  tooltip={tip(props.labels.pending)}
                  {...movePan.panHandlers}
                  style={{ ...boxStyle(box()), boxShadow: shadow("md") }}
                  class="border-2 border-brand rounded-[2px] bg-brand/18"
                >
                  <Each of={compact() ? COMPACT_HANDLES : HANDLES} key={(h: Handle) => h}>
                    {(h: () => Handle) => (
                      <View
                        testID={`image-handle-${h()}`}
                        tooltip={tip(props.labels.resize)}
                        {...handlePans[h()].panHandlers}
                        class="absolute items-center justify-center"
                        style={{
                          width: handle,
                          height: handle,
                          left: h() === "nw" || h() === "sw" ? -handle / 2 : undefined,
                          right: h() === "ne" || h() === "se" ? -handle / 2 : undefined,
                          top: h() === "nw" || h() === "ne" ? -handle / 2 : undefined,
                          bottom: h() === "sw" || h() === "se" ? -handle / 2 : undefined,
                        }}
                      >
                        <View accessible={false} class="w-[10px] h-[10px] border-2 border-brand rounded-[2px] bg-pane" />
                      </View>
                    )}
                  </Each>
                </View>
              )}
            </If>
          </View>
        )}
      </If>
    </View>
  );
}
