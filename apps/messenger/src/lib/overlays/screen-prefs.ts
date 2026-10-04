/** The Mac screen page's choices, kept on this phone: trackpad mode and smooth mode. */
const KEYS = { trackpad: "real-bot-screen-trackpad", smooth: "real-bot-screen-smooth" } as const;

export type ScreenFlag = keyof typeof KEYS;

export function loadScreenFlag(name: ScreenFlag): boolean {
  if (typeof window === "undefined" || !window.localStorage) return false;
  try {
    return window.localStorage.getItem(KEYS[name]) === "1";
  } catch {
    return false;
  }
}

export function saveScreenFlag(name: ScreenFlag, on: boolean): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    if (on) window.localStorage.setItem(KEYS[name], "1");
    else window.localStorage.removeItem(KEYS[name]);
  } catch {
    // ignore
  }
}
