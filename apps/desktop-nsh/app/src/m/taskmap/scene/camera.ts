/**
 * The camera over the picture: a pan (tx, ty, in view px) and a zoom k, kept so the ground stays in sight.
 * Pure helpers over a `Camera` value; the prototype's one mutable camera becomes whatever the caller keeps.
 * `box` is always the ground's picture box for the turn the camera is looking at (`buildGround(phi).box`).
 */
import { proj, unproj, type Box } from "./geometry.ts";

export interface Camera {
  tx: number;
  ty: number;
  k: number;
}

/** How much of the ground must stay inside the view when the camera is pushed to an edge, in view px. */
const KEEP_X = 160;
const KEEP_Y = 120;

/** The turn in [0, 360). */
export function normalizePhi(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Pans to (tx, ty) at zoom k, held so that at least a margin of the ground box stays in the view. */
export function clampCam(box: Box, viewW: number, viewH: number, tx: number, ty: number, k: number): Camera {
  return {
    tx: Math.min(viewW - KEEP_X - box.x0 * k, Math.max(KEEP_X - box.x1 * k, tx)),
    ty: Math.min(viewH - KEEP_Y - box.y0 * k, Math.max(KEEP_Y - box.y1 * k, ty)),
    k,
  };
}

/** Zooms to `k2` (held between `kMin` and `kMax`) keeping the view point (cx, cy) on the same ground. */
export function zoomAround(cam: Camera, k2: number, cx: number, cy: number, kMin: number, kMax: number, box: Box, viewW: number, viewH: number): Camera {
  const k = Math.min(kMax, Math.max(kMin, k2));
  if (Math.abs(k - cam.k) < 1e-4) return cam;
  return clampCam(box, viewW, viewH, cx - ((cx - cam.tx) * k) / cam.k, cy - ((cy - cam.ty) * k) / cam.k, k);
}

/**
 * Turns the map from `phiFrom` to `phiTo` degrees keeping the ground point under the view centre where it is.
 * `box` is the ground box at `phiTo` (the new turn), since the clamp holds the camera to the ground as it now is.
 */
export function rotateAround(cam: Camera, phiFrom: number, phiTo: number, viewW: number, viewH: number, box: Box): Camera {
  const to = normalizePhi(phiTo);
  const g = unproj(phiFrom, (viewW / 2 - cam.tx) / cam.k, (viewH / 2 - cam.ty) / cam.k);
  const [wx, wy] = proj(to, g[0], g[1], 0);
  return clampCam(box, viewW, viewH, viewW / 2 - wx * cam.k, viewH / 2 - wy * cam.k, cam.k);
}

/** The next quarter turn from `base` (degrees, not normalised): `dir` > 0 to the next multiple of 90 above, else below. */
export function turnTarget(base: number, dir: number): number {
  return dir > 0 ? Math.floor(base / 90 + 1e-6) * 90 + 90 : Math.ceil(base / 90 - 1e-6) * 90 - 90;
}

/**
 * The largest zoom at most 1 at which the whole ground box fits the view. A view with no size (not laid out
 * yet) gets 1. At this zoom the box fills the view, so `clampCam` pins the camera rather than letting it pan.
 */
export function fitZoom(box: Box, viewW: number, viewH: number): number {
  if (!(viewW > 0) || !(viewH > 0)) return 1;
  return Math.min(1, viewW / (box.x1 - box.x0), viewH / (box.y1 - box.y0));
}
