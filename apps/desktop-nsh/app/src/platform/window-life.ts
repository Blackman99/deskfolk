/**
 * The window's close button on Windows and Linux, as 0.4.0 had it: it puts the window away
 * and the app keeps running in the notification area (the tray on Linux), the runtime and the
 * Bots' work with it. The tray's Quit and a later launch with `--quit` end the app (on Linux Ctrl+Q
 * too). A close the system asks for (logging out, shutting down) still closes. On the Mac the app
 * stays in the menu bar on its own: closing its last window never quits it there.
 *
 * Without a tray to bring the window back from (Linux's GNOME without the AppIndicator extension:
 * the shell says so in `host.params.trayShown`), the close button minimizes it instead, so it is
 * never put where nothing reaches it.
 */
import { host, platform } from "nsh";
import { Application, currentWindow } from "nsh/desktop";
import { keepDesktopWindow } from "./desktop-commands";

/** What the close button does here (`installWindowLife`). */
export function closeAction(os: string, trayShown: boolean, reason: string): "quit" | "hide" | "minimize" | "close" {
  if (os !== "windows" && os !== "linux") return "close";
  if (reason === "system") return "quit";
  return trayShown ? "hide" : "minimize";
}

/** Whether a later launch asks the running copy to quit (`Deskfolk --quit`, as the smoke checks and the installers do). */
export function asksToQuit(args: readonly string[]): boolean {
  return args.includes("--quit");
}

/**
 * Whether this copy was launched only to end the running one (`--quit`, `host/src/launch.rs`) and
 * found none: it has nothing to show or keep and ends as it starts.
 */
export function launchedToQuit(params: { quit?: unknown }): boolean {
  return params.quit === true;
}

export function installWindowLife(): void {
  if (platform.os !== "windows" && platform.os !== "linux") return;
  if (!host.available()) return;
  const params = host.params as { trayShown?: boolean; quit?: unknown };
  if (launchedToQuit(params)) {
    // After this first render: the run ends from the loop, not from inside it.
    setTimeout(() => Application.quit(), 0);
    return;
  }
  const trayShown = platform.os === "windows" || params.trayShown === true;
  const window = currentWindow();
  keepDesktopWindow(window);
  window.set({ closeOnPress: false });
  window.on("closePress", ({ reason }) => {
    switch (closeAction(platform.os, trayShown, reason)) {
      case "quit":
        Application.quit();
        break;
      case "hide":
        window.hide();
        break;
      case "minimize":
        window.minimize();
        break;
      case "close":
        window.close();
        break;
    }
  });
  // The tray's Quit (`win_tray.rs`, the Linux tray), and a later launch with `--quit`.
  host.on("shell.quit", () => Application.quit());
  Application.on("secondInstance", ({ args }) => {
    if (asksToQuit(args)) Application.quit();
  });
}
