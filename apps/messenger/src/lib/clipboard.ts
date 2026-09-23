import { isTauri, readTauriInternals, type TauriInternals } from "./tauri.ts";

/**
 * Pixels of one rendered picture as PNG. A PNG blob is kept; GIF, WebP, JPEG, BMP and SVG are
 * drawn once and encoded, so an animation contributes the frame that decoded. A picture that
 * never decoded throws.
 */
export async function clipboardImageBlob(source: Blob): Promise<Blob> {
  const type = source.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/png") return source;
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image failed to decode"));
    });
    image.src = url;
    await loaded;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error("image has no pixels");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(image, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("png encode failed");
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Put the picture at `src` on the clipboard as PNG.
 *
 * `clipboard.write` has to start in the same turn as the click: WebKit drops a write that waits
 * on `fetch` first. The bytes are a promise inside the `ClipboardItem`, so this function must be
 * called directly from the menu action.
 */
/** Read a rendered picture's bytes. `blob:` and `data:` are both fetched; the browser serves them locally. */
export async function readRenderedImage(src: string): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error("image fetch failed");
  return res.blob();
}

export function copyRenderedImage(src: string): Promise<void> {
  if (!src) return Promise.reject(new Error("no image"));
  if (!navigator.clipboard?.write) return Promise.reject(new Error("clipboard unavailable"));
  const png = readRenderedImage(src).then((blob) => clipboardImageBlob(blob));
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export function copyText(text: string): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    // ignore
  }
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }
}

/**
 * The clipboard's text, for a Paste picked from a menu of ours rather than the Edit menu.
 *
 * In the desktop window it comes from the pasteboard itself: WebKit's `readText` stops for a
 * second confirming click, and a terminal's Paste never asks twice. Elsewhere that reader is all
 * there is. Resolves to "" when nothing readable is there.
 */
export async function readClipboardText(internals: TauriInternals | undefined = readTauriInternals()): Promise<string> {
  if (isTauri(internals) && internals?.invoke) {
    try {
      const text = await internals.invoke("read_clipboard_text");
      return typeof text === "string" ? text : "";
    } catch {
      // An older window without the command falls through to the page's reader.
    }
  }
  try {
    return (await navigator.clipboard?.readText?.()) ?? "";
  } catch {
    return "";
  }
}
