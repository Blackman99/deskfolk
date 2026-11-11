/**
 * What the glass and the wheel do on the picture: the responder that reads the fingers, trackpad
 * mode's pointer moves, taps and drags where the finger lands, pinch and two-finger pan on the
 * phone, and the wheel (`src/platform/wheel.ts`). The pointer goes to the Mac as RFB PointerEvents
 * (`PointerOut`), the zoom stays on the phone.
 */
import { PanResponder, pixelRatio, cleanup, type GestureResponderEvent, type PanResponderInstance, type ViewRef } from "nsh";
import { onWheel } from "../../platform/wheel";
import { BUTTON } from "../../m/overlays/screen-pointer.ts";
import { TrackpadGestures, pointerGain, type Finger, type Point, type TrackpadAction } from "../../m/overlays/screen-trackpad.ts";
import { boxFor, follow, keepShown, panBy, zoomAround, type ZoomView } from "../../m/overlays/screen-zoom.ts";
import { POINTER_MARGIN, type ScreenController } from "./remote-screen-controller.ts";
import { DirectTouch, type TouchAction } from "./remote-screen-touch.ts";

const WHEEL = { up: BUTTON.wheelUp, down: BUTTON.wheelDown, left: BUTTON.wheelLeft, right: BUTTON.wheelRight } as const;
const BUTTONS = { left: BUTTON.left, right: BUTTON.right, middle: BUTTON.middle } as const;
const clamp = (n: number, low: number, high: number): number => Math.min(Math.max(n, low), high);

export type ScreenGestures = {
  panHandlers: PanResponderInstance["panHandlers"];
  /** Where the stage is in the window: its touches' `pageX` / `pageY` are measured from there. */
  measured(pagePosition: Point): void;
};

export function screenGestures(screen: ScreenController, stageRef: () => ViewRef | undefined): ScreenGestures {
  let origin: Point = { x: 0, y: 0 };
  let pinchFrom: ZoomView | null = null;
  let panFrom: ZoomView | null = null;

  /** The pointer is where the page shows it: zoomed in elsewhere, it comes into view first. */
  const onTrackpad = (action: TrackpadAction): void => {
    const frame = screen.frame();
    const stage = screen.stage();
    if (!frame || !stage.w || !stage.h) return;
    const view = screen.view();
    if (action.kind === "pinch") {
      if (action.start || !pinchFrom) pinchFrom = view;
      screen.view.set(zoomAround(stage, frame, pinchFrom, action.anchor, pinchFrom.zoom * action.scale, screen.zoomLimit(pixelRatio())));
      return;
    }
    const at = keepShown(stage, frame, view, screen.pointer() ?? { x: frame.w / 2, y: frame.h / 2 }, POINTER_MARGIN);
    if (action.kind === "move") {
      // Gain 1 keeps the pointer level with the finger over the picture, at any zoom.
      const perMacPixel = boxFor(stage, frame, view).width / frame.w;
      const gain = pointerGain(action.speed) / perMacPixel;
      const pointer = { x: clamp(at.x + action.dx * gain, 0, frame.w - 1), y: clamp(at.y + action.dy * gain, 0, frame.h - 1) };
      screen.pointer.set(pointer);
      screen.view.set(follow(stage, frame, view, pointer, POINTER_MARGIN));
      screen.out.moveTo(pointer);
      return;
    }
    screen.pointer.set(at);
    if (action.kind === "click") {
      screen.out.click(at, action.button === "right" ? BUTTON.right : BUTTON.left);
    } else if (action.kind === "press") {
      screen.dragging.set(true);
      screen.out.press(at, BUTTON.left);
    } else if (action.kind === "release") {
      screen.dragging.set(false);
      screen.out.release(at, BUTTON.left);
    } else {
      screen.out.wheel(at, WHEEL[action.direction]);
    }
  };

  /** Taps and drags land where the finger is, so the pointer follows to where it was left. */
  const onDirect = (action: TouchAction): void => {
    const frame = screen.frame();
    const stage = screen.stage();
    if (!frame || !stage.w || !stage.h) return;
    if (action.kind === "pinch") {
      if (action.start || !pinchFrom) pinchFrom = screen.view();
      screen.view.set(zoomAround(stage, frame, pinchFrom, action.anchor, pinchFrom.zoom * action.scale, screen.zoomLimit(pixelRatio())));
      return;
    }
    if (action.kind === "pan") {
      if (action.start || !panFrom) panFrom = screen.view();
      screen.view.set(panBy(stage, frame, panFrom, action.moved));
      return;
    }
    const at = screen.toFrame(action.at);
    if (!at) return;
    screen.pointer.set(at);
    if (action.kind === "click") screen.out.click(at, BUTTONS[action.button]);
    else if (action.kind === "press") {
      if (action.button === "left") screen.dragging.set(true);
      screen.out.press(at, BUTTONS[action.button]);
    } else if (action.kind === "move") screen.out.moveTo(at);
    else if (action.kind === "release") {
      screen.dragging.set(false);
      screen.out.release(at, BUTTONS[action.button]);
    } else screen.out.wheel(at, WHEEL[action.direction]);
  };

  const trackpad = new TrackpadGestures(onTrackpad);
  const direct = new DirectTouch(onDirect, () => screen.view().zoom > 1.01);
  screen.resetters.push(
    () => trackpad.reset(),
    () => direct.reset(),
  );

  const fingers = (e: GestureResponderEvent): Finger[] =>
    e.touches.map((touch) => ({ id: touch.identifier, x: touch.pageX - origin.x, y: touch.pageY - origin.y }));
  const update = (e: GestureResponderEvent): void => {
    if (screen.phase() !== "live") return;
    if (screen.trackpad()) trackpad.update(fingers(e));
    else direct.update(fingers(e));
  };
  const cancel = (): void => {
    trackpad.cancel();
    direct.cancel();
  };

  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => screen.phase() === "live",
    onMoveShouldSetPanResponder: () => screen.phase() === "live",
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: update,
    onPanResponderStart: update,
    onPanResponderMove: update,
    onPanResponderEnd: update,
    onPanResponderRelease: update,
    onPanResponderTerminate: cancel,
  });

  // The wheel: a plain one turns the Mac's wheel, a pinch (ctrl) zooms the picture on the phone.
  let carried = { x: 0, y: 0 };
  onWheel(stageRef, (e, at) => {
    if (screen.phase() !== "live") return;
    const frame = screen.frame();
    const stage = screen.stage();
    if (!frame || !stage.w || !stage.h) return;
    if (e.ctrl) {
      screen.view.set(zoomAround(stage, frame, screen.view(), at, screen.view().zoom * Math.exp(-e.dy / 100), screen.zoomLimit(pixelRatio())));
      return;
    }
    const pointer = screen.toFrame(at);
    if (!pointer) return;
    carried = { x: carried.x + e.dx, y: carried.y + e.dy };
    const step = 50;
    while (Math.abs(carried.y) >= step) {
      screen.out.wheel(pointer, carried.y > 0 ? BUTTON.wheelDown : BUTTON.wheelUp);
      carried.y -= Math.sign(carried.y) * step;
    }
    while (Math.abs(carried.x) >= step) {
      screen.out.wheel(pointer, carried.x > 0 ? BUTTON.wheelRight : BUTTON.wheelLeft);
      carried.x -= Math.sign(carried.x) * step;
    }
  });
  cleanup(() => {
    trackpad.reset();
    direct.reset();
  });

  return {
    panHandlers: responder.panHandlers,
    measured: (pagePosition) => {
      origin = pagePosition;
    },
  };
}
