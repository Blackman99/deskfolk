import { describe, expect, test } from "bun:test";
import { buildGround } from "./draw.ts";
import { proj, unproj, type Box } from "./geometry.ts";
import { clampCam, fitZoom, normalizePhi, rotateAround, turnTarget, zoomAround, type Camera } from "./camera.ts";

const VW = 1060;
const VH = 680;
const boxAt = (phi: number): Box => buildGround(normalizePhi(phi)).box;

/** A camera that has the ground point (gx, gy) under the middle of the view at turn `phi`. */
function centredOn(phi: number, gx: number, gy: number, k: number, vw = VW, vh = VH): Camera {
  const [wx, wy] = proj(phi, gx, gy, 0);
  return { tx: vw / 2 - wx * k, ty: vh / 2 - wy * k, k };
}

/** The ground point under the middle of the view. */
const underCentre = (cam: Camera, phi: number, vw = VW, vh = VH): [number, number] => {
  const g = unproj(phi, (vw / 2 - cam.tx) / cam.k, (vh / 2 - cam.ty) / cam.k);
  return [g[0], g[1]];
};

const near = (a: number, b: number, eps = 1e-6): void => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("rotateAround", () => {
  const spots: Array<[number, number]> = [[0.4, 1.7], [3.5, 2.5], [-2, 0.1], [1.5, -2], [1.5, 1], [0, 0]];

  test("four quarter turns bring the camera back to where it was", () => {
    for (const [gx, gy] of spots) {
      for (const k of [1, 1.8, 2.5]) {
        for (const start of [0, 20, 137]) {
          const first = centredOn(start, gx, gy, k);
          let cam = first;
          let phi = start;
          for (let i = 0; i < 4; i++) {
            const to = normalizePhi(phi + 90);
            cam = rotateAround(cam, phi, to, VW, VH, boxAt(to));
            phi = to;
          }
          near(phi, normalizePhi(start));
          near(cam.tx, first.tx, 1e-6);
          near(cam.ty, first.ty, 1e-6);
          expect(cam.k).toBe(k);
        }
      }
    }
  });

  test("the turn buttons' four steps from a multiple of 90 do the same", () => {
    for (const [gx, gy] of spots) {
      const first = centredOn(0, gx, gy, 1.4);
      let cam = first;
      let phi = 0;
      for (let i = 0; i < 4; i++) {
        const to = normalizePhi(turnTarget(phi, 1));
        cam = rotateAround(cam, phi, to, VW, VH, boxAt(to));
        phi = to;
      }
      expect(phi).toBe(0);
      near(cam.tx, first.tx);
      near(cam.ty, first.ty);
    }
  });

  test("the ground point under the view centre stays fixed across a turn", () => {
    for (const [gx, gy] of spots) {
      for (const k of [1, 2.5]) {
        let phi = 20;
        let cam = centredOn(phi, gx, gy, k);
        for (const step of [90, 90, 90, 90, -90, 45, 10, 200, -130]) {
          const to = normalizePhi(phi + step);
          cam = rotateAround(cam, phi, to, VW, VH, boxAt(to));
          phi = to;
          const [ux, uy] = underCentre(cam, phi);
          near(ux, gx, 1e-6);
          near(uy, gy, 1e-6);
        }
      }
    }
  });

  test("a turn does not zoom, and an unnormalised target means the same turn", () => {
    const cam = centredOn(30, 1, 1.5, 1.6);
    const a = rotateAround(cam, 30, 120, VW, VH, boxAt(120));
    const b = rotateAround(cam, 30, 120 + 720, VW, VH, boxAt(120));
    const c = rotateAround(cam, 30, 120 - 360, VW, VH, boxAt(120));
    expect(a.k).toBe(1.6);
    near(a.tx, b.tx, 1e-9);
    near(a.ty, b.ty, 1e-9);
    near(a.tx, c.tx, 1e-9);
    near(a.ty, c.ty, 1e-9);
  });

  test("a turn leaves the camera where the clamp allows when the centre is off the ground", () => {
    const far: Camera = { tx: 5000, ty: 5000, k: 1 };
    const turned = rotateAround(far, 0, 90, VW, VH, boxAt(90));
    const held = clampCam(boxAt(90), VW, VH, turned.tx, turned.ty, 1);
    expect(turned).toEqual(held);
  });
});

describe("turnTarget", () => {
  test("steps to the next multiple of 90 in the direction asked", () => {
    expect(turnTarget(0, 1)).toBe(90);
    expect(turnTarget(45, 1)).toBe(90);
    expect(turnTarget(89.9, 1)).toBe(90);
    expect(turnTarget(90, 1)).toBe(180);
    expect(turnTarget(45, -1)).toBe(0);
    expect(turnTarget(90, -1)).toBe(0);
    expect(turnTarget(90.5, -1)).toBe(90);
    expect(turnTarget(270, 1)).toBe(360);
    expect(turnTarget(0, -1)).toBe(-90);
  });

  test("a hair off a multiple counts as on it", () => {
    expect(turnTarget(90 - 1e-9, 1)).toBe(180);
    expect(turnTarget(90 + 1e-9, -1)).toBe(0);
  });

  test("four steps one way come full circle", () => {
    let p = 33;
    for (let i = 0; i < 4; i++) p = turnTarget(p, 1);
    expect(p).toBe(360);
    expect(normalizePhi(p)).toBe(0);
  });
});

describe("normalizePhi", () => {
  test("lands in [0, 360)", () => {
    expect(normalizePhi(-90)).toBe(270);
    expect(normalizePhi(360)).toBe(0);
    expect(normalizePhi(725)).toBe(5);
    expect(normalizePhi(0)).toBe(0);
  });
});

describe("clampCam", () => {
  test("keeps a margin of the ground inside the view and leaves a camera in range alone", () => {
    for (const phi of [0, 90, 200]) {
      const box = boxAt(phi);
      const k = 1;
      expect(clampCam(box, VW, VH, 1e6, 1e6, k)).toEqual({ tx: VW - 160 - box.x0 * k, ty: VH - 120 - box.y0 * k, k });
      expect(clampCam(box, VW, VH, -1e6, -1e6, k)).toEqual({ tx: 160 - box.x1 * k, ty: 120 - box.y1 * k, k });
      const inside = centredOn(phi, 1.5, 1, k);
      expect(clampCam(box, VW, VH, inside.tx, inside.ty, k)).toEqual(inside);
    }
  });

  test("is idempotent", () => {
    const box = boxAt(45);
    const once = clampCam(box, VW, VH, 3000, -4000, 1.7);
    expect(clampCam(box, VW, VH, once.tx, once.ty, once.k)).toEqual(once);
  });
});

describe("zoomAround", () => {
  test("keeps the ground under the pointer where it was", () => {
    for (const phi of [0, 63, 180]) {
      const box = boxAt(phi);
      const cam = centredOn(phi, 1.5, 1, 1);
      const [cx, cy] = [700, 260];
      const before = unproj(phi, (cx - cam.tx) / cam.k, (cy - cam.ty) / cam.k);
      const zoomed = zoomAround(cam, 2.2, cx, cy, 0.5, 2.5, box, VW, VH);
      expect(zoomed.k).toBe(2.2);
      const after = unproj(phi, (cx - zoomed.tx) / zoomed.k, (cy - zoomed.ty) / zoomed.k);
      near(after[0], before[0], 1e-6);
      near(after[1], before[1], 1e-6);
    }
  });

  test("holds the zoom between its limits and returns the same camera when nothing changes", () => {
    const box = boxAt(0);
    const cam = centredOn(0, 1.5, 1, 1.5);
    expect(zoomAround(cam, 99, 500, 300, 0.5, 2.5, box, VW, VH).k).toBe(2.5);
    expect(zoomAround(cam, 0.01, 500, 300, 0.5, 2.5, box, VW, VH).k).toBe(0.5);
    expect(zoomAround(cam, 1.5, 500, 300, 0.5, 2.5, box, VW, VH)).toBe(cam);
    expect(zoomAround({ ...cam, k: 2.5 }, 10, 500, 300, 0.5, 2.5, box, VW, VH).k).toBe(2.5);
  });
});

describe("fitZoom", () => {
  const views: Array<[number, number]> = [[VW, VH], [600, 400], [320, 260], [3000, 2000], [900, 150], [150, 900]];

  test("is at most 1 and the fitted box fits the given view", () => {
    for (let deg = 0; deg < 360; deg += 10) {
      const box = boxAt(deg);
      for (const [vw, vh] of views) {
        const k = fitZoom(box, vw, vh);
        expect(k).toBeGreaterThan(0);
        expect(k).toBeLessThanOrEqual(1);
        expect((box.x1 - box.x0) * k).toBeLessThanOrEqual(vw + 1e-9);
        expect((box.y1 - box.y0) * k).toBeLessThanOrEqual(vh + 1e-9);
      }
    }
  });

  test("is the largest such zoom: 1, or the box touches the view on one side", () => {
    for (let deg = 0; deg < 360; deg += 10) {
      const box = boxAt(deg);
      for (const [vw, vh] of views) {
        const k = fitZoom(box, vw, vh);
        const touchesW = Math.abs((box.x1 - box.x0) * k - vw) < 1e-6;
        const touchesH = Math.abs((box.y1 - box.y0) * k - vh) < 1e-6;
        expect(k === 1 || touchesW || touchesH).toBe(true);
      }
    }
  });

  test("a view with no size gets 1 instead of collapsing the camera", () => {
    const box = boxAt(0);
    expect(fitZoom(box, 0, 0)).toBe(1);
    expect(fitZoom(box, 500, 0)).toBe(1);
    expect(fitZoom(box, Number.NaN, 300)).toBe(1);
  });

  test("a big view needs no shrinking", () => {
    expect(fitZoom(boxAt(0), 5000, 5000)).toBe(1);
  });
});
