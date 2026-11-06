/**
 * The menu of a right click on a pane or a tab, and of a tab's ⋯ (`PaneContextMenu.svelte`): what the
 * tab offers for what it shows, closing from it (it, the others, those to its right, all of them),
 * Copy and Paste for what keeps its own selection, the four splits, docking a floating pane, floating
 * a tab and closing the pane. Mount it while it is open.
 *
 * An `Overlay` at the pointer (`x`, `y` in the window), or hung off `anchor`, the button that opened
 * it: a press on the button is left to the button, which closes the menu itself. The overlay keeps
 * itself inside the window; Escape and a press outside close it, Escape handing the keyboard back to
 * `anchor`. Arrow keys, Home and End walk the rows that are not dimmed; Tab closes.
 */
import { Image, Overlay, Text, View, type JSX, type ViewRef } from "nsh";
import type { Axis, TabCloseScope } from "../../m/workbench/layout-types.ts";
import type { Direction } from "../../m/workbench/layout-geometry.ts";
import { SPLIT_TOWARDS } from "../../m/workbench/workbench-commands.ts";
import { formatShortcut } from "../../m/keymap.ts";
import { copy } from "../../runtime";
import { Icon, type IconName } from "../Icon";
import { rovingMenu } from "../sidebar/menu-roving";
import { shadow } from "../styles";
import { tip } from "../tip";
import type { TabAction, TabClosing } from "./types";

/**
 * The picture is a strip of three tabs, the middle one the tab the menu is for; the solid ones are
 * those that close. A faint fill, like the splits', could not be told apart at 14px.
 */
export function closesSlot(scope: TabCloseScope, slot: number): boolean {
  if (scope === "tab") return slot === 1;
  if (scope === "others") return slot !== 1;
  if (scope === "right") return slot === 2;
  return true;
}

/** "Others" and "to the right" stay in the list when there is nothing there, dimmed. */
export function closeDisabled(closing: TabClosing, scope: TabCloseScope): boolean {
  if (scope === "others") return !closing.others;
  if (scope === "right") return !closing.right;
  return false;
}

const cache = new Map<TabCloseScope, string>();
/** The strip-of-three-tabs picture, black, to be tinted. */
export function closeScopeUri(scope: TabCloseScope): string {
  const known = cache.get(scope);
  if (known) return known;
  const tabs = [2.9, 9.9, 16.9].map((left, slot) => {
    const closes = closesSlot(scope, slot);
    const d = `M${left} 19V8.4a1.5 1.5 0 0 1 1.5-1.5h1.2a1.5 1.5 0 0 1 1.5 1.5V19${closes ? "z" : ""}`;
    return `<path d="${d}" fill="${closes ? "#000" : "none"}"/>`;
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `${tabs.join("")}<path d="M1.5 19h21"/></svg>`;
  const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  cache.set(scope, uri);
  return uri;
}

type Row = {
  key: string;
  testID: string;
  label: string;
  icon: "none" | { name: IconName } | { scope: TabCloseScope } | { custom: () => JSX.Element };
  keys?: string;
  active?: boolean;
  disabled?: boolean;
  reason?: string | null;
  run: () => void;
};
type Item = { divider: true } | Row;

export function PaneContextMenu(props: {
  /** Window coordinates of the right click. */
  x: number;
  y: number;
  /** What the menu is called. The pane's name unless it only holds a tab's actions. */
  label?: string;
  /** What the tab under the pointer offers, above everything else. */
  actions?: TabAction[];
  /** Closing from the tab under the pointer: it, the others, those to its right, all of them. */
  closeTabs?: TabClosing | null;
  /** Whether the window has room for one more pane across (`row`) and down (`column`). */
  fits?: Record<Axis, boolean>;
  /** A floating pane is not split in place: it is docked first, which this menu offers. */
  floating?: boolean;
  /** Copy and Paste, when what was right-clicked keeps its own selection and takes its own paste. */
  edit?: { canCopy: boolean; onCopy: () => void; onPaste: () => void } | null;
  /** Left out, the menu offers no splits: a tab's ⋯ holds only what the tab offers and its closing. */
  onSplit?: (dir: Direction) => void;
  onDock?: () => void;
  /** Lifts the tab out into a floating pane of its own. Left out, it is not offered. */
  onFloat?: () => void;
  onClosePane?: () => void;
  /** The button that opened the menu: the overlay hangs from it and Escape hands the keyboard back. */
  anchor?: ViewRef | null;
  onClose: () => void;
}) {
  const t = () => copy().pane;
  const fits = () => props.fits ?? { row: false, column: false };

  /** Act first: closing drops the host's record of which pane was right-clicked. */
  const pick = (action: () => void) => () => {
    action();
    props.onClose();
  };

  const disabledReason = (dir: Direction): string | null => {
    if (props.floating) return t().dockToSplit;
    return fits()[SPLIT_TOWARDS[dir].axis] ? null : t().tooSmall;
  };

  /** Reading order of the request: up, down, left, right. The two with a key say which. */
  const splitItems = (): { dir: Direction; label: string; keys?: string }[] => [
    { dir: "up", label: t().splitUp },
    { dir: "down", label: t().splitDown, keys: formatShortcut(["shift", "mod", "\\"]) },
    { dir: "left", label: t().splitLeft },
    { dir: "right", label: t().splitRight, keys: formatShortcut(["mod", "\\"]) },
  ];
  const closeItems = (): { scope: TabCloseScope; label: string }[] => [
    { scope: "tab", label: t().closeTab },
    { scope: "others", label: t().closeOtherTabs },
    { scope: "right", label: t().closeTabsRight },
    { scope: "all", label: t().closeAllTabs },
  ];

  /** The whole list, dividers between the groups that are there. */
  const items = (): Item[] => {
    const out: Item[] = [];
    const group = (rows: Row[]) => {
      if (rows.length === 0) return;
      if (out.length > 0) out.push({ divider: true });
      out.push(...rows);
    };
    group(
      (props.actions ?? []).map((action) => ({
        key: `action-${action.id}`,
        testID: `wb-action-${action.id}`,
        label: action.label,
        icon: action.icon ? { custom: action.icon } : ("none" as const),
        active: action.active,
        run: action.run,
      })),
    );
    const closing = props.closeTabs;
    if (closing) {
      group(
        closeItems().map((item) => ({
          key: `close-${item.scope}`,
          testID: `wb-close-tabs-${item.scope}`,
          label: item.label,
          icon: { scope: item.scope },
          disabled: closeDisabled(closing, item.scope),
          run: () => closing.onClose(item.scope),
        })),
      );
    }
    const editing = props.edit;
    if (editing) {
      group([
        { key: "copy", testID: "wb-edit-copy", label: t().copy, icon: { name: "copy" }, keys: formatShortcut(["mod", "C"]), disabled: !editing.canCopy, run: editing.onCopy },
        { key: "paste", testID: "wb-edit-paste", label: t().paste, icon: { name: "clipboard" }, keys: formatShortcut(["mod", "V"]), run: editing.onPaste },
      ]);
    }
    const split = props.onSplit;
    if (split) {
      // The copy / paste pair and the splits share one group, as in the Svelte menu's order.
      const rows: Row[] = splitItems().map((item) => {
        const reason = disabledReason(item.dir);
        return {
          key: `split-${item.dir}`,
          testID: `wb-split-${item.dir}`,
          label: item.label,
          icon: { name: `split-${item.dir}` as IconName },
          keys: item.keys,
          disabled: reason !== null,
          reason,
          run: () => split(item.dir),
        };
      });
      group(rows);
    }
    const dock = props.onDock;
    if (props.floating && dock) group([{ key: "dock", testID: "wb-dock", label: t().dock, icon: { name: "panel-arrow-down" }, run: dock }]);
    const float = props.onFloat;
    if (float) group([{ key: "float-tab", testID: "wb-float-tab", label: t().floatTab, icon: { name: "panel-inset" }, run: float }]);
    const closePane = props.onClosePane;
    if (closePane) group([{ key: "close-pane", testID: "wb-close-pane", label: t().close, icon: { name: "x" }, run: closePane }]);
    return out;
  };
  const rows = () => items().filter((item): item is Row => !("divider" in item));

  const roving = rovingMenu({
    open: () => true,
    keys: () => rows().filter((row) => !row.disabled).map((row) => row.key),
    onTab: () => props.onClose(),
  });

  /** Escape hands the keyboard back to the button the menu hangs from. */
  function cancel(): void {
    const back = props.anchor;
    props.onClose();
    back?.focus();
  }

  const renderRow = (row: Row) => (
    <View
      ref={roving.ref(row.key)}
      role="menuitem"
      testID={row.testID}
      accessibilityLabel={row.label}
      accessibilityState={{ disabled: Boolean(row.disabled) }}
      tooltip={row.reason ? tip(row.reason) : undefined}
      disabled={row.disabled}
      onPress={pick(row.run)}
      onFocus={() => roving.focused(row.key)}
      onBlur={() => roving.blurred(row.key)}
      class="flex-row items-center gap-2 w-full px-[10px] py-[6px] rounded-(--radius-sm) hover:bg-line-subtle focus-visible:bg-line-subtle group disabled:opacity-[0.4]"
    >
      {row.icon === "none" ? (
        <View accessible={false} class="w-4 h-4" />
      ) : "name" in row.icon ? (
        <Icon name={row.icon.name} size={16} class="tint-ink opacity-75 group-hover:tint-brand group-hover:opacity-100" />
      ) : "scope" in row.icon ? (
        <Image
          src={closeScopeUri(row.icon.scope)}
          accessible={false}
          class="tint-ink opacity-75 group-hover:tint-brand group-hover:opacity-100"
          style={{ width: 14, height: 14, margin: 1 }}
        />
      ) : (
        <View accessible={false} class="w-4 h-4 items-center justify-center">
          {row.icon.custom()}
        </View>
      )}
      <Text class={`flex-1 text-[13px] font-medium ${row.active ? "text-brand" : "text-ink"} group-hover:text-brand`}>{row.label}</Text>
      {row.keys ? <Text accessible={false} class="ml-3 text-[12px] text-ink-muted">{row.keys}</Text> : null}
    </View>
  );

  return (
    <Overlay
      anchor={props.anchor ?? { x: props.x, y: props.y }}
      placement="bottom"
      align="start"
      offset={props.anchor ? 4 : 0}
      margin={8}
      onPressOutside={() => props.onClose()}
      onCancel={cancel}
    >
      <View
        role="menu"
        testID="wb-context-menu"
        accessibilityLabel={props.label ?? t().title}
        onContextMenu={() => {}}
        class="min-w-[176px] p-[5px] gap-[2px] bg-pane border border-line rounded-(--radius-md)"
        style={{ boxShadow: shadow("menu") }}
      >
        {() => items().map((item) => ("divider" in item ? <View role="none" class="h-[1px] mx-2 my-[3px] bg-line-subtle" /> : renderRow(item)))}
      </View>
    </Overlay>
  );
}
