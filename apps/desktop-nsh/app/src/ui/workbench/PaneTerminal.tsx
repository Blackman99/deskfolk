/**
 * A terminal tab, for now: the spike's terminal (`src/Terminal.tsx` on a canvas, or the macOS
 * native view under `DESKFOLK_NATIVE_TERMINAL`) on the runtime's pty. The tab's own session when
 * it names one, else a new shell in the workspace, which the tab then remembers (`onBind`).
 *
 * Stands in for `TerminalView.svelte` until NSH's own `Terminal` (`nsh/base`, longbridge/nsh#1111)
 * ships in a pinned NSH; that port replaces this file. No tab row of sessions, no search, no copy
 * menu here.
 */
import { colorScheme, effect, signal, Text, untracked, View } from "nsh";
import { nativeTerminal } from "../../launch";
import { Terminal } from "../../native";
import { copy, runtime } from "../../runtime";
import { CanvasTerminal } from "../../Terminal";

export function PaneTerminal(props: { terminalId: string | null; onBind: (id: string | null) => void; onClose: () => void }) {
  const error = signal<string | null>(null);
  const opening = signal(false);
  const workspace = () => runtime.snapshot.settings.workspace_path;

  effect(() => {
    const cwd = workspace();
    if (props.terminalId || !cwd || untracked(opening)) return;
    const client = runtime.client;
    if (!client) return;
    opening.set(true);
    client
      .openTerminal(cwd, 30, 100)
      .then((terminal) => {
        props.onBind(terminal.id);
        void runtime.refreshTerminals();
      })
      .catch((e: unknown) => error.set(String(e)))
      .finally(() => opening.set(false));
  });

  return (
    <View class="flex-1 min-h-0 bg-pane">
      <If
        when={props.terminalId}
        else={
          <Text class="m-auto p-6 text-[13px] text-ink-muted text-center">
            {error() ?? (workspace() ? copy().terminal.open : copy().terminal.needsWorkspace)}
          </Text>
        }
      >
        {(id) =>
          nativeTerminal ? (
            <Terminal
              terminalId={id()}
              fontSize={13}
              dark={colorScheme() === "dark"}
              onExit={props.onClose}
              onError={(e: { message: string }) => error.set(e.message)}
              style={{ flex: 1 }}
            />
          ) : (
            <CanvasTerminal id={id()} onExit={props.onClose} />
          )
        }
      </If>
    </View>
  );
}
