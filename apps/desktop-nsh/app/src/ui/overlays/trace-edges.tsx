/**
 * The lines between the trace board's cards, drawn on one `Canvas` the size of the board (the
 * messenger drew them as SVG paths): from each waking card's bottom to the woken one's top. A line
 * into a card still going or waiting on you wears that card's colour and is dashed, so you can
 * follow the work to where it is now.
 *
 * Not carried over: the running line's dashes flowing toward the card (a CSS animation of the
 * dash offset); the dashes stand still.
 */
import { Canvas, Path2D, token, type CanvasRenderingContext2D } from "nsh";
import type { TraceEdge } from "../../m/overlays/task-trace.ts";

function colourOf(live: TraceEdge["live"]): string {
  switch (live) {
    case "running": return token("brand");
    case "waiting_approval": return token("warn");
    case "waiting_ask": return token("purple");
    default: return token("line-hover");
  }
}

export function TraceEdges(props: { edges: readonly TraceEdge[]; width: number; height: number }) {
  return (
    <Canvas
      testID="trace-edges"
      class="absolute"
      style={{ left: 0, top: 0, width: props.width, height: props.height, pointerEvents: "none" }}
      draw={(cx: CanvasRenderingContext2D) => {
        cx.clearRect(0, 0, props.width, props.height);
        cx.lineCap = "butt";
        for (const edge of props.edges) {
          const live = edge.live === "running" || edge.live === "waiting_approval" || edge.live === "waiting_ask";
          cx.beginPath();
          cx.strokeStyle = colourOf(edge.live);
          cx.lineWidth = live ? 2 : 1.5;
          cx.setLineDash(live ? [6, 4] : []);
          cx.stroke(new Path2D(edge.path));
        }
        cx.setLineDash([]);
      }}
    />
  );
}
