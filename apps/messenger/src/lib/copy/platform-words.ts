import { desktopPlatform } from "../platform.ts";

/**
 * Read once: the platform does not change while the app is running, and a handful of strings
 * in the copy modules (Finder/Explorer/file manager, Trash/Recycle Bin, Keychain/Credential
 * Manager/keyring, …) need to know it. Everything else in `zh`/`en` stays a plain string, unchanged
 * from before Windows existed. A browser tab (`other`) keeps the Mac's words, as it always has.
 */
const platform = desktopPlatform();
export const isWindows = platform === "windows";
export const isLinux = platform === "linux";
/** Neither Windows nor Linux: the Mac's own words (Finder, the Mac's Trash, Keychain). */
export const isMacHost = !isWindows && !isLinux;
/** The word for the file manager and its trash, on this platform — used by a few `stream` strings. */
export const zhTrashWord = isMacHost ? "废纸篓" : "回收站";
export const enTrashWord = isWindows ? "Recycle Bin" : "Trash";
export const enTrashOwner = isMacHost ? "the Mac’s" : "the";
/** The OS name itself, where a string names it directly rather than something it owns. */
export const osName = isWindows ? "Windows" : isLinux ? "Linux" : "macOS";
/** The machine routines run on, where a routine hint names it: the Mac there, a plain computer elsewhere. */
// The Chinese word carries the spaces that set a Latin name off from the characters around it.
export const zhHost = isMacHost ? " Mac " : "电脑";
export const enHost = isMacHost ? "Mac" : "computer";
