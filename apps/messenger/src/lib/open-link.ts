import { isTauri, readTauriInternals, type TauriInternals } from "./tauri.ts";

/**
 * Open an external link (http:, https:, mailto:) safely.
 * In desktop Tauri, invokes `open_external_url` to open via system handler.
 * In browser or if Tauri invoke fails, opens via `window.open(..., '_blank')`.
 */
export async function openExternalLink(
  href: string,
  internals: TauriInternals | undefined = readTauriInternals(),
): Promise<boolean> {
  const trimmed = href.trim();
  if (!trimmed.startsWith("https:") && !trimmed.startsWith("http:") && !trimmed.startsWith("mailto:")) {
    return false;
  }

  if (isTauri(internals) && internals?.invoke) {
    try {
      await internals.invoke("open_external_url", { url: trimmed });
      return true;
    } catch {
      // Fall through to window.open if invoke failed
    }
  }

  if (typeof window !== "undefined" && typeof window.open === "function") {
    try {
      window.open(trimmed, "_blank", "noopener,noreferrer");
      return true;
    } catch {
      return false;
    }
  }

  return false;
}
