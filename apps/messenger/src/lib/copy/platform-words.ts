import { desktopPlatform } from "../platform.ts";

/**
 * Read once: the platform does not change while the app is running, and a handful of strings
 * in the copy modules (Finder/Explorer, Trash/Recycle Bin, Keychain/Credential Manager, …) need to know it.
 * Everything else in `zh`/`en` stays a plain string, unchanged from before Windows existed.
 */
export const isWindows = desktopPlatform() === "windows";
/** The word for the file manager and its trash, on this platform — used by a few `stream` strings. */
export const zhTrashWord = isWindows ? "回收站" : "废纸篓";
export const enTrashWord = isWindows ? "Recycle Bin" : "Trash";
export const enTrashOwner = isWindows ? "the" : "the Mac’s";
/** The OS name itself, where a string names it directly rather than something it owns. */
export const osName = isWindows ? "Windows" : "macOS";
/** The machine routines run on, where a routine hint names it: the Mac there, a plain computer on Windows. */
// The Chinese word carries the spaces that set a Latin name off from the characters around it.
export const zhHost = isWindows ? "电脑" : " Mac ";
export const enHost = isWindows ? "computer" : "Mac";
