import { inDesktopShell, readShellBridge, type ShellBridge } from "./desktop-shell.ts";

/**
 * Open an external link (http:, https:, mailto:) safely.
 * In the desktop shell, invokes `open_external_url` to open via system handler.
 * In browser or if the shell invoke fails, opens via `window.open(..., '_blank')`.
 */
export async function openExternalLink(
  href: string,
  internals: ShellBridge | undefined = readShellBridge(),
): Promise<boolean> {
  const trimmed = href.trim();
  if (!trimmed.startsWith("https:") && !trimmed.startsWith("http:") && !trimmed.startsWith("mailto:")) {
    return false;
  }

  if (inDesktopShell(internals) && internals?.invoke) {
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
