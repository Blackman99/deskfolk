/**
 * What a wheel does to the town (`MapScene.svelte`): a sideways swipe turns it, anything else zooms
 * about the pointer, and a trackpad pinch (ctrl + wheel, small steps) zooms more finely.
 */
import type { ShellWheel } from "../../platform/wheel";

export type WheelMove = { turn: number } | { zoom: number };

export function wheelMove(e: Pick<ShellWheel, "dx" | "dy" | "ctrl">): WheelMove {
  if (Math.abs(e.dx) > Math.abs(e.dy)) return { turn: Math.max(-80, Math.min(80, e.dx)) * 0.3 };
  const d = Math.max(-240, Math.min(240, e.dy));
  return { zoom: Math.exp(-d * (e.ctrl ? 0.01 : 0.0018)) };
}
