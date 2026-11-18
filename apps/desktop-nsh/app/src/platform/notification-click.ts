/**
 * A banner clicked on macOS opens its conversation at once. The shell keeps the click's reference
 * for the messenger (`take_notification_intent`) and, as it brings the window forward, tells that
 * window (`shell.notification-click`, `host/src/app.rs`), which takes the reference and opens what
 * it names. Before, the window looked for a reference only on its five-second beat or as a Bot's
 * chat came to the front, and asked Notification Center for the permission first; a window already
 * in front, or one showing a project session, waited for the beat.
 *
 * The take is what counts: a reference goes once, so the beat finds nothing after it and does not
 * open the conversation again. A window still connecting leaves it for its first snapshot, which
 * looks as it lands (`connection-loop.svelte.ts`); taking it now would open the inbox instead.
 * Windows and Linux hear NSH's press in the app (`app-banners.ts` `onPressed`).
 */
import { host, platform } from "nsh";
import type { MessengerRuntime } from "../m/runtime.svelte.ts";

export type ClickDeps = {
  /** The window has the runtime's snapshot, so the reference can be looked up. */
  connected: () => boolean;
  /** The shell's `take_notification_intent`. */
  take: () => Promise<unknown>;
  /** Looks the reference up and opens its conversation (`handleDesktopNotificationIntent`). */
  open: (clickRef: string) => Promise<void>;
};

/** Takes the clicked banner's reference, if there is one and the window can use it, and opens it. */
export async function openClickedBanner(deps: ClickDeps): Promise<void> {
  if (!deps.connected()) return;
  const intent = await deps.take().catch(() => null);
  const clickRef = (intent as { clickRef?: unknown } | null)?.clickRef;
  if (typeof clickRef === "string" && clickRef) await deps.open(clickRef);
}

/** Listens for the shell's word for `runtime`, this window's; once per window, outside any component. */
export function installNotificationClick(runtime: Pick<MessengerRuntime, "connection" | "handleDesktopNotificationIntent">): void {
  if (platform.os !== "macos" || !host.available()) return;
  host.on("shell.notification-click", () => {
    void openClickedBanner({
      connected: () => runtime.connection === "connected",
      take: () => host.call("shell.take_notification_intent", null),
      open: (clickRef) => runtime.handleDesktopNotificationIntent(clickRef),
    });
  });
}
