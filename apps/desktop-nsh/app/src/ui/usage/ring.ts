/**
 * What the usage rings share: an arc as full as what is used, drawn on a `Canvas`. The messenger
 * draws them as SVG circles on a `viewBox` (`pathLength="100"`, a dash offset, rotated -90°); here
 * the same circle is an arc from the top, clockwise, scaled from that `viewBox` to the canvas.
 */
import { token, type CanvasRenderingContext2D } from "nsh";
import { usageLevel } from "../../m/usage/usage.ts";

export type UsageLevel = ReturnType<typeof usageLevel>;

/** A level's colour: the window's own tint, `normal` being the caller's quiet one. */
export function levelColor(level: UsageLevel, normal: "ink-muted" | "ink-secondary" = "ink-muted"): string {
  return level === "warn" ? token("warn") : level === "danger" ? token("danger") : token(normal);
}

export type RingShape = {
  /** The canvas's edge, in points. */
  box: number;
  /** The messenger's `viewBox` edge, which the radius and stroke are in. */
  view: number;
  radius: number;
  width: number;
  /** How much is used, 0–100; null draws only the track. */
  used: number | null;
  color: string;
  track: string;
  /** A dashed track, for an agent with today's records only. */
  dashed?: boolean;
};

/** The track circle, then the arc of what is used from the top, clockwise, with round ends. */
export function drawRing(cx: CanvasRenderingContext2D, shape: RingShape): void {
  const scale = shape.box / shape.view;
  const centre = shape.box / 2;
  const radius = shape.radius * scale;
  cx.lineWidth = shape.width * scale;
  cx.strokeStyle = shape.track;
  cx.lineCap = "butt";
  cx.setLineDash(shape.dashed ? [3 * scale, 3 * scale] : []);
  cx.beginPath();
  cx.arc(centre, centre, radius, 0, Math.PI * 2);
  cx.stroke();
  cx.setLineDash([]);
  if (shape.used === null || shape.used <= 0) return;
  cx.strokeStyle = shape.color;
  cx.lineCap = "round";
  cx.beginPath();
  const start = -Math.PI / 2;
  cx.arc(centre, centre, radius, start, start + (Math.PI * 2 * Math.min(100, shape.used)) / 100);
  cx.stroke();
}
