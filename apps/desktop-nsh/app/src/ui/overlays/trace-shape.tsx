/**
 * The cut outlines of the trace board (a decision's pointed ends, a step's slant): CSS cut them with
 * `clip-path` and drew their ring from four shadows of the cut; here a `Canvas` behind the text
 * draws the polygon, its edge and its ring.
 */
import { Canvas, token, type CanvasRenderingContext2D, type CanvasSize } from "nsh";

/** Room round the box for the ring, so a ring drawn outside the edge is not clipped. */
const PAD = 3;

export type TraceShapeKind = "decision" | "step";

/** The polygon's corners in a box of `w` by `h` at (`x`, `y`). */
export function shapePoints(kind: TraceShapeKind, x: number, y: number, w: number, h: number, cut: number): Array<[number, number]> {
  return kind === "decision"
    ? [[x + cut, y], [x + w - cut, y], [x + w, y + h / 2], [x + w - cut, y + h], [x + cut, y + h], [x, y + h / 2]]
    : [[x + cut, y], [x + w, y], [x + w - cut, y + h], [x, y + h]];
}

function trace(cx: CanvasRenderingContext2D, points: Array<[number, number]>): void {
  cx.beginPath();
  points.forEach(([px, py], index) => (index === 0 ? cx.moveTo(px, py) : cx.lineTo(px, py)));
  cx.closePath();
}

/**
 * A cut outline behind a card's content: fill, one point of edge, and a ring of `ring` (2 points
 * outside the edge) when asked for. Fills the box it is put in and reaches `PAD` past it.
 */
export function TraceShape(props: {
  kind: TraceShapeKind;
  cut: number;
  edge: () => string;
  fill: () => string;
  /** The ring's colour; none draws no ring. */
  ring?: () => string | null;
}) {
  return (
    <Canvas
      class="absolute"
      style={{ left: -PAD, top: -PAD, right: -PAD, bottom: -PAD, pointerEvents: "none" }}
      draw={(cx: CanvasRenderingContext2D, size: CanvasSize) => {
        const w = size.width - PAD * 2;
        const h = size.height - PAD * 2;
        cx.clearRect(0, 0, size.width, size.height);
        if (w <= 0 || h <= 0) return;
        const ring = props.ring?.() ?? null;
        if (ring) {
          cx.lineJoin = "round";
          cx.lineWidth = 4;
          cx.strokeStyle = ring;
          trace(cx, shapePoints(props.kind, PAD, PAD, w, h, props.cut));
          cx.stroke();
        }
        // On the board's own colour first: the fills are washes in the dark.
        trace(cx, shapePoints(props.kind, PAD, PAD, w, h, props.cut));
        cx.fillStyle = token("pane");
        cx.fill();
        cx.fillStyle = props.fill();
        cx.fill();
        cx.lineWidth = 1;
        cx.lineJoin = "miter";
        cx.strokeStyle = props.edge();
        trace(cx, shapePoints(props.kind, PAD + 0.5, PAD + 0.5, w - 1, h - 1, props.cut));
        cx.stroke();
      }}
    />
  );
}
