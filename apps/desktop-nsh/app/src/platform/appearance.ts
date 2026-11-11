/**
 * The window's look: the app's (`setColorScheme`, which NSH puts on its own views) and, on macOS,
 * the shell window's around it (`shell.appearance`, `host/src/window.rs`). There the window and
 * the system material under the app are the shell's, not NSH's: left alone they kept the system's
 * look, so with the system in Dark a light app sat on dark glass, its grey ink on grey. The other
 * desktops' windows are NSH's own and follow `setColorScheme` already.
 */
import { host, platform, setColorScheme } from "nsh";

export type WindowLook = "light" | "dark" | "system";

/** What the shell's window was last told; the setting's effect runs on every snapshot. */
let told: WindowLook | null = null;

export function setLook(look: WindowLook): void {
  setColorScheme(look);
  if (look === told || platform.os !== "macos" || !host.available()) return;
  told = look;
  // A shell from before `shell.appearance` refuses it; the app's own look is set either way.
  void Promise.resolve()
    .then(() => host.call("shell.appearance", look === "system" ? null : look))
    .catch(() => undefined);
}
