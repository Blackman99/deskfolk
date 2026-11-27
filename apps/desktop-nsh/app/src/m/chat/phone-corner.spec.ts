import { expect, test } from "bun:test";
import {
  COMPOSER_CARD_BASE_BOTTOM,
  COMPOSER_CARD_BASE_X,
  computeDockedComposerInsets,
  cornerSideInset,
  estimatePhoneCornerRadius,
  extractPhoneModel,
} from "./phone-corner.ts";

const ZERO_SAFE = { top: 0, right: 0, bottom: 0, left: 0 };

test("extractPhoneModel prefers Client Hints model, parses non-reduced Android UA, and ignores Chrome's reduced 'K'", () => {
  expect(extractPhoneModel({ model: "Pixel 9 Pro", userAgent: "Mozilla/5.0 (Linux; Android 10; K)" })).toBe("Pixel 9 Pro");
  expect(extractPhoneModel({ userAgent: "Mozilla/5.0 (Linux; Android 14; 24129PN74C Build/UKQ1) AppleWebKit/537.36" })).toBe("24129PN74C");
  expect(extractPhoneModel({ userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S928B Build/UP1A) AppleWebKit/537.36" })).toBe("SM-S928B");
  expect(extractPhoneModel({ userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36" })).toBeNull();
  expect(extractPhoneModel({ model: "K", userAgent: "Mozilla/5.0 (Linux; Android 10; K)" })).toBeNull();
});

test("estimatePhoneCornerRadius distinguishes iPhone generations by logical screen size", () => {
  const iphoneUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
  expect(estimatePhoneCornerRadius({ userAgent: iphoneUa, screenWidth: 375, screenHeight: 667 })).toBe(0); // SE / 8
  expect(estimatePhoneCornerRadius({ userAgent: iphoneUa, screenWidth: 375, screenHeight: 812 })).toBe(42); // X / mini
  expect(estimatePhoneCornerRadius({ userAgent: iphoneUa, screenWidth: 390, screenHeight: 844 })).toBe(47); // 12 / 13 / 14
  expect(estimatePhoneCornerRadius({ userAgent: iphoneUa, screenWidth: 428, screenHeight: 926 })).toBe(53); // 12/13 Pro Max
  expect(estimatePhoneCornerRadius({ userAgent: iphoneUa, screenWidth: 393, screenHeight: 852 })).toBe(55); // 14 Pro / 15 / 16
  expect(estimatePhoneCornerRadius({ userAgent: iphoneUa, screenWidth: 402, screenHeight: 874 })).toBe(62); // 16 Pro
  expect(estimatePhoneCornerRadius({ userAgent: iphoneUa, screenWidth: 440, screenHeight: 956 })).toBe(62); // 16 Pro Max
  // Landscape swaps width and height; corner radius stays the same.
  expect(estimatePhoneCornerRadius({ userAgent: iphoneUa, screenWidth: 874, screenHeight: 402 })).toBe(62);
});

test("estimatePhoneCornerRadius maps Android models from boxy flagships to large-radius phones", () => {
  const reducedAndroid = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/134.0.0.0 Mobile Safari/537.36";
  expect(estimatePhoneCornerRadius({ userAgent: reducedAndroid, model: "SM-S928B" })).toBe(8); // Galaxy S24 Ultra (boxy)
  expect(estimatePhoneCornerRadius({ userAgent: reducedAndroid, model: "XQ-DQ72" })).toBe(8); // Sony Xperia
  expect(estimatePhoneCornerRadius({ userAgent: reducedAndroid, model: "SM-S938B" })).toBe(36); // Galaxy S25 Ultra (rounded)
  expect(estimatePhoneCornerRadius({ userAgent: reducedAndroid, model: "Pixel 7" })).toBe(38);
  expect(estimatePhoneCornerRadius({ userAgent: reducedAndroid, model: "Pixel 9 Pro" })).toBe(48);
  expect(estimatePhoneCornerRadius({ userAgent: reducedAndroid, model: "24129PN74C" })).toBe(48); // Xiaomi 15
  expect(estimatePhoneCornerRadius({ userAgent: reducedAndroid, model: "ALN-AL00" })).toBe(48); // Huawei Mate 60 Pro
  expect(estimatePhoneCornerRadius({ userAgent: reducedAndroid, model: "PJD110" })).toBe(46); // OnePlus 12
  expect(estimatePhoneCornerRadius({ userAgent: reducedAndroid, model: "V2309A" })).toBe(46); // vivo X100
  // Reduced UA with no model falls back to screen aspect ratio.
  expect(estimatePhoneCornerRadius({ userAgent: reducedAndroid, screenWidth: 412, screenHeight: 915 })).toBe(44);
  expect(estimatePhoneCornerRadius({ userAgent: reducedAndroid, screenWidth: 360, screenHeight: 640 })).toBe(24);
});

test("larger display corner radii receive proportionally wider horizontal clearance when bottom inset is small", () => {
  const flat = cornerSideInset(0, 6);
  const boxy = cornerSideInset(8, 6);
  const pixel7 = cornerSideInset(38, 10);
  const genericAndroid = cornerSideInset(44, 10);
  const xiaomi15 = cornerSideInset(48, 10);
  const iphone15 = cornerSideInset(55, 12);
  const iphone16Pro = cornerSideInset(62, 14);

  expect(flat).toBe(12);
  expect(boxy).toBe(12);
  expect(pixel7).toBeGreaterThan(flat);
  expect(genericAndroid).toBeGreaterThanOrEqual(pixel7);
  expect(xiaomi15).toBeGreaterThanOrEqual(genericAndroid);
  expect(iphone15).toBeGreaterThanOrEqual(xiaomi15);
  expect(iphone16Pro).toBeGreaterThanOrEqual(iphone15);
  expect(iphone16Pro).toBeLessThanOrEqual(26);
});

test("desktop narrow windows keep the exact base docked padding unchanged", () => {
  expect(
    computeDockedComposerInsets({
      desktop: true,
      cornerRadius: 62,
      safeArea: { top: 0, right: 0, bottom: 34, left: 0 },
      restingSafeBottom: 34,
      keyboardOpen: false,
      width: 390,
    }),
  ).toEqual({
    cardBottom: COMPOSER_CARD_BASE_BOTTOM,
    cardLeft: COMPOSER_CARD_BASE_X,
    cardRight: COMPOSER_CARD_BASE_X,
    rowExtraLeft: 0,
    rowExtraRight: 0,
  });
});

test("phone docked composer adds safeArea.bottom and keeps side padding steady when the keyboard opens", () => {
  const closed = computeDockedComposerInsets({
    desktop: false,
    cornerRadius: 55,
    safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
    restingSafeBottom: 34,
    keyboardOpen: false,
    width: 393,
  });
  expect(closed.cardBottom).toBe(40);
  expect(closed.cardLeft + closed.rowExtraLeft).toBe(16);
  expect(closed.cardRight + closed.rowExtraRight).toBe(16);

  // When the soft keyboard opens and safeArea.bottom drops to 0, cardBottom collapses to 6 while
  // horizontal padding stays at 16 (computed from restingSafeBottom) instead of jumping sideways.
  const open = computeDockedComposerInsets({
    desktop: false,
    cornerRadius: 55,
    safeArea: ZERO_SAFE,
    restingSafeBottom: 34,
    keyboardOpen: true,
    width: 393,
  });
  expect(open.cardBottom).toBe(COMPOSER_CARD_BASE_BOTTOM);
  expect(open.rowExtraLeft).toBe(closed.rowExtraLeft);
  expect(open.rowExtraRight).toBe(closed.rowExtraRight);
});

test("Android rounded-corner phone with zero safeArea.bottom gets corner clearance on both sides and bottom", () => {
  const xiaomi = computeDockedComposerInsets({
    desktop: false,
    cornerRadius: 48,
    safeArea: ZERO_SAFE,
    restingSafeBottom: 0,
    keyboardOpen: false,
    width: 393,
  });
  expect(xiaomi.cardBottom).toBe(10);
  expect(xiaomi.cardLeft + xiaomi.rowExtraLeft).toBeGreaterThanOrEqual(20);
  expect(xiaomi.cardRight + xiaomi.rowExtraRight).toBeGreaterThanOrEqual(20);
});

test("landscape safeArea.left/right are respected without double-counting row extra padding", () => {
  const landscape = computeDockedComposerInsets({
    desktop: false,
    cornerRadius: 55,
    safeArea: { top: 0, right: 44, bottom: 21, left: 44 },
    restingSafeBottom: 21,
    keyboardOpen: false,
    width: 480,
  });
  expect(landscape.cardLeft).toBe(52);
  expect(landscape.cardRight).toBe(52);
  expect(landscape.rowExtraLeft).toBe(0);
  expect(landscape.rowExtraRight).toBe(0);
  expect(landscape.cardBottom).toBe(27);
});

test("ultra-narrow viewports (< 320 pt) cap side padding so chips and buttons keep fitting", () => {
  const narrow = computeDockedComposerInsets({
    desktop: false,
    cornerRadius: 62,
    safeArea: ZERO_SAFE,
    restingSafeBottom: 0,
    keyboardOpen: false,
    width: 300,
  });
  expect(narrow.cardLeft + narrow.rowExtraLeft).toBe(12);
  expect(narrow.cardRight + narrow.rowExtraRight).toBe(12);
});
