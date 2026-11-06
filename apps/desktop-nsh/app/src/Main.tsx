/**
 * The window: the messenger's shell (`ui/shell/Shell.tsx`) on the runtime (`src/runtime.ts`).
 *
 * Two development checks open one of the spike's panes alone instead (`--pane terminal` for
 * `scripts/terminal-probe.ts` and the frame-rate probe, `--pane pdf` with `--pdf <path>`), until
 * the terminal moves to NSH's own and the probes follow it.
 */
import { effect } from "nsh";
import { initialPane, initialSession } from "./launch";
import { runtime } from "./runtime";
import { PdfPane, TerminalPane } from "./Tools";
import { Shell } from "./ui/shell/Shell";

export function Main() {
  runtime.start();
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
  return <Shell />;
}
