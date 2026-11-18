/**
 * The window: the messenger's shell (`ui/shell/Shell.tsx`) on the runtime (`src/runtime.ts`).
 * The hosted build (`Hosted.tsx`, the phone's page) shows the pairing screen until this device is
 * enrolled, as the messenger's `+page.svelte` does, then the same shell on the remote client; over
 * either, the notice of a newer build on the relay (`platform/page-build.ts`).
 *
 * As there too, the shell waits for the first connection behind `ConnectionScreen` (connecting, or
 * unreachable with a Retry): before it the snapshot is the empty one, whose settings say the
 * first-run onboarding is not done, and every start showed the onboarding for a moment. Once the
 * shell has been up it stays through a lost connection; hosted, faded under `OfflineBanner`.
 *
 * Hosted, the page's address follows what is open and Back walks it (`platform/page-route.ts`),
 * and another tab of the page holding the device's link puts this one on `TabStandbyScreen`.
 *
 * Two development checks open one of the spike's panes alone instead (`--pane terminal` for
 * `scripts/terminal-probe.ts` and the frame-rate probe, `--pane pdf` with `--pdf <path>`), until
 * the terminal moves to NSH's own and the probes follow it.
 */
import { effect, platform, signal, View } from "nsh";
import { initialPane, initialSession, windowId } from "./launch";
import { appBanners } from "./platform/app-banners";
import { installLinuxTray } from "./platform/linux-tray";
import { installNotificationClick } from "./platform/notification-click";
import { pageBuildUpdates, reloadPage } from "./platform/page-build";
import { pageRoute } from "./platform/page-route-install";
import { linuxWheelProps } from "./platform/wheel";
import { installWindowLife } from "./platform/window-life";
import { runtime } from "./runtime";
import { PdfPane, TerminalPane } from "./Tools";
import { BuildUpdateNotice } from "./ui/BuildUpdateNotice";
import { PairingScreen } from "./ui/remote/PairingScreen";
import { ConnectionScreen, OfflineBanner, TabStandbyScreen } from "./ui/shell/ConnectionScreen";
import { Shell } from "./ui/shell/Shell";
import { warmCodeColors } from "./ui/code-colors";

export function Main() {
  // On Windows the window's controls go into the app as on macOS: no title bar of the system's, the
  // caption buttons drawn over the top right (`titleBar().right`), the top rows' empty space dragging.
  // The shell opens the window that way (`host/src/win.rs`), with Mica behind it where there is some.
  // The phone's page: what the address names opens, and the address follows what is open
  // (`platform/page-route.ts`). Seeded before the runtime connects, as the Svelte page does.
  const route = runtime.hosted ? pageRoute() : null;
  route?.seed();
  runtime.start();
  route?.install();
  // Windows and Linux: the app shows the banners (`platform/app-banners.ts`), in the first window
  // only, as the macOS shell runs one loop for the process; a press opens its conversation now.
  const banners = windowId <= 1 ? appBanners() : null;
  if (banners) {
    // Listening first: a press that started the app comes as the loop starts listening to NSH.
    banners.onPressed(() => void runtime.pollDesktopNativeState());
    banners.start();
  }
  // macOS: the shell tells the window it brings forward for a clicked banner, which opens the
  // conversation now (`platform/notification-click.ts`).
  installNotificationClick(runtime);
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
      <View class="flex-1">
        <Shell />
        {/* The phone's page for now: the desktop window's veil would also cover its drag region. */}
        <If when={runtime.hosted}>
          <OfflineBanner />
        </If>
      </View>
    </If>
  );
  // Linux: the wheel the shell does not forward, heard here (`platform/wheel.ts`).
  const shell = platform.os === "linux" ? <View class="flex-1" {...linuxWheelProps}>{shown}</View> : shown;
  if (runtime.hosted) {
    // Not enrolled is not a connection problem: this device has nothing to connect with yet.
    const pairing = () => runtime.connection !== "connected" && !runtime.enrolled;
    // Another tab of the page holds the device's link: this one waits, over the shell if it was up.
    const page = (
      <If when={pairing()} else={<If when={runtime.tabRole === "standby"} else={shell}><TabStandbyScreen /></If>}>
        <PairingScreen />
      </If>
    );
    // The phone keeps the page open for days: a newer build on the relay is offered, never forced.
    const updates = pageBuildUpdates();
    if (!updates) return page;
    updates.start();
    return (
      <View class="flex-1">
        {page}
        <BuildUpdateNotice updates={updates} onReload={reloadPage} />
      </View>
    );
  }
  return shell;
}
