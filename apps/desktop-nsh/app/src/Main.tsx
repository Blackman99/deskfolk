/**
 * The window: the messenger's shell (`ui/shell/Shell.tsx`) on the runtime (`src/runtime.ts`).
 * The hosted build (`Hosted.tsx`, the phone's page) shows the pairing screen until this device is
 * enrolled, as the messenger's `+page.svelte` does, then the same shell on the remote client.
 *
 * As there too, the shell waits for the first connection behind `ConnectionScreen` (connecting, or
 * unreachable with a Retry): before it the snapshot is the empty one, whose settings say the
 * first-run onboarding is not done, and every start showed the onboarding for a moment. Once the
 * shell has been up it stays through a lost connection.
 *
 * Two development checks open one of the spike's panes alone instead (`--pane terminal` for
 * `scripts/terminal-probe.ts` and the frame-rate probe, `--pane pdf` with `--pdf <path>`), until
 * the terminal moves to NSH's own and the probes follow it.
 */
import { effect, platform, signal, View } from "nsh";
import { initialPane, initialSession, windowId } from "./launch";
import { appBanners } from "./platform/app-banners";
import { installLinuxTray } from "./platform/linux-tray";
import { linuxWheelProps } from "./platform/wheel";
import { installWindowLife } from "./platform/window-life";
import { runtime } from "./runtime";
import { PdfPane, TerminalPane } from "./Tools";
import { PairingScreen } from "./ui/remote/PairingScreen";
import { ConnectionScreen } from "./ui/shell/ConnectionScreen";
import { Shell } from "./ui/shell/Shell";
import { warmCodeColors } from "./ui/code-colors";

export function Main() {
  // On Windows the window's controls go into the app as on macOS: no title bar of the system's, the
  // caption buttons drawn over the top right (`titleBar().right`), the top rows' empty space dragging.
  // The shell opens the window that way (`host/src/win.rs`), with Mica behind it where there is some.
  runtime.start();
  // Windows and Linux: the app shows the banners (`platform/app-banners.ts`), in the first window
  // only, as the macOS shell runs one loop for the process; a press opens its conversation now.
  const banners = windowId <= 1 ? appBanners() : null;
  if (banners) {
    // Listening first: a press that started the app comes as the loop starts listening to NSH.
    banners.onPressed(() => void runtime.pollDesktopNativeState());
    banners.start();
  }
  // Windows and Linux: the close button puts the window away, the tray's Quit ends the app
  // (`platform/window-life.ts`), as in 0.4.0.
  if (windowId <= 1) installWindowLife();
  // Linux: the tray is the app's (`platform/linux-tray.ts`).
  if (windowId <= 1) installLinuxTray();
  // The code colours' grammars and themes, read while the runtime connects.
  warmCodeColors();
  // What start-up checks wait for (scripts/ci-smoke.ts, package.ts --measure): the first snapshot;
  // and every later connection after a lost one (package.ts --smoke: a runtime started again comes
  // with a new token, which the window has to pick up).
  let announced = false;
  let connected = false;
  effect(() => {
    const now = runtime.connection === "connected";
    if (now && !connected) {
      console.log(announced ? "reconnected" : `ready: ${runtime.snapshot.sessions.length} conversations`);
      announced = true;
    }
    connected = now;
  });
  const wanted = initialSession;
  if (wanted) {
    let opened = false;
    effect(() => {
      if (opened || runtime.connection !== "connected") return;
      opened = true;
      void runtime.selectSession(wanted);
    });
  }
  if (initialPane === "terminal") return <TerminalPane />;
  if (initialPane === "pdf") return <PdfPane />;
  // Set at the first connection (the first snapshot is in by then) and never unset.
  const shellShown = signal(false);
  effect(() => {
    if (runtime.connection === "connected") shellShown.set(true);
  });
  const shown = (
    <If when={shellShown()} else={<ConnectionScreen />}>
      <Shell />
    </If>
  );
  // Linux: the wheel the shell does not forward, heard here (`platform/wheel.ts`).
  const shell = platform.os === "linux" ? <View class="flex-1" {...linuxWheelProps}>{shown}</View> : shown;
  if (runtime.hosted) {
    // Not enrolled is not a connection problem: this device has nothing to connect with yet.
    const pairing = () => runtime.connection !== "connected" && !runtime.enrolled;
    return (
      <If when={pairing()} else={shell}>
        <PairingScreen />
      </If>
    );
  }
  return shell;
}
