/**
 * The terminal on a phone, and in a window too narrow for the workbench: one page over the list
 * (`TerminalView.svelte`'s phone page). Opening it reattaches to a shell that is already there —
 * the one it showed last, else the newest one still running (`pageTerminal`) — and only when none
 * runs does it start one in the workspace, once. Leaving the page never ends a session: on the
 * desktop a tab is its shell, here the page is only a view of the shells the Mac holds.
 *
 * The head has Back, the session's name and folder, and + for a new shell. The name opens the list
 * of sessions, to switch to another or end one: a finished shell at once, a running one after a
 * second press. Under the terminal are the keys a soft keyboard lacks (`TERMINAL_KEY_ROWS`): Ctrl
 * latches for the next key, from the bar or the keyboard; the arrows and Paste follow the modes the
 * program asked for.
 *
 * The terminal shows only while the link is up, so a link that comes back reads the screen again
 * instead of leaving out what went past while it was down. The page stays above the soft keyboard
 * (`keyboardFrame`), so the key bar is there while you type.
 */
import { cleanup, Clipboard, effect, Keyboard, keyboardFrame, safeArea, signal, Text, untracked, View } from "nsh";
import type { Terminal as TerminalRow } from "@real-bot/protocol";
import { arrowBytes, controlByte, pasteBytes } from "../../m/overlays/terminal-keys.ts";
import { orderTerminals, pageTerminal, statusLabel, TERMINAL_KEY_ROWS, terminalNames, tildePath, type PhoneKey } from "../../m/overlays/terminals.ts";
import type { TerminalHandle } from "../../NshTerminal";
import { NshTerminal } from "../lazy-views";
import { copy, runtime } from "../../runtime";
import { BottomSheet } from "../BottomSheet";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";

export function TerminalPage() {
  const t = () => copy().terminal;
  const error = signal<string | null>(null);
  const starting = signal(false);
  const listOpen = signal(false);
  /** The running session whose 结束会话 was pressed once in the list; the second press ends it. */
  const arming = signal<string | null>(null);
  /** The bar's Ctrl: on for the next key, from the bar or the software keyboard, then off. */
  const ctrl = signal(false);
  /**
   * A list read since the page opened, on the link it is on. Until then an empty list is "not asked
   * yet", not "none running": a page opened by its address, or over a link just back, must not
   * start a shell beside the one it is about to find.
   */
  const listed = signal(false);
  let startedOnce = false;
  let handle: TerminalHandle | null = null;

  const connected = () => runtime.connection === "connected" && runtime.client !== null;
  effect(() => {
    if (!connected()) {
      listed.set(false);
      return;
    }
    // A read that fails on a link still up is tried again, or the page would say "opening" for good.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const read = () => {
      void runtime.refreshTerminals().then((ok) => {
        if (ok) listed.set(true);
        else if (live) timer = setTimeout(read, 2000);
      });
    };
    untracked(read);
    cleanup(() => {
      live = false;
      clearTimeout(timer);
    });
  });

  const rows = () => orderTerminals(runtime.terminals);
  const names = () => terminalNames(runtime.terminals);
  const shownId = () => pageTerminal(runtime.terminals, runtime.pageTerminalId);
  const shown = (): TerminalRow | null => {
    const id = shownId();
    return id ? (runtime.terminals.find((row) => row.id === id) ?? null) : null;
  };
  const nameOf = (row: TerminalRow) => names().get(row.id) ?? row.title;
  const workspace = () => runtime.snapshot.settings.workspace_path;

  // What is on screen is what the page comes back to next time.
  effect(() => {
    const id = shownId();
    if (id && id !== untracked(() => runtime.pageTerminalId)) runtime.pageTerminalId = id;
  });

  const start = async () => {
    if (untracked(starting)) return;
    error.set(null);
    starting.set(true);
    const created = await runtime.startTerminal();
    starting.set(false);
    if (created) runtime.pageTerminalId = created.id;
    else error.set(t().startFailed);
  };

  // Opened with nothing running to reattach to: a terminal asked for is one to type in, so start
  // one. Only then: once the page has shown a shell, ending the last one leaves the page empty,
  // with 新建, rather than starting another behind your back.
  effect(() => {
    if (!listed() || startedOnce) return;
    if (shownId()) {
      startedOnce = true;
      return;
    }
    if (!workspace()) return;
    startedOnce = true;
    untracked(() => void start());
  });

  const pick = (id: string) => {
    runtime.pageTerminalId = id;
    arming.set(null);
    listOpen.set(false);
  };

  const end = async (id: string) => {
    arming.set(null);
    await runtime.endTerminal(id);
  };

  const takeCtrl = (): boolean => {
    const on = untracked(ctrl);
    if (on) ctrl.set(false);
    return on;
  };

  /** Text from the software keyboard, with the bar's Ctrl applied to the first key after it. */
  const typed = (data: string): string => {
    if (!takeCtrl()) return data;
    return controlByte(data) ?? data;
  };

  const press = (key: PhoneKey) => {
    const terminal = handle;
    if (!terminal) return;
    switch (key.kind) {
      case "bytes":
        takeCtrl();
        terminal.send(key.bytes);
        return;
      case "arrow":
        terminal.send(arrowBytes(key.arrow, { application: terminal.applicationCursorKeys(), ctrl: takeCtrl() }));
        return;
      case "ctrl":
        ctrl.set(!untracked(ctrl));
        return;
      case "paste":
        takeCtrl();
        void Clipboard.readText()
          .then((text) => {
            if (text) terminal.send(pasteBytes(text, terminal.bracketedPaste()));
          })
          .catch(() => undefined);
        return;
      case "keyboard":
        if (keyboardFrame().height > 0) Keyboard.dismiss();
        else terminal.focus();
        return;
    }
  };

  const keyLabel = (key: PhoneKey): string => {
    if (key.kind === "paste") return t().paste;
    if (key.kind === "keyboard") return keyboardFrame().height > 0 ? t().hideKeyboard : t().showKeyboard;
    if (key.kind === "ctrl") return t().ctrl;
    return key.label;
  };

  const keyButton = (key: PhoneKey) => (
    <View
      role="button"
      testID={`terminal-key-${key.id}`}
      accessibilityLabel={keyLabel(key)}
      accessibilityState={key.kind === "ctrl" ? { selected: ctrl() } : undefined}
      focusable={false}
      onPress={() => press(key)}
      class={`cursor-pointer select-none grow basis-0 min-w-[30px] h-[36px] items-center justify-center rounded-(--radius-sm) border bg-input-bg ${key.kind === "ctrl" && ctrl() ? "border-brand" : "border-line"}`}
    >
      {key.kind === "paste" ? (
        <Icon name="clipboard" size={16} class="tint-ink" />
      ) : key.kind === "keyboard" ? (
        <Icon name="keyboard" size={20} class="tint-ink" />
      ) : (
        <Text class={`text-[14px] ${key.kind === "ctrl" && ctrl() ? "text-brand" : "text-ink"}`}>{key.label}</Text>
      )}
    </View>
  );

  /** What the page says where the terminal would be. */
  const placeholder = () => {
    if (error()) return error();
    if (!workspace()) return t().needsWorkspace;
    return t().opening;
  };

  return (
    // Above the soft keyboard: a phone's browser shrinks only the visual viewport under it, so the
    // key bar, which is for typing, would sit behind it.
    <View testID="terminal-page" class="flex-1 min-h-0 bg-pane" style={{ paddingBottom: Math.max(keyboardFrame().height, safeArea().bottom) }}>
      <View class="flex-row items-center gap-1 px-1 pb-[6px] border-b border-line" style={{ paddingTop: Math.max(6, safeArea().top) }}>
        <IconButton icon="chevron-left" size="lg" label={copy().common.back} testID="terminal-back" onPress={() => runtime.closeTerminal()} />
        <View
          role="button"
          testID="terminal-title"
          accessibilityLabel={t().sessions}
          onPress={() => listOpen.set(true)}
          class="cursor-pointer select-none flex-1 min-w-0 px-1 py-[2px] rounded-(--radius-sm) active:bg-row-hover"
        >
          <View class="flex-row items-center gap-1 min-w-0">
            <Text testID="terminal-name" class="shrink min-w-0 line-clamp-1 text-[15px] font-semibold text-ink">
              {shown() ? nameOf(shown()!) : t().title}
            </Text>
            <If when={rows().length > 1}>
              <Text testID="terminal-count" class="shrink-0 text-[12px] text-ink-muted">
                {String(rows().length)}
              </Text>
            </If>
            <Icon name="chevron-down" size={12} class="tint-ink-muted" />
          </View>
          <If when={shown()}>
            {(row) => (
              <Text testID="terminal-cwd" class="line-clamp-1 font-mono text-[12px] text-ink-muted">
                {[tildePath(row().cwd), statusLabel(row(), copy())].filter(Boolean).join(" · ")}
              </Text>
            )}
          </If>
        </View>
        <IconButton icon="plus" size="lg" label={t().newTab} testID="terminal-new" disabled={starting() || !workspace()} onPress={() => void start()} />
      </View>
      <View class="flex-1 min-h-0">
        <If
          when={connected() ? shownId() : null}
          else={
            <If
              when={listed() && !starting() && !error() && workspace() && !shownId()}
              else={
                <Text testID="terminal-placeholder" class="m-auto p-6 text-[13px] text-ink-muted text-center">
                  {placeholder()}
                </Text>
              }
            >
              <View testID="terminal-empty" class="m-auto p-6 items-center gap-3">
                <Text class="text-[15px] text-ink">{t().empty}</Text>
                <Text class="text-[13px] text-ink-muted text-center">{t().emptyHint}</Text>
                <Button variant="primary" testID="terminal-empty-new" onPress={() => void start()}>
                  {t().newSession}
                </Button>
              </View>
            </If>
          }
        >
          {(id) => (
            // Keyed by the session: another one is a new terminal, attached from its own screen.
            <Each of={[id()]} key={(each) => each}>
              {(each) => (
                <NshTerminal id={each()} onExit={() => void runtime.refreshTerminals()} onHandle={(next) => (handle = next)} typed={typed} />
              )}
            </Each>
          )}
        </If>
      </View>
      <View testID="terminal-keys" role="group" accessibilityLabel={t().keys} class="gap-1 px-2 py-[6px] border-t border-line bg-pane">
        {TERMINAL_KEY_ROWS.map((row) => (
          <View class="flex-row gap-1">{row.map((key) => keyButton(key))}</View>
        ))}
      </View>
      <If when={listOpen()}>
        <BottomSheet
          title={t().sessions}
          closeLabel={copy().common.close}
          testID="terminal-sessions"
          onClose={() => {
            arming.set(null);
            listOpen.set(false);
          }}
        >
          <View class="pb-2">
            <Each of={rows()} key={(row) => row.id}>
              {(row) => (
                <View class="flex-row items-center gap-2 px-4 py-2">
                  <View
                    role="button"
                    testID={`terminal-session-${row().id}`}
                    accessibilityLabel={nameOf(row())}
                    accessibilityState={{ selected: row().id === shownId() }}
                    onPress={() => pick(row().id)}
                    class="cursor-pointer select-none flex-1 min-w-0"
                  >
                    <Text class={`line-clamp-1 text-[15px] ${row().id === shownId() ? "font-semibold text-brand" : "text-ink"}`}>
                      {[nameOf(row()), statusLabel(row(), copy())].filter(Boolean).join(" · ")}
                    </Text>
                    <Text class="line-clamp-1 font-mono text-[12px] text-ink-muted">{tildePath(row().cwd)}</Text>
                  </View>
                  <If
                    when={arming() === row().id}
                    else={
                      <Button
                        size="sm"
                        variant="secondary"
                        testID={`terminal-end-${row().id}`}
                        onPress={() => {
                          if (row().status === "live") arming.set(row().id);
                          else void end(row().id);
                        }}
                      >
                        {t().end}
                      </Button>
                    }
                  >
                    <Button size="sm" variant="danger-soft" testID={`terminal-end-confirm-${row().id}`} onPress={() => void end(row().id)}>
                      {t().end}
                    </Button>
                  </If>
                </View>
              )}
            </Each>
            <If when={arming()}>
              <Text testID="terminal-end-note" class="px-4 pt-1 text-[12px] text-ink-muted">
                {t().endConfirm}
              </Text>
            </If>
          </View>
        </BottomSheet>
      </If>
    </View>
  );
}
