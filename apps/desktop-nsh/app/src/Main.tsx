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
import { effect, platform, signal } from "nsh";
import { Window } from "nsh/desktop";
import { initialPane, initialSession } from "./launch";
import { runtime } from "./runtime";
import { PdfPane, TerminalPane } from "./Tools";
import { PairingScreen } from "./ui/remote/PairingScreen";
import { ConnectionScreen } from "./ui/shell/ConnectionScreen";
import { Shell } from "./ui/shell/Shell";
import { warmCodeColors } from "./ui/code-colors";

export function Main() {
  // On Windows the window's controls go into the app as on macOS: no title bar of the system's, the
  // caption buttons drawn over the top right (`titleBar().right`), the top rows' empty space dragging.
  if (platform.os === "windows") Window.setTitleBar({ style: "hidden" });
  runtime.start();
  // The code colours' grammars and themes, read while the runtime connects.
  warmCodeColors();
  // What start-up checks wait for (scripts/ci-smoke.ts, package.ts --measure): the first snapshot.
  let announced = false;
  effect(() => {
    if (announced || runtime.connection !== "connected") return;
    announced = true;
    console.log(`ready: ${runtime.snapshot.sessions.length} conversations`);
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
  const shell = (
    <If when={shellShown()} else={<ConnectionScreen />}>
      <Shell />
    </If>
  );
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
