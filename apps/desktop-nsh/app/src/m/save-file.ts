import { isRasterImageName } from "./overlays/artifacts.ts";

/**
 * How a save ended. `needs-tap`: the share sheet refused a picture because the tap that asked for
 * it is spent (the bytes took too long to arrive); the bytes are here now, so the next tap goes
 * through. Any other file never ends this way.
 */
export type SaveOutcome = "saved" | "cancelled" | "needs-tap";

/** A phone or a tablet, where saving a picture means the share sheet. */
export function prefersShareSheet(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/** A picture, by its type, or by its name when the bytes came without one. */
function isPicture(blob: Blob, name: string): boolean {
  return blob.type.startsWith("image/") || isRasterImageName(name);
}

/**
 * Hand one file to the person. A picture on a touch device goes to the share sheet, when it takes
 * it: that is the only way a page reaches the photo library (its Save Image), and iOS silently
 * ignores a `download` link on a blob picture. Every other file, and everything off a touch
 * device, is a download, which needs no tap of its own and so goes through however long the
 * bytes took to arrive.
 *
 * The share sheet only opens during a tap. Called after an await that outlived the tap, it throws
 * NotAllowedError; that is `needs-tap`, not a failure, and nothing is downloaded in its place.
 */
export async function saveFile(blob: Blob, name: string, share = prefersShareSheet()): Promise<SaveOutcome> {
  if (share && isPicture(blob, name) && typeof navigator.share === "function") {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return "saved";
      } catch (error) {
        const reason = error instanceof DOMException ? error.name : "";
        if (reason === "AbortError") return "cancelled";
        if (reason === "NotAllowedError") return "needs-tap";
        throw error;
      }
    }
  }
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // Safari starts reading the blob after click() returns; revoking at once can cancel the download.
  setTimeout(() => URL.revokeObjectURL(href), 40_000);
  return "saved";
}
