/**
 * Phone-model-aware bottom corner clearance for docked mobile composers.
 *
 * A conversation on a phone has no bottom navigation bar under it, so the docked composer sits flush
 * against the display's bottom edge. Modern phones have large physical corner radii (36–62 pt),
 * and mobile browsers — especially Android Chrome with a hidden gesture pill or non-edge-to-edge
 * viewport — often report `safe-area-inset-bottom: 0`. With only 8 pt of horizontal card padding,
 * the leftmost (`+` / paperclip) and rightmost (`Send` / `✨` / `Stop`) 40×40 round buttons sit
 * right inside the curved corner glass.
 *
 * This module maps known phone models (from User-Agent Client Hints `model`, the UA string, or
 * iPhone logical screen dimensions) to their display bottom corner radius, then computes the
 * horizontal and bottom insets needed to keep the 40×40 buttons cleanly inside the rounded corners
 * while respecting `safeArea()` and capping on ultra-narrow viewports (`< 350 pt`).
 */

export type PhoneDeviceHints = {
  /** `navigator.userAgent` */
  userAgent?: string;
  /** High-entropy model from `navigator.userAgentData.getHighEntropyValues(["model"])`. */
  model?: string;
  /** `navigator.userAgentData?.platform` or `navigator.platform`. */
  platform?: string;
  /** Logical screen width (`screen.width`) in CSS px. */
  screenWidth?: number;
  /** Logical screen height (`screen.height`) in CSS px. */
  screenHeight?: number;
  /** `window.devicePixelRatio`. */
  devicePixelRatio?: number;
};

export type SafeAreaEdges = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type ComposerInsets = {
  /** Bottom padding on the docked composer card (pt). */
  cardBottom: number;
  /** Left padding on the docked composer card (pt, includes `safeArea.left`). */
  cardLeft: number;
  /** Right padding on the docked composer card (pt, includes `safeArea.right`). */
  cardRight: number;
  /** Extra left padding on the bottom tool row inside the card (pt). */
  rowExtraLeft: number;
  /** Extra right padding on the bottom tool row inside the card (pt). */
  rowExtraRight: number;
};

/** Default card horizontal padding (`px-2`) and vertical padding (`py-[6px]`). */
export const COMPOSER_CARD_BASE_X = 8;
export const COMPOSER_CARD_BASE_BOTTOM = 6;

/** Half of a mobile composer tool button (`40×40` circle). */
const BUTTON_RADIUS = 20;
/** Target visual breathing room between the 40×40 circular button rim and the curved corner glass. */
const CORNER_CLEARANCE = 9;
/** Minimum side inset from screen edge on flat-corner phones (iPhone SE, boxy Ultra, etc.). */
const MIN_FLAT_PHONE_SIDE = 12;
/** Minimum side inset from screen edge on rounded-corner phones even when `safeArea.bottom` is large. */
const MIN_ROUNDED_PHONE_SIDE = 16;
/** Upper bound on corner-driven side inset so the tool row never feels pinched. */
const MAX_CORNER_SIDE = 26;

/** Known iPhone logical screen dimensions (`min × max` in pt) mapped to display corner radius (pt). */
const IPHONE_CORNER_RADIUS: ReadonlyArray<{ min: number; max: number; dpr?: number; radius: number }> = [
  // iPhone 16 Pro Max / 17 Pro Max
  { min: 440, max: 956, radius: 62 },
  // iPhone 16 Pro / 17 / 17 Pro
  { min: 402, max: 874, radius: 62 },
  // iPhone 17 Air (420×912)
  { min: 420, max: 912, radius: 55 },
  // iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus
  { min: 430, max: 932, radius: 55 },
  // iPhone 14 Pro / 15 / 15 Pro / 16
  { min: 393, max: 852, radius: 55 },
  // iPhone 12 Pro Max / 13 Pro Max / 14 Plus
  { min: 428, max: 926, radius: 53 },
  // iPhone 12 / 12 Pro / 13 / 13 Pro / 14 / 16e
  { min: 390, max: 844, radius: 47 },
  // iPhone XR / 11 / XS Max / 11 Pro Max
  { min: 414, max: 896, radius: 42 },
  // iPhone X / XS / 11 Pro / 12 mini / 13 mini
  { min: 375, max: 812, radius: 42 },
  // Home-button iPhones (SE 2/3, 6/7/8, Plus, SE 1) — square display corners
  { min: 375, max: 667, radius: 0 },
  { min: 414, max: 736, radius: 0 },
  { min: 320, max: 568, radius: 0 },
];

/**
 * Android hardware model patterns mapped to typical physical display bottom corner radius (dp).
 * Ordered most-specific first (e.g., boxy Galaxy S22–S24 Ultra before general Galaxy S series;
 * Pixel 9/10 before earlier Pixels).
 */
const ANDROID_MODEL_RADIUS: ReadonlyArray<{ pattern: RegExp; radius: number }> = [
  // Boxy / sharp-cornered phones (Galaxy S22/S23/S24 Ultra, Note 20 Ultra, Sony Xperia, RedMagic)
  { pattern: /\b(?:SM-S908|SM-S918|SM-S928|SM-N986)[A-Z0-9]*\b/i, radius: 8 },
  { pattern: /\b(?:XQ-[A-Z]{2}\d{2}|SO-\d{2}[A-Z]|SOG\d{2}|NX7\d{2}[A-Z]?)\b/i, radius: 8 },
  // Samsung Galaxy S25 Ultra (returned to rounded corners) & Galaxy S / Z / A series
  { pattern: /\bSM-(?:S938|S9[0-9]{2}|G99\d|F7\d{2}|F9\d{2}|A[35]\d{2})[A-Z0-9]*\b/i, radius: 36 },
  { pattern: /\bGalaxy\b/i, radius: 36 },
  // Google Pixel 9 / 10 / 11+ (larger display corner radius ~48dp)
  { pattern: /\bPixel\s*(?:9|1[0-9])\b/i, radius: 48 },
  // Google Pixel 6 / 7 / 8 / Fold (~38dp)
  { pattern: /\bPixel\s*(?:[6-8]|Fold)\b/i, radius: 38 },
  // Older Google Pixel 2–5
  { pattern: /\bPixel\s*[2-5]\b/i, radius: 24 },
  // Xiaomi / Redmi / POCO flagships & modern HyperOS phones (4-digit YYMM + 4–5 char code + C/G/I/N, or brand name)
  { pattern: /\b(?:Xiaomi|Redmi|POCO|MIX)\b/i, radius: 48 },
  { pattern: /\b2[3-9](?:0[1-9]|1[0-2])[0-9A-Z]{4,5}[CGIN]\b/i, radius: 48 },
  { pattern: /\b(?:22\d{2}[0-9A-Z]{4,5}[CGIN]|M21\d{2}[A-Z]\d+[CGIN]?)\b/i, radius: 44 },
  // Huawei Mate / Pura / Nova & Honor Magic series (large curved/rounded bottom corners)
  { pattern: /\b(?:HUAWEI|HONOR)\b/i, radius: 48 },
  { pattern: /\b(?:ALN|BRA|DCO|HBN|HBK|BKY|PLR|CFR|CFS|VLI|PGT|BVL|PTP|FLC|MGA|REA)-[A-Z0-9]+\b/i, radius: 48 },
  // OPPO Find / Reno, OnePlus, Realme (large rounded corners ~46dp)
  { pattern: /\b(?:OPPO|OnePlus|realme)\b/i, radius: 46 },
  { pattern: /\b(?:CPH2\d{3}|PJD\d{3}|PJZ\d{3}|PK[BCDH]\d{3}|PGEM\d{2}|PH[YZ]\d{3}|PL[BCDE]\d{3}|RMX\d{4})\b/i, radius: 46 },
  // vivo X / S / iQOO series (~46dp)
  { pattern: /\b(?:vivo|iQOO)\b/i, radius: 46 },
  { pattern: /\b(?:V2[3-9]\d{2}[A-Z]?|PD2[3-9]\d{2})\b/i, radius: 46 },
  // Nothing Phone (~44dp)
  { pattern: /\b(?:Nothing|A059|A063|A065|A142)\b/i, radius: 44 },
  // Motorola / Lenovo (~38dp)
  { pattern: /\b(?:moto|motorola|XT2\d{3})\b/i, radius: 38 },
];

/** Extracts an Android hardware model token from `hints.model` or a non-reduced Android UA string. */
export function extractPhoneModel(hints: PhoneDeviceHints): string | null {
  const hinted = hints.model?.trim();
  if (hinted && hinted !== "K") return hinted;
  const ua = hints.userAgent ?? "";
  const match = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/|[;)])/i.exec(ua);
  const parsed = match?.[1]?.trim();
  // Chrome UA reduction replaces the model with literal "K".
  if (!parsed || parsed === "K" || /^(?:wv|Mobile|U)$/i.test(parsed)) return null;
  return parsed;
}

function screenPair(hints: PhoneDeviceHints): { min: number; max: number; aspect: number } | null {
  const w = hints.screenWidth ?? 0;
  const h = hints.screenHeight ?? 0;
  if (w <= 0 || h <= 0) return null;
  const min = Math.round(Math.min(w, h));
  const max = Math.round(Math.max(w, h));
  return { min, max, aspect: max / min };
}

/**
 * Estimates the physical display bottom corner radius in CSS points for a phone.
 * Returns `0` for square-cornered phones (e.g., iPhone SE) and falls back to a safe modern
 * rounded-corner estimate (`44 pt`) for tall-aspect-ratio phones whose exact model is hidden.
 */
export function estimatePhoneCornerRadius(hints: PhoneDeviceHints): number {
  const ua = hints.userAgent ?? "";
  const screen = screenPair(hints);

  // iPhone: screen logical dimensions identify the exact generation reliably even with frozen UA.
  if (/\biPhone\b/i.test(ua)) {
    if (screen) {
      const exact = IPHONE_CORNER_RADIUS.find((entry) => Math.abs(entry.min - screen.min) <= 1 && Math.abs(entry.max - screen.max) <= 1);
      if (exact) return exact.radius;
      if (screen.aspect >= 1.95) return 55;
      return 0;
    }
    return 47;
  }

  // Android: check high-entropy client-hints model or parsed UA model against known families.
  const model = extractPhoneModel(hints);
  if (model) {
    const matched = ANDROID_MODEL_RADIUS.find((entry) => entry.pattern.test(model));
    if (matched) return matched.radius;
  }

  // Fallback by screen aspect ratio (modern edge-to-edge rounded phones are ~19.5:9 to 21:9).
  if (screen) {
    if (screen.aspect >= 1.95) return 44;
    if (screen.aspect >= 1.72) return 24;
    return 8;
  }

  // Unknown mobile touch device without screen info: safe moderate-large rounded default.
  return 44;
}

/**
 * Geometric horizontal inset (pt from screen edge) needed so a 40×40 circular button sitting at
 * `bottomClearance` pt above the bottom edge clears a corner arc of radius `cornerRadius` pt by at
 * least `CORNER_CLEARANCE` pt.
 */
export function cornerSideInset(cornerRadius: number, bottomClearance: number): number {
  if (cornerRadius <= 12) return MIN_FLAT_PHONE_SIDE;
  const effective = cornerRadius - BUTTON_RADIUS - CORNER_CLEARANCE;
  if (effective <= 0) return MIN_ROUNDED_PHONE_SIDE;
  const dy = Math.max(0, cornerRadius - (bottomClearance + BUTTON_RADIUS));
  const maxDx = dy >= effective ? 0 : Math.sqrt(effective * effective - dy * dy);
  const geometric = Math.ceil(cornerRadius - BUTTON_RADIUS - maxDx);
  return Math.min(MAX_CORNER_SIDE, Math.max(MIN_ROUNDED_PHONE_SIDE, geometric));
}

/**
 * Caps side inset on ultra-narrow viewports (Android split-screen, fold cover screens, or narrow
 * test viewports < 350 pt) so chips and action buttons never crowd each other out.
 */
function capSideForWidth(side: number, viewportWidth: number): number {
  if (viewportWidth <= 0 || viewportWidth >= 350) return side;
  if (viewportWidth < 320) return Math.min(side, MIN_FLAT_PHONE_SIDE);
  return Math.min(side, MIN_ROUNDED_PHONE_SIDE);
}

/** Minimum resting bottom padding when `safeArea.bottom` is 0 on a rounded-corner phone. */
function cornerFloorBottom(cornerRadius: number): number {
  if (cornerRadius >= 60) return 14;
  if (cornerRadius >= 50) return 12;
  if (cornerRadius >= 32) return 10;
  return COMPOSER_CARD_BASE_BOTTOM;
}

/**
 * Computes docked composer card and tool-row insets for a mobile or desktop viewport.
 *
 * - On desktop (`desktop === true`), returns the untouched base card padding (`8` horizontal, `6`
 *   bottom, `0` extra row padding) even when a desktop window is narrowed into docked mode.
 * - On a phone (`desktop === false`):
 *   - Bottom padding respects `safeArea.bottom` (and adds a small floor on rounded-corner phones
 *     when the browser reports `safeArea.bottom === 0`), collapsing cleanly to `6 pt` while the
 *     software keyboard is open (`keyboardOpen === true`).
 *   - Horizontal tool-row padding adapts to the phone model's corner radius and `restingSafeBottom`
 *     (never jumping sideways when the keyboard opens) while respecting landscape `safeArea.left` /
 *     `safeArea.right` without double-counting.
 */
export function computeDockedComposerInsets(options: {
  desktop: boolean;
  cornerRadius: number;
  safeArea: SafeAreaEdges;
  /** Resting `safeArea.bottom` observed while the keyboard is closed, so side padding stays steady while typing. */
  restingSafeBottom: number;
  keyboardOpen: boolean;
  /** Laid-out width of the composer container (pt). */
  width: number;
}): ComposerInsets {
  if (options.desktop) {
    return {
      cardBottom: COMPOSER_CARD_BASE_BOTTOM,
      cardLeft: COMPOSER_CARD_BASE_X,
      cardRight: COMPOSER_CARD_BASE_X,
      rowExtraLeft: 0,
      rowExtraRight: 0,
    };
  }

  const safeLeft = Math.max(0, Math.round(options.safeArea.left));
  const safeRight = Math.max(0, Math.round(options.safeArea.right));
  const safeBottom = Math.max(0, Math.round(options.safeArea.bottom));
  const restingSafe = Math.max(0, Math.round(options.restingSafeBottom));

  const floorBottom = cornerFloorBottom(options.cornerRadius);
  const restingBottom = Math.max(COMPOSER_CARD_BASE_BOTTOM + restingSafe, floorBottom);
  const cardBottom = options.keyboardOpen
    ? COMPOSER_CARD_BASE_BOTTOM
    : Math.max(COMPOSER_CARD_BASE_BOTTOM + safeBottom, floorBottom);

  const targetSide = capSideForWidth(cornerSideInset(options.cornerRadius, restingBottom), options.width);
  const cardLeft = COMPOSER_CARD_BASE_X + safeLeft;
  const cardRight = COMPOSER_CARD_BASE_X + safeRight;

  return {
    cardBottom,
    cardLeft,
    cardRight,
    rowExtraLeft: Math.max(0, targetSide - cardLeft),
    rowExtraRight: Math.max(0, targetSide - cardRight),
  };
}
