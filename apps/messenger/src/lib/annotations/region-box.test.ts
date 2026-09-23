import { expect, test } from "bun:test";
import {
  boxBetween,
  clickBox,
  cropRect,
  encodeCrop,
  isClick,
  isUsableBox,
  moveBox,
  resizeBox,
  scaledSize,
  toNorm,
  toPercentStyle,
  toScreen,
} from "./region-box.ts";

test("a pointer maps onto the drawn image whatever its displayed size, clamped to the edges", () => {
  // A 2048×1365 image drawn at half size, 100px from the left and 50px down.
  const drawn = { left: 100, top: 50, width: 1024, height: 682.5 };
  expect(toNorm(100 + 512, 50 + 341.25, drawn)).toEqual({ x: 0.5, y: 0.5 });
  expect(toNorm(0, 0, drawn)).toEqual({ x: 0, y: 0 });
  expect(toNorm(5000, 5000, drawn)).toEqual({ x: 1, y: 1 });
  // The same point on a smaller container lands on the same place in the image.
  const small = { left: 0, top: 0, width: 300, height: 199.95 };
  expect(toNorm(150, 99.975, small)).toEqual({ x: 0.5, y: 0.5 });
  expect(toNorm(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
});

test("a box on screen goes back to the same pixels and percentages", () => {
  const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  expect(toScreen(box, { left: 10, top: 20, width: 1000, height: 500 })).toEqual({ left: 110, top: 120, width: 300, height: 200 });
  expect(toPercentStyle(box)).toBe("left:10.000%;top:20.000%;width:30.000%;height:40.000%");
});

test("a drag in any direction gives the same box, inside the image", () => {
  expect(boxBetween({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.1 })).toEqual({ x: 0.2, y: 0.1, w: 0.39999999999999997, h: 0.6 });
  expect(boxBetween({ x: -0.5, y: 0.5 }, { x: 0.5, y: 1.5 })).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
});

test("a click is a square 4% of the short side, on landscape and portrait, nudged in at the edges", () => {
  // Landscape 2000×1000: side 40px → w 0.02, h 0.04.
  expect(clickBox({ x: 0.5, y: 0.5 }, { width: 2000, height: 1000 })).toEqual({ x: 0.49, y: 0.48, w: 0.02, h: 0.04 });
  // Portrait 1000×2000: side 40px → w 0.04, h 0.02.
  const portrait = clickBox({ x: 0.5, y: 0.5 }, { width: 1000, height: 2000 });
  expect(portrait.w).toBeCloseTo(0.04);
  expect(portrait.h).toBeCloseTo(0.02);
  // At the corner the box stays inside.
  const corner = clickBox({ x: 1, y: 0 }, { width: 1000, height: 1000 });
  expect(corner).toEqual({ x: 0.96, y: 0, w: 0.04, h: 0.04 });
  expect(isClick({ x: 10, y: 10 }, { x: 12, y: 12 })).toBe(true);
  expect(isClick({ x: 10, y: 10 }, { x: 20, y: 10 })).toBe(false);
});

test("a box moves and resizes without leaving the image", () => {
  const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  expect(moveBox(box, 0.9, -0.5)).toEqual({ x: 0.8, y: 0, w: 0.2, h: 0.2 });
  const grown = resizeBox(box, "se", { x: 0.5, y: 0.6 });
  expect(grown.x).toBeCloseTo(0.1);
  expect(grown.w).toBeCloseTo(0.4);
  expect(grown.h).toBeCloseTo(0.5);
  // Dragging a corner past the opposite one flips the box rather than inverting it.
  const flipped = resizeBox(box, "nw", { x: 0.5, y: 0.5 });
  expect(flipped.x).toBeCloseTo(0.3);
  expect(flipped.w).toBeCloseTo(0.2);
  expect(isUsableBox({ x: 0, y: 0, w: 0, h: 0.5 })).toBe(false);
  expect(isUsableBox(box)).toBe(true);
});

test("the crop keeps a 10% margin, is cut at the image's edge, and whole pixels", () => {
  expect(cropRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, { width: 1000, height: 800 })).toEqual({ sx: 200, sy: 160, sw: 600, sh: 480 });
  // A box against the left and top edges: no margin past the image.
  expect(cropRect({ x: 0, y: 0, w: 0.1, h: 0.1 }, { width: 1000, height: 1000 })).toEqual({ sx: 0, sy: 0, sw: 110, sh: 110 });
  // A box against the far corner.
  expect(cropRect({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, { width: 1000, height: 1000 })).toEqual({ sx: 890, sy: 890, sw: 110, sh: 110 });
});

test("a crop of a huge image is drawn with its long side at 1024, a small one as it is", () => {
  expect(scaledSize(8000, 2000)).toEqual({ width: 1024, height: 256 });
  expect(scaledSize(1500, 3000)).toEqual({ width: 512, height: 1024 });
  expect(scaledSize(300, 200)).toEqual({ width: 300, height: 200 });
});

test("encoding picks PNG when it fits, falls back to JPEG, and gives up past every quality", async () => {
  const blob = (bytes: number) => new Blob([new Uint8Array(bytes)]);
  const small = await encodeCrop({ toBlob: async (type) => (type === "image/png" ? blob(10) : blob(5)) });
  expect(small?.mime).toBe("image/png");
  expect(small?.base64).toBe("AAAAAAAAAAAAAA==");
  const qualities: number[] = [];
  const jpeg = await encodeCrop({
    toBlob: async (type, quality) => {
      if (type === "image/png") return blob(2_000_000);
      qualities.push(quality ?? 1);
      return blob(quality! <= 0.7 ? 500_000 : 1_500_000);
    },
  });
  expect(jpeg?.mime).toBe("image/jpeg");
  expect(qualities).toEqual([0.9, 0.8, 0.7]);
  expect(await encodeCrop({ toBlob: async () => blob(5_000_000) })).toBeNull();
});
