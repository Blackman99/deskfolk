import { forgetStored, readStored, writeStored } from "../storage.ts";

/** The Mac screen page's choices, kept on this phone: trackpad mode and smooth mode (the screen shown: `screen-displays.ts`). */
const KEYS = { trackpad: "real-bot-screen-trackpad", smooth: "real-bot-screen-smooth" } as const;

export type ScreenFlag = keyof typeof KEYS;

export function loadScreenFlag(name: ScreenFlag): boolean {
  return readStored(KEYS[name]) === "1";
}

export function saveScreenFlag(name: ScreenFlag, on: boolean): void {
  if (on) writeStored(KEYS[name], "1");
  else forgetStored(KEYS[name]);
}
