/**
 * Opens an external `http://` or `https://` link from conversation output:
 * - On desktop when Settings › Behavior › External links is `"webview"` (the default), opens it in
 *   the in-app WebView pane (`runtime.openWeb`).
 * - Otherwise (when set to `"browser"`, or on the phone/hosted web build), hands it to the system
 *   default browser via NSH's `openUrl`.
 */
import { openUrl, platform } from "nsh";
import { normalizeWebUrl } from "../m/workbench/external-link-open.ts";
import { externalLinkOpen } from "../m/workbench/external-link-open-store.svelte.ts";
import { runtime } from "../runtime";

export function openWebLink(rawUrl: string): void {
  const url = normalizeWebUrl(rawUrl);
  if (!url) return;
  if (platform.desktop && !runtime.hosted && externalLinkOpen.mode === "webview") {
    runtime.openWeb(url);
    return;
  }
  void openUrl(url).catch(() => undefined);
}
