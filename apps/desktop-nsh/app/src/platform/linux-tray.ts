/**
 * The tray on Linux (a StatusNotifierItem, NSH's `Tray`; GNOME shows it with the AppIndicator
 * extension), with what the Tauri app's Linux tray had and the macOS and Windows trays have: what
 * is used of your plans (the shell's `shell.trayLines`, the same lines as `usage_tray.rs` makes,
 * text only: Linux panels draw no icons in a tray's menu), then Show, Stop Everything (while the
 * runtime answers) and Quit. A click on the icon shows the window.
 *
 * Read once a minute, as the other trays are; the menu is set again when its lines change.
 */
import { effect, host, platform, signal } from "nsh";
import { Application, currentWindow, Tray } from "nsh/desktop";
import { runtime } from "../runtime";

type Line = { text: string; all: boolean };

/** The tray's menu, from the usage lines and whether the runtime answers. */
export function trayMenu(lines: readonly Line[], connected: boolean, actions: { show: () => void; usage: () => void; stop: () => void; quit: () => void }) {
  const usage = lines.map((line) => ({ label: line.text, onSelect: line.all ? actions.usage : actions.show }));
  return [
    ...usage,
    usage.length > 0 && { type: "separator" as const },
    { label: "Show Deskfolk", onSelect: actions.show },
    { label: "Stop Everything", disabled: !connected, onSelect: actions.stop },
    { type: "separator" as const },
    { label: "Quit Deskfolk", onSelect: actions.quit },
  ];
}

export function installLinuxTray(): void {
  if (platform.os !== "linux" || !host.available()) return;
  const lines = signal<Line[]>([]);
  const read = () =>
    void host
      .call<Line[]>("shell.trayLines")
      .then((next) => lines.set(Array.isArray(next) ? next : []))
      .catch(() => undefined);
  read();
  setInterval(read, 60_000);
  // Taken now, while the window renders: NSH reads `currentWindow()` only then, not in a menu's handler.
  const window = currentWindow();
  const show = () => window.focus();
  effect(() => {
    Tray.set({
      tooltip: "Deskfolk",
      onClick: show,
      menu: trayMenu(lines(), runtime.connection === "connected", {
        show,
        usage: () => {
          show();
          void runtime.openUsage();
        },
        stop: () => void host.call("shell.stopAll").catch(() => undefined),
        quit: () => Application.quit(),
      }),
    });
  });
}
