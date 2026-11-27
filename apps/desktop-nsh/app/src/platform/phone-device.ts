/**
 * Phone display geometry on the web: reads the browser's device hints (synchronously from
 * `navigator.userAgent` and `screen`, then refined asynchronously on Android Chrome via
 * `navigator.userAgentData.getHighEntropyValues(["model"])`) and turns them, together with NSH's
 * `safeArea()` and `keyboardFrame()`, into docked composer padding that keeps bottom buttons clear
 * of the phone's rounded corners (`m/chat/phone-corner.ts`).
 */
import { computed, keyboardFrame, platform, safeArea, signal, untracked } from "nsh";
import { computeDockedComposerInsets, estimatePhoneCornerRadius, type ComposerInsets, type PhoneDeviceHints } from "../m/chat/phone-corner";

type HighEntropyNavigator = Navigator & {
  userAgentData?: {
    platform?: string;
    mobile?: boolean;
    getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string; platform?: string }>;
  };
};

function readSyncHints(): PhoneDeviceHints {
  const nav = typeof navigator === "undefined" ? undefined : (navigator as HighEntropyNavigator);
  const scr = typeof screen === "undefined" ? undefined : screen;
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : undefined;
  return {
    userAgent: nav?.userAgent,
    platform: nav?.userAgentData?.platform ?? nav?.platform,
    screenWidth: scr?.width,
    screenHeight: scr?.height,
    devicePixelRatio: dpr,
  };
}

const deviceHints = signal<PhoneDeviceHints>(readSyncHints());
let clientHintsRequested = false;

/** Asks Chromium for the high-entropy Android model once (no-op elsewhere or when blocked). */
function requestModelHint(): void {
  if (clientHintsRequested || platform.desktop) return;
  clientHintsRequested = true;
  const nav = typeof navigator === "undefined" ? undefined : (navigator as HighEntropyNavigator);
  const uad = nav?.userAgentData;
  const getter = uad?.getHighEntropyValues;
  if (!uad || typeof getter !== "function") return;
  void getter
    .call(uad, ["model", "platform"])
    .then((values) => {
      const model = typeof values?.model === "string" ? values.model.trim() : "";
      const plat = typeof values?.platform === "string" ? values.platform.trim() : "";
      if (!model && !plat) return;
      deviceHints.set({
        ...untracked(deviceHints),
        ...(model ? { model } : {}),
        ...(plat ? { platform: plat } : {}),
      });
    })
    .catch(() => undefined);
}

/** Reactive display bottom corner radius estimate (pt) for the current phone. */
export const phoneCornerRadius = computed(() => (platform.desktop ? 0 : estimatePhoneCornerRadius(deviceHints())));

/** Last `safeArea().bottom` seen while the soft keyboard was closed, so horizontal padding stays steady while typing. */
let lastRestingSafeBottom = 0;

/** Reactive docked composer insets for a given composer width (`width` accessor, in pt). */
export function dockedComposerInsets(width: () => number): () => ComposerInsets {
  requestModelHint();
  return computed(() => {
    const kbOpen = keyboardFrame().height > 0;
    const safe = safeArea();
    if (!kbOpen) lastRestingSafeBottom = safe.bottom;
    return computeDockedComposerInsets({
      desktop: platform.desktop,
      cornerRadius: phoneCornerRadius(),
      safeArea: safe,
      restingSafeBottom: kbOpen ? lastRestingSafeBottom : safe.bottom,
      keyboardOpen: kbOpen,
      width: width(),
    });
  });
}

/** Non-docked mobile safe-area edges (e.g. a phone rotated to landscape, wider than 480 pt). */
export function floatingComposerSafeEdges(): { left: number; right: number; bottom: number } {
  if (platform.desktop) return { left: 0, right: 0, bottom: 0 };
  const safe = safeArea();
  return {
    left: Math.max(0, Math.round(safe.left)),
    right: Math.max(0, Math.round(safe.right)),
    bottom: keyboardFrame().height > 0 ? 0 : Math.max(0, Math.round(safe.bottom)),
  };
}
