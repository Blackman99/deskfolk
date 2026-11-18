/**
 * A terminal tab: a head saying where the shell is and how it is, with Stop, over NSH's own
 * `Terminal` (`src/NshTerminal.tsx`; the macOS native view under `--terminal native`) on the
 * runtime's pty. The tab's own session when it names one, else a new shell in the workspace, which
 * the tab then remembers (`onBind`).
 *
 * The tab is the shell: closing it ends the session (`ShellWorkbench.commitLayout`), so there is no
 * 结束会话 here. A shell that exits keeps its tab, its last screen and how it ended showing, until
 * the tab is closed.
 *
 * No tab row of sessions and no search here; selecting and copying are the terminal's own.
 */
import { colorScheme, effect, signal, Text, untracked, View } from "nsh";
import type { Terminal as TerminalRow } from "@real-bot/protocol";
import { nativeTerminal } from "../../launch";
import { statusLabel } from "../../m/overlays/terminals.ts";
import { Terminal } from "../../native";
import { NshTerminal } from "../../NshTerminal";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { tip } from "../tip";

export function PaneTerminal(props: { terminalId: string | null; onBind: (id: string | null) => void }) {
  const error = signal<string | null>(null);
  const opening = signal(false);
  const workspace = () => runtime.snapshot.settings.workspace_path;
  const row = (): TerminalRow | null => {
    const id = props.terminalId;
    return id ? (runtime.terminals.find((candidate) => candidate.id === id) ?? null) : null;
  };

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

  /** The shell ended: the runtime's event says how; reading the list again covers a missed one. */
  const exited = () => void runtime.refreshTerminals();

  const stop = (id: string) => {
    void runtime.client?.terminalSignal(id, "SIGINT").catch((e: unknown) => error.set(String(e)));
  };

  const head = (r: () => TerminalRow) => (
    <View testID="terminal-head" class="flex-row items-center gap-2 px-2 py-[6px] border-b border-line">
      {/* Where the shell is. The tab above names it; the path is what tells two apart. */}
      <View class="flex-1 shrink min-w-0 flex-row items-center gap-2">
        <Text testID="terminal-cwd" tooltip={tip(r().cwd)} class="shrink min-w-0 line-clamp-1 font-mono text-[12px] text-ink-muted">
          {r().cwd}
        </Text>
        <If when={statusLabel(r(), copy())}>{(label) => <Text testID="terminal-status" class="shrink-0 text-[11px] text-ink-muted opacity-75">{label()}</Text>}</If>
      </View>
      <If when={r().status === "live"}>
        <Button size="sm" variant="secondary" testID="terminal-stop" onPress={() => stop(r().id)}>
          {copy().terminal.stop}
        </Button>
      </If>
    </View>
  );

  return (
    <View class="flex-1 min-h-0 bg-pane">
      <If when={row()}>{(r) => head(r)}</If>
      <If when={error() && props.terminalId}>
        <Text testID="terminal-error" class="px-3 py-1 text-[12px] text-danger-text">
          {error()}
        </Text>
      </If>
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
              onExit={exited}
              onError={(e: { message: string }) => error.set(e.message)}
              style={{ flex: 1 }}
            />
          ) : (
            <NshTerminal id={id()} onExit={exited} />
          )
        }
      </If>
    </View>
  );
}
