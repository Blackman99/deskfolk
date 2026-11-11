/**
 * A terminal tab: a head saying where the shell is and how it is, with Stop and 结束会话 (the
 * workbench head of `TerminalView.svelte`), over the spike's terminal (`src/Terminal.tsx` on a
 * canvas; NSH's own `Terminal` under `--terminal nsh`, the macOS native view under
 * `--terminal native`) on the runtime's pty. The
 * tab's own session when it names one, else a new shell in the workspace, which the tab then
 * remembers (`onBind`).
 *
 * The tab's × only takes the shell off the screen; 结束会话 is what stops it, behind a second
 * press while it is running. A shell that exits keeps its tab, its last screen and how it ended
 * showing, until 结束会话 forgets it. Once the runtime drops the session the workbench drops the tab.
 *
 * The canvas terminal below the head stands in until NSH's own `Terminal` (`nsh/base`,
 * longbridge/nsh#1111, in the pinned NSH but behind `--terminal nsh`: `src/NshTerminal.tsx` says
 * what it lacks) can take its place; that swap keeps the head. No tab row of sessions, no search,
 * no copy menu here.
 */
import { colorScheme, effect, signal, Text, untracked, View } from "nsh";
import type { Terminal as TerminalRow } from "@real-bot/protocol";
import { nativeTerminal, nshTerminal } from "../../launch";
import { statusLabel } from "../../m/overlays/terminals.ts";
import { Terminal } from "../../native";
import { NshTerminal } from "../../NshTerminal";
import { copy, runtime } from "../../runtime";
import { CanvasTerminal } from "../../Terminal";
import { Button } from "../Button";
import { tip } from "../tip";

export function PaneTerminal(props: { terminalId: string | null; onBind: (id: string | null) => void }) {
  const error = signal<string | null>(null);
  const opening = signal(false);
  /** The session whose 结束会话 was pressed once while it ran; the second press ends it. */
  const arming = signal<string | null>(null);
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

  const end = async (id: string) => {
    arming.set(null);
    const client = runtime.client;
    if (!client) return;
    try {
      await client.closeTerminal(id);
      await runtime.refreshTerminals();
    } catch (e) {
      error.set(String(e));
    }
  };

  const head = (r: () => TerminalRow) => {
    const t = () => copy().terminal;
    return (
      <View testID="terminal-head" class="flex-row items-center gap-2 px-2 py-[6px] border-b border-line">
        {/* Where the shell is. The tab above names it; the path is what tells two apart. */}
        <View class="flex-1 shrink min-w-0 flex-row items-center gap-2">
          <Text testID="terminal-cwd" tooltip={tip(r().cwd)} class="shrink min-w-0 line-clamp-1 font-mono text-[12px] text-ink-muted">
            {r().cwd}
          </Text>
          <If when={statusLabel(r(), copy())}>{(label) => <Text testID="terminal-status" class="shrink-0 text-[11px] text-ink-muted opacity-75">{label()}</Text>}</If>
        </View>
        <View class="shrink-0 flex-row items-center gap-[6px]">
          <If when={r().status === "live"}>
            <Button size="sm" variant="secondary" testID="terminal-stop" onPress={() => stop(r().id)}>
              {t().stop}
            </Button>
          </If>
          <If
            when={arming() === r().id}
            else={
              <Button
                size="sm"
                variant="secondary"
                testID="terminal-end"
                onPress={() => {
                  if (r().status === "live") arming.set(r().id);
                  else void end(r().id);
                }}
              >
                {t().end}
              </Button>
            }
          >
            <Text testID="terminal-end-note" class="shrink-0 text-[12px] text-ink-muted">
              {t().endConfirm}
            </Text>
            <Button size="sm" variant="danger-soft" testID="terminal-end-confirm" onPress={() => void end(r().id)}>
              {t().end}
            </Button>
            <Button size="sm" variant="secondary" testID="terminal-end-cancel" onPress={() => arming.set(null)}>
              {copy().detail.cancel}
            </Button>
          </If>
        </View>
      </View>
    );
  };

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
          ) : nshTerminal ? (
            <NshTerminal id={id()} onExit={exited} />
          ) : (
            <CanvasTerminal id={id()} onExit={exited} />
          )
        }
      </If>
    </View>
  );
}
