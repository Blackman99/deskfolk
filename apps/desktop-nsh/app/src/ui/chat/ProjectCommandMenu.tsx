/**
 * What typing `/` in a project session's composer offers (`ProjectCommandMenu.svelte`, ADR 0098):
 * the agent's commands and skills whose names fit what you typed, above the composer as the @ list
 * sits above a Bot's. The composer keeps the keys (↑↓ move, Tab fills the command in, Enter runs it,
 * Esc closes); a press fills it in. While the list is loading, failed or empty it says so. The editor
 * places it (an `Overlay` over the box). `CommandChoiceMenu` is the same list for what a command
 * takes after its name (`command-arguments`).
 *
 * The list comes from the session's store, a deep proxy: `Each` draws nothing from one, so it gets a
 * plain copy (PORTING.md). A bare `/` hands the store's own array through, and the list was empty.
 */
import { Scroll, Text, View, effect, platform, type ScrollRef, type ViewRef } from "nsh";
import type { ClaudeCodeCommand } from "@real-bot/protocol";
import type { ProjectCommandsState } from "../../m/chat/project-commands.svelte";
import { frameOf, keepFocusIn } from "../../platform/press";
import { copy } from "../../runtime";
import { shadow } from "../styles";
import { tip } from "../tip";
import { KeyHints } from "./KeyHints";

const LIST_MAX = 260;

export function ProjectCommandMenu(props: {
  /** Whose commands they are, as the session names its agent. */
  agentName: string;
  status: ProjectCommandsState | null;
  matches: readonly ClaudeCodeCommand[];
  active: number;
  onHover: (index: number) => void;
  onPick: (command: ClaudeCodeCommand) => void;
  width?: number;
}) {
  const scroller: { ref: ScrollRef | null } = { ref: null };
  const bounds = new Map<number, { y: number; height: number }>();
  const viewport = { y: 0, height: 0 };
  effect(() => {
    const at = bounds.get(props.active);
    if (!at || !scroller.ref || viewport.height === 0) return;
    if (at.y < viewport.y) scroller.ref.scrollTo({ y: at.y });
    else if (at.y + at.height > viewport.y + viewport.height) scroller.ref.scrollTo({ y: at.y + at.height - viewport.height });
  });
  const note = (text: string) => <Text role="text" testID="command-note" class="px-[10px] py-2 text-[12px] text-ink-muted">{text}</Text>;
  // Picking keeps the typing in the message box (the messenger's `onmousedown` `preventDefault`).
  let menu: ViewRef | undefined;
  keepFocusIn(() => frameOf(menu));
  return (
    <View
      ref={(node) => (menu = node)}
      testID="command-menu"
      class="bg-pane border border-line rounded-(--radius-lg) p-[6px]"
      style={{ width: props.width ?? 520, boxShadow: shadow("menu") }}
    >
      <If when={props.status === "loading" || props.status === null}>{note(copy().project.commandsLoading)}</If>
      <If when={props.status === "failed"}>{note(copy().project.commandsFailed(props.agentName))}</If>
      <If when={Array.isArray(props.status) && props.matches.length === 0}>{note(copy().project.commandsNone(props.agentName))}</If>
      <If when={Array.isArray(props.status) && props.matches.length > 0}>
        <Scroll
          testID="command-list"
          accessibilityLabel={copy().project.commandsLabel(props.agentName)}
          style={{ maxHeight: LIST_MAX }}
          ref={(node: ScrollRef | null) => (scroller.ref = node)}
          onLayout={(e) => (viewport.height = e.bounds.size.height)}
          onScroll={(e) => (viewport.y = e.offset.y)}
        >
          <View class="gap-[2px]">
            <Each of={props.matches.slice()} key={(command) => command.name}>
              {(command, index) => (
                <View
                  role="button"
                  testID={`command-${command().name}`}
                  tooltip={tip(command().description)}
                  accessibilityLabel={`/${command().name}`}
                  accessibilityState={{ selected: index() === props.active }}
                  onMouseEnter={() => props.onHover(index())}
                  onPress={() => props.onPick(command())}
                  onLayout={(e) => bounds.set(index(), { y: e.bounds.origin.y, height: e.bounds.size.height })}
                  class={`cursor-pointer select-none flex-row ${platform.desktop ? "items-baseline" : "flex-wrap"} gap-2 w-full min-w-0 px-[10px] ${platform.desktop ? "py-[7px]" : "py-[9px]"} rounded-(--radius-md) ${index() === props.active ? "bg-accent-tint" : ""}`}
                >
                  <Text class={`shrink-0 font-mono text-[13px] font-semibold ${index() === props.active ? "text-brand" : "text-ink"}`}>{`/${command().name}`}</Text>
                  <If when={command().argument_hint}>
                    {(hint) => <Text class="shrink font-mono text-[12px] text-ink-muted line-clamp-1" style={{ maxWidth: "30%" }}>{hint()}</Text>}
                  </If>
                  <Text class={`text-[12px] text-ink-secondary ${platform.desktop ? "flex-1 min-w-0 line-clamp-1" : "w-full line-clamp-2"}`}>{command().description}</Text>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
        <KeyHints
          hints={[
            ["↑↓", copy().project.commandKeys.move],
            ["Tab", copy().project.commandKeys.fill],
            ["Enter", copy().project.commandKeys.run],
            ["Esc", copy().project.commandKeys.close],
          ]}
        />
      </If>
    </View>
  );
}

/**
 * What the command in the line takes after its name, as its hint names the choices (`/advisor`'s
 * models, `/fast`'s on and off): the command and what it does on top, the choices that fit what is
 * typed under it. Nothing is highlighted until you move or type, so Enter still sends the command
 * as it stands; a press, Tab, or Enter on a highlighted choice puts it in.
 */
export function CommandChoiceMenu(props: {
  command: ClaudeCodeCommand;
  choices: readonly string[];
  /** The highlighted choice, or -1 for none. */
  active: number;
  onHover: (index: number) => void;
  onPick: (choice: string) => void;
  width?: number;
}) {
  let menu: ViewRef | undefined;
  keepFocusIn(() => frameOf(menu));
  return (
    <View
      ref={(node) => (menu = node)}
      testID="command-choices"
      role="listbox"
      accessibilityLabel={copy().project.commandChoicesLabel(props.command.name)}
      class="bg-pane border border-line rounded-(--radius-lg) p-[6px]"
      style={{ width: props.width ?? 520, boxShadow: shadow("menu") }}
    >
      <View class="flex-row items-baseline gap-2 min-w-0 px-[10px] pt-[5px] pb-[6px]">
        <Text class="shrink-0 font-mono text-[12px] font-semibold text-ink-muted">{`/${props.command.name}`}</Text>
        <Text class="flex-1 min-w-0 text-[12px] text-ink-muted line-clamp-1">{props.command.description}</Text>
      </View>
      <View class="gap-[2px]">
        <Each of={props.choices.slice()} key={(choice) => choice}>
          {(choice, index) => (
            <View
              role="option"
              testID={`command-choice-${choice()}`}
              accessibilityLabel={choice()}
              accessibilityState={{ selected: index() === props.active }}
              onMouseEnter={() => props.onHover(index())}
              onPress={() => props.onPick(choice())}
              class={`cursor-pointer select-none flex-row items-center w-full min-w-0 px-[10px] ${platform.desktop ? "py-[7px]" : "py-[9px]"} rounded-(--radius-md) ${index() === props.active ? "bg-accent-tint" : ""}`}
            >
              <Text class={`font-mono text-[13px] font-semibold ${index() === props.active ? "text-brand" : "text-ink"}`}>{choice()}</Text>
            </View>
          )}
        </Each>
      </View>
      <KeyHints
        hints={[
          ["↑↓", copy().project.commandKeys.move],
          ["Tab", copy().project.commandKeys.fill],
          ["Enter", copy().project.commandKeys.run],
          ["Esc", copy().project.commandKeys.close],
        ]}
      />
    </View>
  );
}
