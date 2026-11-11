/**
 * The whole trace board drawn small, with the part in view framed. Where it sits is the host's
 * business; it sizes itself from the board's shape and the viewport it is drawn over. A press
 * slides the view there, a drag carries the frame.
 *
 * The wheel over the map is the board's (`onWheel`), so the corner is not a dead spot for scrolling.
 */
import { Canvas, View, signal, token, type CanvasRenderingContext2D, type CanvasSize, type ViewRef } from "nsh";
import type { TaskTraceNode } from "@real-bot/protocol";
import { traceNodeShape, type TraceFlow, type TraceView } from "../../m/overlays/task-trace.ts";
import {
  fromMinimap,
  minimapFrame,
  minimapSize,
  onMinimap,
  visibleRect,
  type MinimapFrame,
  type TraceRect,
} from "../../m/overlays/trace-minimap.ts";
import { onWheel } from "../../platform/wheel";
import type { ShellWheel } from "../../platform/wheel";
import { tip } from "../tip";

/** How a card stands out on the map: as it does on the board, lit, dimmed or asked for. */
export type MinimapTone = "lit" | "blamed" | "dim" | "focus" | null;

/** A card a few pixels across still reads as one, and a folded round's line as a line. */
function drawn(at: MinimapFrame, rect: TraceRect, least = 1.5): TraceRect {
  const box = onMinimap(at, rect);
  return { ...box, width: Math.max(least, box.width), height: Math.max(least, box.height) };
}

/** Each card in the colour of its status, as the stripe down its left edge is on the board; a finished one, like its card, in none. */
function fillOf(status: TaskTraceNode["status"]): string {
  switch (status) {
    case "running": return token("brand");
    case "waiting_approval": return token("warn");
    case "waiting_ask": return token("purple");
    case "redirected": return token("ink-muted");
    case "interrupted":
    case "stopped": return token("danger");
    default: return token("muted-light");
  }
}

type Press = { x: number; y: number; local: { x: number; y: number }; grab: { x: number; y: number }; moved: boolean };

export function TraceMinimap(props: {
  flow: TraceFlow;
  view: TraceView;
  viewport: { width: number; height: number };
  toneOf: (node: TaskTraceNode) => MinimapTone;
  hint: string;
  /** Put the view's middle on this board point; a press slides there, a drag follows the pointer. */
  onCentre: (point: { x: number; y: number }, glide: boolean) => void;
  /** The wheel over the map is the board's; `event.x`, `event.y` are in the window. */
  onWheel: (event: ShellWheel) => void;
}) {
  let mapRef: ViewRef | null = null;
  onWheel(() => mapRef, (e) => props.onWheel(e));
  /**
   * The map as it was when pressed. It draws the view's frame along with the board, so a drag that
   * takes the frame off the board would rescale the map under the pointer; it holds still until
   * the press is let go.
   */
  const held = signal<MinimapFrame | null>(null);
  let press: Press | null = null;

  const size = () => minimapSize(props.flow, props.viewport, props.view.scale);
  const visible = (): TraceRect | null => (props.viewport.width && props.viewport.height ? visibleRect(props.view, props.viewport) : null);
  const frame = (): MinimapFrame | null => {
    const kept = held();
    if (kept) return kept;
    const box = size();
    return box ? minimapFrame(props.flow, visible(), box) : null;
  };

  function draw(cx: CanvasRenderingContext2D, canvas: CanvasSize): void {
    cx.clearRect(0, 0, canvas.width, canvas.height);
    const at = frame();
    if (!at) return;
    for (const round of props.flow.rounds) {
      if (!round.header) continue;
      const box = drawn(at, round.header);
      cx.fillStyle = round.folded ? token("line-hover") : token("line");
      cx.beginPath();
      cx.roundRect(box.x, box.y, box.width, box.height, Math.min(box.height / 2, 3));
      cx.fill();
    }
    for (const placement of props.flow.placements) {
      const box = drawn(at, placement);
      const tone = props.toneOf(placement.node);
      const shape = traceNodeShape(placement.node);
      cx.globalAlpha = tone === "dim" ? 0.2 : tone ? 1 : 0.7;
      cx.fillStyle = fillOf(placement.node.status);
      cx.beginPath();
      if (shape === "decision") {
        // A decision's pointed ends, as on the board, small.
        const point = Math.min(box.width / 4, box.height / 2);
        const { x, y, width: w, height: h } = box;
        cx.moveTo(x + point, y);
        cx.lineTo(x + w - point, y);
        cx.lineTo(x + w, y + h / 2);
        cx.lineTo(x + w - point, y + h);
        cx.lineTo(x + point, y + h);
        cx.lineTo(x, y + h / 2);
        cx.closePath();
      } else {
        cx.roundRect(box.x, box.y, box.width, box.height, shape === "line" ? box.height / 2 : 1);
      }
      cx.fill();
      if (tone === "lit" || tone === "focus" || tone === "blamed") {
        cx.lineWidth = 1.5;
        cx.strokeStyle = tone === "blamed" ? token("warn") : token("brand");
        cx.stroke();
      }
    }
    cx.globalAlpha = 1;
    const view = visible();
    if (view) {
      const box = onMinimap(at, view);
      cx.beginPath();
      cx.roundRect(box.x, box.y, box.width, box.height, 2);
      cx.globalAlpha = 0.1;
      cx.fillStyle = token("brand");
      cx.fill();
      cx.globalAlpha = 1;
      cx.lineWidth = 1.25;
      cx.strokeStyle = token("brand");
      cx.stroke();
    }
  }

  const localOf = (page: { x: number; y: number }): { x: number; y: number } =>
    press ? { x: press.local.x + (page.x - press.x), y: press.local.y + (page.y - press.y) } : page;

  function onDown(local: { x: number; y: number }, page: { x: number; y: number }): void {
    const at = frame();
    if (!at) return;
    held.set(at);
    const point = fromMinimap(at, local);
    const view = visible();
    const inFrame = view !== null && point.x >= view.x && point.x <= view.x + view.width && point.y >= view.y && point.y <= view.y + view.height;
    // Pressed inside the frame, the frame is picked up where it was pressed; anywhere else the view
    // slides there, and a drag from then on carries it.
    const grab = inFrame && view ? { x: point.x - (view.x + view.width / 2), y: point.y - (view.y + view.height / 2) } : { x: 0, y: 0 };
    press = { x: page.x, y: page.y, local, grab, moved: false };
    if (!inFrame) props.onCentre(point, true);
  }

  function onMove(page: { x: number; y: number }): void {
    const kept = held();
    if (!press || !kept) return;
    // A hand that shakes on a press is not a drag: it would cut the slide short.
    if (!press.moved && Math.abs(page.x - press.x) <= 2 && Math.abs(page.y - press.y) <= 2) return;
    press.moved = true;
    const at = fromMinimap(kept, localOf(page));
    props.onCentre({ x: at.x - press.grab.x, y: at.y - press.grab.y }, false);
  }

  function onUp(): void {
    press = null;
    held.set(null);
  }

  return (
    <If when={frame()}>
      {(at: () => MinimapFrame) => (
        <View
          testID="trace-minimap"
          ref={(node: ViewRef) => (mapRef = node)}
          tooltip={tip(props.hint)}
          accessibilityElementsHidden
          class="overflow-hidden rounded-(--radius-md) border border-line bg-pane"
          style={{ width: at().width, height: at().height }}
          onStartShouldSetResponder={() => true}
          onResponderGrant={(e) => {
            onDown({ x: e.locationX, y: e.locationY }, { x: e.pageX, y: e.pageY });
          }}
          onResponderMove={(e) => onMove({ x: e.pageX, y: e.pageY })}
          onResponderRelease={onUp}
          onResponderTerminate={onUp}
          onResponderTerminationRequest={() => false}
        >
          <Canvas class="absolute left-0 top-0 right-0 bottom-0" style={{ pointerEvents: "none" }} draw={draw} />
        </View>
      )}
    </If>
  );
}
