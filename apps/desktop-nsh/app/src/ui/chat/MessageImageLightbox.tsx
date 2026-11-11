/**
 * A picture enlarged over the whole app (`MessageImageLightbox.svelte`). It grows out of the
 * thumbnail it was opened from (`origin`), shows what it has while the real bytes come (the
 * opener's copy, the thumbnail, the Mac's 256 px copy), fits the picture to the window once its
 * shape is known, and shrinks back on close.
 *
 * Zoom is the messenger's own maths (`src/m/chat/image-zoom.ts`): the frame keeps the box it was
 * fitted to and is scaled and moved with a transform. Fingers (PanResponder) pinch and drag it;
 * a tap (or a click on the picture, whose cursor is the magnifier's minus) brings a zoomed picture
 * back and the next closes. Where there are no fingers (a desktop)
 * `+` / `-` / `0` zoom about the middle, and the wheel (`src/platform/wheel`) zooms about the
 * pointer: the Svelte one has no desktop zoom at all. A trackpad pinch (ctrl + wheel) zooms the
 * same way; two fingers sliding on a trackpad pan a zoomed picture. Escape, the phone's Back and a
 * tap close it.
 *
 * Bytes come through the runtime client and are shown as `data:` URLs (`blobDataUrl`): NSH has no
 * object URLs for them, so nothing is revoked. A right click (long press) on the picture offers
 * Copy image (`ImageContextMenu`).
 *
 * Motion: NSH's `transition-*` animates colours, opacity, transforms, shadows and corners, never a
 * view's place or size, so the frame's moves (growing out of the thumbnail, fitting the picture once
 * its shape is known, shrinking back) are a native layout animation (`LayoutAnimation.configureNext`)
 * of the commit that moves it. Every opener hands over the thumbnail it was pressed on (the picture
 * inside a chip, not the chip; a Markdown chip's too) and what it shows (`placeholder`), so the frame
 * grows at once at the picture's proportions, as the Svelte's does. With nothing to grow from (a
 * thumbnail that was never drawn) the frame fades in and out from a little smaller; the Svelte's
 * simply appears there.
 */
import { cleanup, effect, Image, keymap, LayoutAnimation, Overlay, PanResponder, signal, Text, untracked, View, windowSize, computed, type ViewRef } from "nsh";
import { reduceMotion } from "../interface/motion";
import type { ShellWheel } from "../../platform/wheel";
import type { Attachment } from "@real-bot/protocol";
import { originalSizeForBlob } from "../../m/api.ts";
import { formatFileSize } from "../../m/chat/attachments.ts";
import { holdBack } from "../../m/chat/enlarged-images.ts";
import { panBy, restView, settleView, zoomAround, zoomLimit, type PictureView, type Point } from "../../m/chat/image-zoom.ts";
import { fileProgressPercent, formatFileProgress, type FileLoadOptions, type FileProgress } from "../../m/file-progress.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { artifactKind, svgDisplayBlob } from "../../m/overlays/artifacts.ts";
import { saveFile } from "../../m/save-file.ts";
import { copy } from "../../runtime";
import { onWheel, openWheelLayer } from "../../platform/wheel";
import { Icon } from "../Icon";
import { ImageContextMenu } from "../ImageContextMenu";
import { blobDataUrl } from "../data-url";
import { fitPicture, OFFER_RESERVE, placeholderBox, roomForCopy, wheelView, type ImageOrigin } from "./lightbox-fit";

export type { ImageOrigin };

/** How long the frame takes to grow and to shrink back, in milliseconds. */
const GROW_MS = 220;
/** How small a frame with no thumbnail to grow from is as it fades in and out. */
const FADE_SCALE = 0.96;

const sameBox = (a: ImageOrigin, b: ImageOrigin) => a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

export function MessageImageLightbox(props: {
  /** When set, bytes come from this attachment (or a workspace GET for a handoff chip). */
  attachment?: Attachment | null;
  /** Body image with no attachment row. Loaded with a workspace GET. */
  relpath?: string | null;
  /** A picture the opener already has on screen, as a URL it keeps owning. Nothing is fetched. */
  src?: string | null;
  /** When `src` is the Mac's scaled copy, the original's length: the enlargement offers it. */
  srcOriginalSize?: number | null;
  /** A smaller copy of the same picture (the chip's thumbnail): on screen at once, with the picture's proportions. */
  placeholder?: string | null;
  /** Where the inline picture sits (window coordinates), so the enlargement can grow out of it. */
  origin?: ImageOrigin | null;
  /** The name for a picture neither an attachment nor a path names: a file staged in the composer. */
  label?: string | null;
  api: MessengerApi | null;
  onClose: () => void;
}) {
  const t = () => copy();
  const name = () =>
    props.label ||
    props.attachment?.original_filename ||
    props.relpath?.split("/").pop() ||
    props.attachment?.workspace_relpath ||
    props.relpath ||
    "";
  const path = () => props.attachment?.workspace_relpath || props.relpath || "";

  /** Fetched here: the original, once asked for, over a copy the opener handed over. */
  const url = signal<string | null>(null);
  const shown = () => url() ?? props.src ?? null;
  /** The Mac's 256 px copy, fetched here when the opener had nothing to stand in for the picture. */
  const standIn = signal<string | null>(null);
  const displayed = () => shown() ?? props.placeholder ?? standIn();
  const standingIn = () => !shown() && Boolean(displayed());
  /** The original's length while a smaller copy is what is on screen. */
  const reducedFrom = signal<number | null>(null);
  const offerOriginal = (): number | null => (url() ? reducedFrom() : props.src ? (props.srcOriginalSize ?? null) : null);
  const originalProgress = signal<FileProgress | null>(null);
  const originalBytes = () => (originalProgress() ? formatFileProgress(originalProgress()!, formatFileSize) : null);
  /** The picture's own bytes once they are in this page: what a save hands over. */
  let original: Blob | null = null;
  let originalLoad: Promise<Blob | null> | null = null;
  /** Remotely the picture is otherwise only on the Mac; the page saves the original from here. */
  const canSave = () => props.api?.kind === "remote" && Boolean(props.attachment || props.relpath);
  const saving = signal(false);
  /** Under the picture after a save: the share sheet wants one more tap, or the original never came. */
  const saveNote = signal<"tap" | "failed" | null>(null);
  let loadAbort: AbortController | null = null;
  const failed = signal(false);
  const loading = signal(true);
  /** Room for the offer, kept from the start on a remote host so the picture moves once. */
  const reserveOffer = () => offerOriginal() !== null || (props.api?.kind === "remote" && !props.src && loading());
  const progress = signal<FileProgress | null>(null);
  let request = 0;
  let loadedKey = "";

  const natural = signal<{ width: number; height: number } | null>(null);
  const grown = signal(false);
  const phase = signal<"open" | "back">("open");
  const instant = () => reduceMotion();
  let closing = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const menuAt = signal<Point | null>(null);

  const loadPercent = () => (progress() ? fileProgressPercent(progress()!) : null);
  const loadBytes = () => (progress() ? formatFileProgress(progress()!, formatFileSize) : null);

  const stage = (): ImageOrigin => ({ top: 0, left: 0, width: windowSize().width || 800, height: windowSize().height || 600 });

  /** Where the picture rests: fitted once its shape is known; a centred box when nothing is coming to wait for. */
  const settled = computed((): ImageOrigin | null => {
    const shape = natural();
    if (displayed() && shape && shape.width > 0 && shape.height > 0) return fitPicture(stage(), shape, reserveOffer() ? OFFER_RESERVE : 0);
    if (grown() && (!props.origin || failed() || !displayed())) {
      // Nothing to grow to yet: with an origin and a load in flight the frame waits there.
      if (props.origin && !failed() && loading()) return null;
      return placeholderBox(stage());
    }
    return null;
  });
  const waitingInPlace = () => grown() && phase() !== "back" && loading() && !displayed() && Boolean(props.origin) && !failed();

  /** The frame's box: the thumbnail's before it grows and as it shrinks back; with none, where it rests (it fades instead). */
  const frameBox = computed((): ImageOrigin => {
    const rest = settled() ?? placeholderBox(stage());
    if (phase() === "back") return props.origin ?? rest;
    if (!grown() || !settled()) return props.origin ?? rest;
    return rest;
  });
  /** No thumbnail to grow from: the frame fades in and out instead. */
  const fades = () => !props.origin && !instant();
  const faded = () => fades() && (!grown() || phase() === "back");

  /** Pinched on a phone (see image-zoom.ts). Null at rest. */
  const zoom = signal<PictureView | null>(null);
  const pinching = signal(false);
  const zoomed = () => zoom() !== null && zoom()!.scale > 1;
  /** The frame's transform: the zoom, or (fading) a little smaller about its middle; always three steps, so one eases into the next. */
  const frameSteps = () => {
    const box = frameBox();
    if (faded()) {
      const shrink = 1 - FADE_SCALE;
      return [{ translateX: (box.width * shrink) / 2 }, { translateY: (box.height * shrink) / 2 }, { scale: FADE_SCALE }];
    }
    const rest = settled();
    const view = zoom();
    if (!view || !rest || !grown() || phase() !== "open" || !displayed()) return [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }];
    const now = settleView(stage(), rest, view);
    return [{ translateX: now.x - rest.left }, { translateY: now.y - rest.top }, { scale: now.scale }];
  };

  // The frame's moves are a native layout animation of the commit that makes them (NSH's
  // transitions move no layout). A resized window and a pinch move it at once.
  let lastBox: ImageOrigin | null = null;
  let lastStage = "";
  effect(() => {
    const box = frameBox();
    const now = stage();
    const stageKey = `${now.width}x${now.height}`;
    untracked(() => {
      if (lastBox && !sameBox(lastBox, box) && stageKey === lastStage && !instant() && !pinching()) {
        LayoutAnimation.configureNext({ duration: GROW_MS, update: { type: "easeInEaseOut" } });
      }
      lastBox = box;
      lastStage = stageKey;
    });
  });

  function fetchPicture(
    client: MessengerApi,
    file: Attachment | null,
    workspacePath: string | null,
    onProgress: ((next: FileProgress) => void) | undefined,
    options: FileLoadOptions,
  ): Promise<Blob> {
    if (!file) return client.getWorkspaceFileBlob(workspacePath!, onProgress, options);
    return file.id.startsWith("handoff:")
      ? client.getWorkspaceFileBlob(file.workspace_relpath, onProgress, options)
      : client.getAttachmentBlob(file.id, onProgress, options);
  }

  async function load(client: MessengerApi, file: Attachment | null, workspacePath: string | null): Promise<void> {
    const mine = ++request;
    const kindName = file?.original_filename || workspacePath?.split("/").pop() || file?.workspace_relpath || workspacePath || "";
    url.set(null);
    standIn.set(null);
    reducedFrom.set(null);
    originalProgress.set(null);
    original = null;
    originalLoad = null;
    saveNote.set(null);
    failed.set(false);
    loading.set(true);
    natural.set(null);
    loadAbort?.abort();
    const abort = new AbortController();
    loadAbort = abort;
    // Remotely the enlargement starts from the Mac's copy; a local read is free, so it is the original.
    const remote = client.kind === "remote";
    const size = remote ? ("preview" as const) : undefined;
    // The attachment's size is the original's, which is not what a copy will weigh.
    const knownTotal = !size && typeof file?.size === "number" && file.size > 0 ? file.size : null;
    progress.set({ loaded: 0, total: knownTotal });
    if (!file && !workspacePath) {
      failed.set(true);
      loading.set(false);
      return;
    }
    try {
      // With nothing on hand to stand in for it, a remote picture's 256 px copy comes first: it says
      // what shape to grow to, and stays on screen while the larger copy arrives.
      if (remote && !props.placeholder && artifactKind(kindName) === "image") {
        const small = await fetchPicture(client, file, workspacePath, undefined, { size: "thumb", signal: abort.signal });
        if (mine !== request) return;
        if (originalSizeForBlob(small) === null) {
          const asUrl = await blobDataUrl(small);
          if (mine !== request) return;
          url.set(asUrl);
          original = small;
          return;
        }
        const asUrl = await blobDataUrl(small);
        if (mine !== request) return;
        standIn.set(asUrl);
      }
      const onProgress = (next: FileProgress) => {
        if (mine !== request) return;
        progress.set({ loaded: next.loaded, total: next.total ?? knownTotal });
      };
      const source = await fetchPicture(client, file, workspacePath, onProgress, { size, signal: abort.signal });
      if (mine !== request) return;
      const display = artifactKind(kindName) === "svg" ? await svgDisplayBlob(source) : source;
      const asUrl = await blobDataUrl(display);
      if (mine !== request) return;
      url.set(asUrl);
      reducedFrom.set(originalSizeForBlob(source));
      // Not a copy: the file itself, an SVG's too (what is on screen is a cleaned copy of it).
      if (reducedFrom() === null) original = source;
    } catch {
      if (mine !== request) return;
      failed.set(true);
    } finally {
      if (mine === request) loading.set(false);
    }
  }

  /** The picture itself: on hand, already on its way, or fetched now. Null when there is nothing to ask for. */
  function fetchOriginal(): Promise<Blob | null> {
    if (original) return Promise.resolve(original);
    if (originalLoad) return originalLoad;
    const client = props.api;
    const total = offerOriginal();
    const file = props.attachment ?? null;
    const workspacePath = props.relpath ?? null;
    const handedOver = !url() && props.src && (props.srcOriginalSize ?? null) === null && artifactKind(name()) !== "svg" ? props.src : null;
    if (!handedOver && (!client || (!file && !workspacePath))) return Promise.resolve(null);
    const mine = request;
    let arriving: Promise<Blob>;
    if (handedOver) {
      arriving = fetch(handedOver).then((response) => response.blob());
    } else {
      loadAbort?.abort();
      const abort = new AbortController();
      loadAbort = abort;
      originalProgress.set({ loaded: 0, total });
      const onProgress = (next: FileProgress) => {
        if (mine !== request) return;
        originalProgress.set({ loaded: next.loaded, total: next.total ?? total });
      };
      arriving = fetchPicture(client!, file, workspacePath, onProgress, { signal: abort.signal });
    }
    const loadOne = arriving
      .then(async (source) => {
        if (mine !== request) return null;
        original = source;
        if (total !== null) {
          const asUrl = await blobDataUrl(source);
          if (mine !== request) return null;
          url.set(asUrl);
          reducedFrom.set(null);
        }
        return source;
      })
      .finally(() => {
        if (mine !== request) return;
        originalProgress.set(null);
        originalLoad = null;
      });
    originalLoad = loadOne;
    return loadOne;
  }

  /** The offer: the original in place of the copy. Failing, the copy stays on screen, and so does the offer. */
  function loadOriginal(): void {
    if (offerOriginal() === null || originalProgress()) return;
    fetchOriginal().catch(() => {});
  }

  /** Save the original (on a phone, the share sheet whose Save Image puts it in Photos). */
  async function save(): Promise<void> {
    if (saving()) return;
    const mine = request;
    saving.set(true);
    saveNote.set(null);
    try {
      const blob = original ?? (await fetchOriginal());
      if (mine !== request) return;
      if (!blob) {
        saveNote.set("failed");
        return;
      }
      const outcome = await saveFile(blob, name() || path().split("/").pop() || "image");
      if (mine === request && outcome === "needs-tap") saveNote.set("tap");
    } catch {
      if (mine === request) saveNote.set("failed");
    } finally {
      if (mine === request) saving.set(false);
    }
  }

  effect(() => {
    if (props.src) return;
    const client = props.api;
    const file = props.attachment ?? null;
    const workspacePath = props.relpath ?? null;
    const key = `${file?.id ?? ""}|${workspacePath ?? ""}|${client ? "1" : "0"}`;
    if (!client || key === loadedKey) return;
    loadedKey = key;
    untracked(() => void load(client, file, workspacePath));
  });

  // The phone's Back closes this, the way ✕ does, instead of leaving the page under it.
  cleanup(holdBack(requestClose));
  if (instant()) {
    grown.set(true);
  } else {
    // Let the first frame paint at the thumbnail's rectangle (or faded out), then grow (fade in).
    setTimeout(() => grown.set(true), 32);
  }
  cleanup(() => {
    request += 1;
    loadAbort?.abort();
    clearTimeout(closeTimer);
  });

  function requestClose(): void {
    if (closing) return;
    closing = true;
    // Back to the fitted box first: the frame shrinks into the thumbnail (or fades) unscaled.
    zoom.set(null);
    if (instant() || !grown()) {
      props.onClose();
      return;
    }
    phase.set("back");
    closeTimer = setTimeout(() => props.onClose(), GROW_MS + 40);
  }

  // Desktop keys: zoom about the middle (the pinch's maths), `0` back to the fit.
  function step(factor: number): void {
    const rest = settled();
    if (!rest || phase() !== "open" || !displayed()) return;
    const now = stage();
    const from = zoom() ? settleView(now, rest, zoom()!) : restView(rest);
    const next = zoomAround(now, rest, from, { x: now.width / 2, y: now.height / 2 }, from.scale * factor, zoomLimit(rest, natural()?.width ?? 0, 1));
    zoom.set(next.scale < 1.05 ? null : next);
  }
  const keys: Record<string, () => void> = {
    plus: () => step(1.5),
    "+": () => step(1.5),
    "=": () => step(1.5),
    minus: () => step(1 / 1.5),
    "-": () => step(1 / 1.5),
    "0": () => zoom.set(null),
  };
  for (const [key, run] of Object.entries(keys)) {
    try {
      keymap.bind(key, run, { when: "notEditing", repeat: true });
    } catch {
      // A keystroke this platform keeps is not bound.
    }
  }

  /**
   * Touch points, in the window. Anywhere on the screen, not only on the picture: a wide one fills
   * a strip, and a pinch with a finger beside it should still zoom.
   */
  let fingers: Point[] = [];
  let gesture: { from: PictureView; mid: Point; distance: number; at: Point } | null = null;
  /** A pinch or a drag ends with a press the platform still sends: it neither closes nor resets. */
  let swallowPressUntil = 0;
  let travelled = 0;

  const mid = (a: Point, b?: Point): Point => (b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a);

  function startGesture(): void {
    const rest = settled();
    if (!rest || fingers.length === 0) {
      gesture = null;
      return;
    }
    const [a, b] = fingers as [Point, Point | undefined];
    const from = zoom() ? settleView(stage(), rest, zoom()!) : restView(rest);
    gesture = { from, mid: mid(a, b), distance: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0, at: mid(a, b) };
  }

  const points = (touches: ReadonlyArray<{ pageX: number; pageY: number }>): Point[] => touches.map((touch) => ({ x: touch.pageX, y: touch.pageY }));

  function move(): void {
    const rest = settled();
    if (!gesture || !rest) return;
    const now = stage();
    if (fingers.length >= 2) {
      const [a, b] = fingers as [Point, Point];
      const centre = mid(a, b);
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const scale = gesture.distance > 0 ? (gesture.from.scale * distance) / gesture.distance : gesture.from.scale;
      const limit = zoomLimit(rest, natural()?.width ?? 0, 1);
      const around = zoomAround(now, rest, gesture.from, gesture.mid, scale, limit);
      zoom.set(panBy(now, rest, around, { x: centre.x - gesture.mid.x, y: centre.y - gesture.mid.y }));
      return;
    }
    const at = fingers[0]!;
    travelled = Math.max(travelled, Math.hypot(at.x - gesture.at.x, at.y - gesture.at.y));
    // One finger moves the picture only once it is larger than its box.
    if (!zoomed()) return;
    zoom.set(panBy(now, rest, gesture.from, { x: at.x - gesture.at.x, y: at.y - gesture.at.y }));
  }

  const ready = () => phase() === "open" && grown() && Boolean(displayed()) && Boolean(settled());
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => ready(),
    onMoveShouldSetPanResponder: () => ready(),
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      travelled = 0;
      fingers = points(e.touches);
      if (fingers.length > 1) travelled = Infinity;
      pinching.set(true);
      startGesture();
    },
    onPanResponderStart: (e) => {
      // A finger came down or went up: the gesture goes on from what is on screen.
      fingers = points(e.touches);
      if (fingers.length > 1) travelled = Infinity;
      startGesture();
    },
    onPanResponderMove: (e) => {
      fingers = points(e.touches);
      move();
    },
    onPanResponderEnd: (e) => {
      fingers = points(e.touches);
      if (fingers.length > 0) startGesture();
    },
    onPanResponderRelease: finish,
    onPanResponderTerminate: finish,
  });

  function finish(): void {
    if (travelled > 8) swallowPressUntil = Date.now() + 500;
    fingers = [];
    gesture = null;
    pinching.set(false);
    // Let go at about the fitted size: back to rest, not a hair larger.
    if (zoom() && zoom()!.scale < 1.05) zoom.set(null);
  }

  /**
   * The wheel: ⌘/Ctrl + wheel and a pinch zoom about the pointer (a pinch's `dy` is its zoom step,
   * 100 per e-fold), a mouse wheel zooms too, and two fingers sliding on a trackpad pan a zoomed picture.
   */
  function wheelOver(e: ShellWheel, at: Point): void {
    const rest = settled();
    if (!rest || !ready()) return;
    const next = wheelView(stage(), rest, zoom(), e, at, natural()?.width ?? 0);
    if (next) zoom.set(next.view);
  }
  let stageRef: ViewRef | null = null;
  // Over the whole window: while it is open the wheel zooms the picture and reaches nothing under it.
  onWheel(() => stageRef, (e) => wheelOver(e, { x: e.x, y: e.y }), openWheelLayer());

  /** A tap anywhere but the buttons: zoomed in it goes back to the whole picture; the next one closes. */
  function tap(): void {
    if (Date.now() < swallowPressUntil) return;
    if (zoomed()) {
      zoom.set(null);
      return;
    }
    requestClose();
  }

  const shownClass = () => (grown() && phase() !== "back" ? "opacity-100" : "opacity-0");
  const chrome = () => `transition-opacity duration-[180ms] ${shownClass()}`;
  const hot = () => grown() && phase() !== "back";

  return (
    <Overlay onCancel={requestClose} style={{ width: windowSize().width, height: windowSize().height }}>
      <View
        testID="msg-image-lightbox"
        class={`flex-1 transition-colors duration-[220ms] ${hot() ? "bg-bg/90" : "bg-transparent"}`}
      >
        <View testID="msg-image-stage" ref={(node: ViewRef) => (stageRef = node)} class="absolute inset-0" onPress={() => tap()} {...pan.panHandlers}>
          {/* The frame grows out of the clicked picture. The dialog role stays on the picture's box. */}
          <View
            role="group"
            testID="msg-image-frame"
            accessibilityLabel={name() || path()}
            class={`absolute overflow-hidden bg-pane ${pinching() ? "" : "transition-all duration-[220ms]"} ${hot() ? "rounded-(--radius-lg)" : "rounded-(--radius-sm)"} ${faded() ? "opacity-0" : "opacity-100"}`}
            style={{
              top: frameBox().top,
              left: frameBox().left,
              width: frameBox().width,
              height: frameBox().height,
              transformOrigin: "0 0",
              transform: frameSteps(),
            }}
          >
            <If
              when={displayed()}
              else={
                <If when={failed()} else={<If when={loading()}><LoadingBlock percent={loadPercent()} bytes={loadBytes()} big={roomForCopy(frameBox())} /></If>}>
                  <Text testID="msg-image-status" class="px-5 py-[28px] text-[13px] text-ink">
                    {t().stream.artifactMissing}
                  </Text>
                </If>
              }
            >
              {(shownUrl: () => string) => (
                <>
                  <Image
                    testID="msg-image-full"
                    src={shownUrl()}
                    accessibilityLabel={name() || path()}
                    class="w-full h-full bg-pane"
                    style={{ objectFit: "cover", cursor: "zoom-out" }}
                    // Its long press (the copy menu) makes it the press's target, so the tap that
                    // closes is its own too: the stage's under it never hears a press on the picture.
                    onPress={() => tap()}
                    onLoad={(e) => natural.set({ width: e.size.width, height: e.size.height })}
                    onContextMenu={(e) => menuAt.set(e.pagePosition)}
                    onLongPress={(e) => menuAt.set(e.pagePosition)}
                  />
                  <If when={standingIn() && loading()}>
                    {/* The stand-in is on screen at the picture's size; what is still arriving shows on it. */}
                    <View testID="msg-image-progress" class="absolute left-0 right-0 bottom-0 items-center gap-[6px] pb-3" accessible>
                      <LoadingBlock percent={loadPercent()} bytes={loadBytes()} big={roomForCopy(frameBox())} overlay />
                    </View>
                  </If>
                </>
              )}
            </If>
          </View>
          <If when={waitingInPlace()}>
            {/* The frame waits in the picture it grows out of, too small to read: the progress sits here. */}
            <View testID="msg-image-waiting" class="absolute inset-0 items-center justify-center gap-2" style={{ pointerEvents: "none" }}>
              <LoadingBlock percent={loadPercent()} bytes={loadBytes()} big />
            </View>
          </If>
        </View>

        <If when={canSave() && shown()}>
          <View
            role="button"
            testID="msg-image-save"
            accessibilityLabel={t().stream.imageSave}
            tooltip={undefined}
            disabled={saving()}
            onPress={() => void save()}
            class={`cursor-pointer select-none disabled:cursor-default absolute top-4 right-[60px] z-[1] w-9 h-9 rounded-full border border-line items-center justify-center hover:bg-btn-secondary-hover ${saveNote() === "tap" ? "bg-brand" : "bg-btn-secondary-bg"} ${chrome()}`}
          >
            <If when={saving()} else={<Icon name="download" size={16} class={saveNote() === "tap" ? "tint-on-accent" : "tint-ink"} />}>
              <Icon name="spinner" size={16} class="animate-spin tint-brand" />
            </If>
          </View>
        </If>
        <View
          role="button"
          testID="msg-image-close"
          accessibilityLabel={t().common.close}
          onPress={() => requestClose()}
          class={`cursor-pointer select-none absolute top-4 right-4 z-[1] w-9 h-9 rounded-full border border-line bg-btn-secondary-bg items-center justify-center hover:bg-btn-secondary-hover ${chrome()}`}
        >
          <Icon name="x" size={16} class="tint-ink" />
        </View>
        <If when={offerOriginal() !== null && shown()}>
          <View class={`absolute left-0 right-0 bottom-[50px] items-center ${chrome()}`} style={{ pointerEvents: "box-none" }}>
            <View
              role="button"
              testID="msg-image-original"
              accessibilityState={{ busy: originalProgress() !== null }}
              disabled={originalProgress() !== null}
              onPress={() => loadOriginal()}
              class="cursor-pointer select-none disabled:cursor-default h-8 px-[14px] rounded-full border border-line bg-btn-secondary-bg hover:bg-btn-secondary-hover justify-center"
              style={{ maxWidth: windowSize().width - 48 }}
            >
              <Text class="text-[12px] font-semibold text-ink line-clamp-1 tabular-nums">
                {originalProgress() ? t().stream.imageOriginalLoading(originalBytes()) : t().stream.imageOriginal(formatFileSize(offerOriginal()!))}
              </Text>
            </View>
          </View>
        </If>
        <If
          when={saveNote()}
          else={
            <If when={name()}>
              <View class={`absolute left-0 right-0 bottom-[22px] items-center ${chrome()}`} style={{ pointerEvents: "none" }}>
                <Text testID="msg-image-caption" class="text-[12px] text-ink-secondary line-clamp-1" style={{ maxWidth: windowSize().width - 48 }}>
                  {name()}
                </Text>
              </View>
            </If>
          }
        >
          {(note: () => "tap" | "failed") => (
            <View class={`absolute left-0 right-0 bottom-[22px] items-center ${chrome()}`} style={{ pointerEvents: "none" }}>
              <Text testID="msg-image-caption" class="text-[12px] font-semibold text-ink line-clamp-1" style={{ maxWidth: windowSize().width - 48 }}>
                {note() === "tap" ? t().stream.imageSaveTapAgain : t().stream.imageSaveFailed}
              </Text>
            </View>
          )}
        </If>
        <If when={menuAt()}>
          {(at: () => Point) => <ImageContextMenu src={displayed() ?? ""} x={at().x} y={at().y} onClose={() => menuAt.set(null)} />}
        </If>
      </View>
    </Overlay>
  );
}

/**
 * What is still arriving: a ring (small inside a thumbnail, larger once the frame has grown), and
 * past that its words, the bytes and a bar. `overlay` is the same on top of a stand-in picture.
 */
function LoadingBlock(props: { percent: number | null; bytes: string | null; big: boolean; overlay?: boolean }) {
  return (
    <View testID="msg-image-loading" accessibilityLabel={copy().stream.artifactLoading} accessibilityState={{ busy: true }} class={`items-center justify-center gap-2 p-1 ${props.overlay ? "" : "flex-1"}`}>
      <Icon name="spinner" size={props.big ? 24 : 16} class="animate-spin tint-brand" />
      <If when={props.big}>
        <Text class="text-[13px] font-semibold text-ink text-center">{copy().stream.artifactLoading}</Text>
        <If when={props.bytes}>{(bytes: () => string) => <Text class="font-mono text-[12px] text-ink-secondary text-center">{bytes()}</Text>}</If>
        <View
          role="progressbar"
          accessibilityLabel={copy().stream.artifactLoading}
          accessibilityValue={{ min: 0, max: 100, now: props.percent ?? undefined }}
          class="w-[160px] max-w-[78%] h-[4px] rounded-full bg-line-hover overflow-hidden"
        >
          <View
            class="h-full rounded-full bg-brand"
            style={{ width: props.percent === null ? "40%" : `${props.percent}%` }}
          />
        </View>
      </If>
    </View>
  );
}
