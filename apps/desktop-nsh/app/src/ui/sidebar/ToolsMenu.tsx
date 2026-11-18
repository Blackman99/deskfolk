/**
 * The 工具 popover (`ToolsMenu.svelte`): routines, spend, usage, a terminal, the Mac's screen on a
 * phone that can reach it, and — after a line — the archived sessions. One menu for every button
 * that opens it: the list's footer, the phone's search row, and the rail the list folds into. The
 * button stays with its owner (`anchor` is its ref); this hangs off it, walks with the arrow keys,
 * closes on Escape, Tab or a press elsewhere, and hands focus back to the button. On a phone
 * (`phone`) it is a sheet from the bottom (`BottomSheet`) instead; the desktop's folded rail keeps
 * its flyout, however narrow the window.
 *
 * On the desktop's workbench 终端 is a level of its own (`ToolsTerminalMenu`): a new terminal, and
 * the running ones no tab shows to reattach to. It opens beside the row a level at a time, as the
 * app's other cascades do: pointed at for a moment (`HOVER_INTENT`), pressed, or → on the row; a
 * row pointed at for as long closes it again. Only its rows act. A page (`pages`) has no such
 * level: its 终端 opens the terminal page, which reattaches by itself.
 */
import { effect, keymap, Overlay, signal, Text, View, type JSX, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import { screenCopy } from "../../m/copy";
import { spendCopyFor } from "../../m/spend/spend-copy";
import { BottomSheet, SheetItem, SheetSeparator } from "../BottomSheet";
import { Icon, type IconName } from "../Icon";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { rovingMenu } from "./menu-roving";
import { ToolsTerminalMenu, type TerminalToReattach } from "./ToolsTerminalMenu";

export type { TerminalToReattach };
export type ToolsCurrent = { routines?: boolean; spend?: boolean; usage?: boolean; roles?: boolean; terminal?: boolean; screen?: boolean; workspace?: boolean; archived?: boolean };
/** How long the pointer rests on a row before the 终端 level opens or closes for it. */
const HOVER_INTENT = 90;

export function ToolsMenu(props: {
  locale: "zh" | "en";
  /** A sheet from the bottom on a phone, over its button elsewhere. */
  phone: boolean;
  /**
   * The tools open pages, not workbench tabs, so the labels name the page rather than the tab. A
   * phone's do, and so do a tablet's on a remote connection, which is wider and still has no workbench.
   */
  pages: boolean;
  /** The button that opened it: the menu hangs off it and gives focus back to it. */
  anchor: ViewRef | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where it goes: stacked over the anchor, or `flyout` — out to the side, bottoms aligned — for a rail whose own buttons it must not cover. */
  placement?: "stack" | "flyout";
  /** ArrowUp on the anchor asks for the last item; cleared (`onFocusLastChange(false)`) once the menu has taken it. */
  focusLast?: boolean;
  onFocusLastChange?: (last: boolean) => void;
  archivedCount: number;
  /** What is on screen now, for the phone's pages. */
  current?: ToolsCurrent;
  onOpenRoutines: () => void;
  onOpenSpend: () => void;
  /** Every agent's usage (ADR 0080): the floating widget's panel, or a phone's page. */
  onOpenUsage?: (() => void) | null;
  /** Roles (ADR 0083): the app's own calls, their models and prompts, as a page of its own. */
  onOpenRoles?: (() => void) | null;
  onOpenTerminal: () => void;
  /**
   * The sessions no workbench tab shows — one the phone started, one Reset Layout left — listed
   * under 可接回 in the 终端 level; a tab's own shell is never one of them. With
   * `onReattachTerminal`, and only on the desktop's workbench (`pages` false), 终端 is that level;
   * a page reattaches by itself.
   */
  reattachTerminals?: TerminalToReattach[];
  onReattachTerminal?: ((id: string) => void) | null;
  /** The remote screen; null where this is not a phone on a Mac that offers it. */
  onOpenScreen?: (() => void) | null;
  /** The workspace, as a page among the tools on a phone, whose bottom bar no longer has it; null elsewhere. */
  onOpenWorkspace?: (() => void) | null;
  /** Whose screen that is, for its name: a Mac's, or a Windows PC's. */
  screenHost?: "mac" | "windows" | "linux";
  onOpenArchived: () => void;
}) {
  const current = (): ToolsCurrent => props.current ?? {};
  /** 终端 is a level of its own: the desktop's workbench, with somewhere to reattach to. */
  const cascade = () => !props.phone && !props.pages && Boolean(props.onReattachTerminal);
  /** The 终端 level: shut, opened by the pointer (the keyboard stays on this menu), or holding the keyboard. */
  const sub = signal<null | "pointer" | "keys">(null);
  const terminalRow = signal<ViewRef | null>(null);
  /** The row the keyboard is on, for →. */
  let focusedKey: string | null = null;
  let intent: ReturnType<typeof setTimeout> | undefined;
  const settle = (then: (() => void) | null) => {
    clearTimeout(intent);
    intent = then ? setTimeout(then, HOVER_INTENT) : undefined;
  };
  const keys = () => [
    ...(props.onOpenWorkspace ? ["workspace"] : []),
    "routines",
    "spend",
    ...(props.onOpenUsage ? ["usage"] : []),
    "terminal",
    ...(props.onOpenScreen ? ["screen"] : []),
    ...(props.onOpenRoles ? ["roles"] : []),
    "archived",
  ];
  const roving = rovingMenu({ open: () => props.open && !props.phone && sub() !== "keys", keys, onTab: () => close() });

  // Shut with the menu, and nothing left to fire after it.
  effect(() => {
    if (props.open) return;
    settle(null);
    sub.set(null);
  });

  // → on 终端 goes into its level.
  effect(() => {
    if (!props.open || !cascade() || sub() === "keys") return;
    return keymap.bind("right", () => {
      if (focusedKey === "terminal") sub.set("keys");
    }, { when: "always" });
  });

  /** Out of the 终端 level, the keyboard back on its row. */
  function back(): void {
    settle(null);
    sub.set(null);
    terminalRow()?.focus();
  }

  function close(): void {
    props.onOpenChange(false);
    if (!props.phone) props.anchor?.focus();
  }

  function choose(action: () => void): void {
    close();
    action();
  }

  // Opened from the keyboard, the focus goes to the first item (the last for ArrowUp).
  effect(() => {
    if (!props.open || props.phone) return;
    const last = props.focusLast === true;
    const timer = setTimeout(() => {
      roving.focusEdge(last);
      props.onFocusLastChange?.(false);
    }, 0);
    return () => clearTimeout(timer);
  });

  const big = () => props.phone || narrowWindow();

  /** One entry: a sheet row on a phone, a menu row over the button elsewhere. */
  const entry = (key: string, icon: IconName, label: () => string, on: () => boolean | undefined, action: () => void, extra?: () => JSX.Element, parent?: boolean) =>
    props.phone ? (
      <SheetItem role="menuitem" testID={`tools-${key}`} icon={icon} label={label()} active={on()} onPress={() => choose(action)} trailing={extra?.()} />
    ) : (
      <View
        role="menuitem"
        testID={`tools-${key}`}
        ref={(node: ViewRef) => {
          roving.ref(key)(node);
          if (key === "terminal") terminalRow.set(node);
        }}
        accessibilityLabel={label()}
        accessibilityState={parent ? { hasPopup: true, expanded: sub() !== null } : { selected: on() === true }}
        onFocus={() => {
          focusedKey = key;
          roving.focused(key);
        }}
        onBlur={() => {
          if (focusedKey === key) focusedKey = null;
          roving.blurred(key);
        }}
        // Resting on a row opens 终端's level for 终端 and closes it for any other.
        onMouseEnter={() => (cascade() ? settle(parent ? () => sub.set(sub() ?? "pointer") : () => sub.set(null)) : undefined)}
        onMouseLeave={() => settle(null)}
        onPress={() => (parent ? sub.set("keys") : choose(action))}
        class={`cursor-pointer select-none flex-row items-center gap-[10px] shrink-0 px-[10px] rounded-(--radius-sm) hover:bg-line-subtle focus:bg-line-subtle ${big() ? "min-h-[44px]" : "min-h-[38px]"}`}
      >
        <Icon name={icon} class="tint-ink-muted shrink-0" />
        <Text class={`flex-1 min-w-0 font-medium text-ink line-clamp-1 ${big() ? "text-[14px]" : "text-[13px]"}`}>{label()}</Text>
        {extra?.()}
      </View>
    );

  const entries = () => (
    <>
      <If when={props.onOpenWorkspace}>
        {(open) => entry("workspace", "folder", () => copy().sidebar.workspace, () => current().workspace, () => open()())}
      </If>
      {entry("routines", "calendar", () => (props.pages ? copy().calendar.open : copy().routines.title), () => current().routines, props.onOpenRoutines)}
      {entry("spend", "dollar", () => spendCopyFor(props.locale).open, () => current().spend, props.onOpenSpend)}
      <If when={props.onOpenUsage}>
        {(open) => entry("usage", "gauge", () => copy().usage.open, () => current().usage, () => open()())}
      </If>
      <If
        when={cascade()}
        else={entry("terminal", "terminal", () => (props.pages ? copy().terminal.title : copy().terminal.newTab), () => current().terminal, props.onOpenTerminal)}
      >
        {entry(
          "terminal",
          "terminal",
          () => copy().terminal.title,
          () => sub() !== null,
          props.onOpenTerminal,
          () => <Icon name="chevron-right" size={12} class="tint-ink-muted shrink-0" />,
          true,
        )}
      </If>
      <If when={props.onOpenScreen}>
        {(open) => entry("screen", "monitor", () => screenCopy(copy(), props.screenHost ?? "mac").title, () => current().screen, () => open()())}
      </If>
      <If when={props.onOpenRoles}>
        {(open) => entry("roles", "nodes", () => copy().routing.tab, () => current().roles, () => open()())}
      </If>
      {props.phone ? <SheetSeparator /> : <View role="none" class="h-[1px] m-[5px] bg-line shrink-0" />}
      {entry(
        "archived",
        "archive",
        () => copy().sidebar.archivedSessions,
        () => current().archived,
        props.onOpenArchived,
        () => (
          <If when={props.archivedCount > 0}>
            <View class="ml-auto px-[7px] py-[1px] rounded-full bg-line-subtle">
              <Text testID="tools-archived-count" class="text-[12px] font-semibold text-ink-muted">{String(props.archivedCount)}</Text>
            </View>
          </If>
        ),
      )}
    </>
  );

  return (
    <>
      <If when={props.open && props.phone}>
        <BottomSheet title={copy().sidebar.tools} closeLabel={copy().common.close} onClose={close}>
          <View role="menu" testID="sidebar-tools-menu" accessibilityLabel={copy().sidebar.tools}>
            {entries()}
          </View>
        </BottomSheet>
      </If>
      <If when={props.open && !props.phone ? props.anchor : null}>
        {(anchor) => (
          <Overlay
            anchor={anchor()}
            placement={props.placement === "flyout" ? "right" : "top"}
            align={props.placement === "flyout" ? "end" : "start"}
            offset={6}
            margin={8}
            onPressOutside={() => props.onOpenChange(false)}
            onCancel={close}
          >
            <View
              role="menu"
              testID="sidebar-tools-menu"
              accessibilityLabel={copy().sidebar.tools}
              class="w-[208px] max-w-[96%] p-[5px] bg-pane border border-line rounded-(--radius-md)"
              style={{ boxShadow: shadow("lg") }}
            >
              {entries()}
              <If when={sub() !== null && cascade() ? terminalRow() : null}>
                {(row) => (
                  <ToolsTerminalMenu
                    anchor={row()}
                    big={big()}
                    keys={sub() === "keys"}
                    terminals={props.reattachTerminals ?? []}
                    onNew={() => choose(props.onOpenTerminal)}
                    onReattach={(id) => choose(() => props.onReattachTerminal?.(id))}
                    onBack={back}
                    onTab={close}
                    onMouseEnter={() => settle(null)}
                  />
                )}
              </If>
            </View>
          </Overlay>
        )}
      </If>
    </>
  );
}
