/**
 * The second level of the desktop's 工具 menu under 终端 (`ToolsMenu`): a new terminal, then under
 * 可接回 the running sessions no workbench tab shows (`ShellWorkbench.untabbedTerminals`, so one a
 * tab already shows is never here), or a line saying there are none. It opens beside the row it
 * belongs to, its first row level with that row, and is drawn inside the tools menu's overlay, so a
 * press on it is not a press outside that menu. While it has the keyboard (`keys`) ↑↓ walk it and its
 * first row takes the focus; ← and Escape hand the keyboard back to the row it came from.
 */
import { effect, keymap, Overlay, Text, View, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";
import { rovingMenu } from "./menu-roving";

/** A running terminal session to reattach to: its id, its name as its tab would have it, and where it is. */
export type TerminalToReattach = { id: string; name: string; cwd?: string };

/** The menu's padding and border: the overlay is placed by its own edge, the first row sits this far in. */
const INSET = 6;

export function ToolsTerminalMenu(props: {
  /** The 终端 row: it opens beside it. */
  anchor: ViewRef;
  /** The rows a narrow window's menu has, taller. */
  big: boolean;
  /** The keyboard is in here: it came in with → or a press. */
  keys: boolean;
  terminals: TerminalToReattach[];
  onNew: () => void;
  onReattach: (id: string) => void;
  /** ← or Escape: back to the 终端 row. */
  onBack: () => void;
  /** Tab: the whole menu closes. */
  onTab: () => void;
  /** The pointer came in: a close it was about to make for leaving the row is off. */
  onMouseEnter: () => void;
}) {
  const keys = () => ["new", ...props.terminals.map((row) => `reattach-${row.id}`)];
  const roving = rovingMenu({ open: () => props.keys, keys, onTab: () => props.onTab() });

  effect(() => {
    if (!props.keys) return;
    const off = keymap.bind("left", () => props.onBack(), { when: "always" });
    // Come in from the keyboard, the first row takes the focus once it is laid out.
    const timer = setTimeout(() => roving.focusEdge(false), 0);
    return () => {
      off();
      clearTimeout(timer);
    };
  });

  const row = (key: string, label: () => string, action: () => void, cwd?: () => string | undefined) => (
    <View
      role="menuitem"
      // Every 接回 row one test id: a test counts them and picks one by its name.
      testID={key === "new" ? "tools-terminal-new" : "tools-reattach"}
      ref={roving.ref(key)}
      accessibilityLabel={label()}
      tooltip={cwd?.() ? tip(cwd()!) : undefined}
      onFocus={() => roving.focused(key)}
      onBlur={() => roving.blurred(key)}
      onPress={action}
      class={`cursor-pointer select-none flex-row items-center gap-[10px] shrink-0 px-[10px] rounded-(--radius-sm) hover:bg-line-subtle focus:bg-line-subtle ${props.big ? "min-h-[44px]" : "min-h-[38px]"}`}
    >
      <Icon name="terminal" class="tint-ink-muted shrink-0" />
      <Text class={`flex-1 min-w-0 font-medium text-ink line-clamp-1 ${props.big ? "text-[14px]" : "text-[13px]"}`}>{label()}</Text>
    </View>
  );

  return (
    <Overlay anchor={props.anchor} placement="right" align="start" offset={INSET + 2} margin={8} onCancel={() => props.onBack()}>
      <View
        role="menu"
        testID="tools-terminal-menu"
        accessibilityLabel={copy().terminal.title}
        onMouseEnter={() => props.onMouseEnter()}
        class="w-[232px] p-[5px] bg-pane border border-line rounded-(--radius-md)"
        style={{ boxShadow: shadow("lg"), marginTop: -INSET }}
      >
        {row("new", () => copy().terminal.newTab, () => props.onNew())}
        <View role="none" class="h-[1px] m-[5px] bg-line shrink-0" />
        <Text role="none" class="px-[10px] pt-[2px] pb-[4px] text-[11px] font-semibold text-ink-muted">
          {copy().pane.runningTerminals}
        </Text>
        <If when={props.terminals.length > 0} else={<Text testID="tools-terminal-none" class="px-[10px] pt-[4px] pb-[8px] text-[12px] text-ink-muted">{copy().pane.noRunningTerminals}</Text>}>
          <Each of={props.terminals} key={(terminal) => terminal.id}>
            {(terminal) => {
              // The row's key: the same for the row's life, and the press runs after the menu has
              // closed and taken the row away.
              const id = terminal().id;
              return row(`reattach-${id}`, () => terminal().name, () => props.onReattach(id), () => terminal().cwd);
            }}
          </Each>
        </If>
      </View>
    </Overlay>
  );
}
