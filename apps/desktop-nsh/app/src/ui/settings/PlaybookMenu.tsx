/**
 * What one engine on Roles' list offers, as a conversation's row does (`settings/PlaybookMenu.svelte`,
 * ADR 0085): make it the default, a new one made from it, a rename, its history, and removing it. A
 * built-in has no name of its own to change and cannot go; the default cannot go either, and says
 * why. It hangs where the row was right-clicked, or under the row's ⋯; walks with the arrow keys,
 * closes on Escape, Tab or a press elsewhere, and hands focus back to the row. Mount it while open.
 *
 * Props: `playbook`; `isDefault`; `anchor` (the ⋯ or the row: focus goes back there); `point` (where
 * a right-click opened it, in the window; null hangs it under the anchor); `label`; `onClose`;
 * `onMakeDefault` / `onNew` / `onRename` / `onHistory` / `onRemove` (each handed the engine's id).
 * Test ids: `playbook-menu-<id>`, `playbook-action-<default|new|rename|history|remove>`.
 */
import type { Playbook } from "@real-bot/protocol";
import { effect, Overlay, Text, View, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import { rovingMenu } from "../sidebar/menu-roving";
import { Icon, type IconName } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";

export function PlaybookMenu(props: {
  playbook: Playbook;
  isDefault: boolean;
  anchor: ViewRef | null;
  point: { x: number; y: number } | null;
  label: string;
  onClose: () => void;
  onMakeDefault: (id: string) => void;
  onNew: (id: string) => void;
  onRename: (id: string) => void;
  onHistory: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const c = () => copy().playbooks;
  const keys = () => [
    ...(props.isDefault ? [] : ["default"]),
    "new",
    ...(props.playbook.builtin ? [] : ["rename"]),
    "history",
    ...(props.playbook.builtin || props.isDefault ? [] : ["remove"]),
  ];
  const roving = rovingMenu({ open: () => true, keys, onTab: () => close() });

  function close(): void {
    // Read before closing: the anchor is the list's, and it lets go of it as the menu closes.
    const back = props.anchor;
    props.onClose();
    back?.focus();
  }

  function choose(action: (id: string) => void): void {
    const id = props.playbook.id;
    props.onClose();
    action(id);
  }

  // Opened from the keyboard (no point), the focus goes to the first item.
  effect(() => {
    if (props.point) return;
    const timer = setTimeout(() => roving.focusEdge(false), 0);
    return () => clearTimeout(timer);
  });

  const item = (key: string, icon: IconName, label: string, action: (id: string) => void, extra?: { note?: string; danger?: boolean; disabled?: boolean; title?: string }) => (
    <View
      role="menuitem"
      testID={`playbook-action-${key}`}
      ref={roving.ref(key)}
      accessibilityLabel={label}
      accessibilityState={{ disabled: extra?.disabled === true }}
      disabled={extra?.disabled}
      tooltip={extra?.title ? tip(extra.title) : undefined}
      onFocus={() => roving.focused(key)}
      onBlur={() => roving.blurred(key)}
      onPress={() => choose(action)}
      class={`group flex-row items-center gap-2 px-[10px] py-[6px] rounded-(--radius-sm) disabled:opacity-[0.4] ${extra?.danger ? "hover:bg-danger-bg focus:bg-danger-bg" : "hover:bg-line-subtle focus:bg-line-subtle"}`}
    >
      <Icon name={icon} class={extra?.danger ? "tint-ink-muted group-hover:tint-danger-text" : "tint-ink-muted group-hover:tint-brand"} />
      <Text class={`text-[13px] font-medium text-ink ${extra?.danger ? "group-hover:text-danger-text" : "group-hover:text-brand"}`}>{label}</Text>
      <If when={extra?.note}>
        <Text class="ml-auto pl-3 text-[12px] text-ink-muted">{extra?.note}</Text>
      </If>
    </View>
  );

  return (
    <Overlay
      anchor={props.point ?? props.anchor}
      placement="bottom"
      align={props.point ? "start" : "end"}
      offset={props.point ? 0 : 4}
      margin={8}
      onPressOutside={() => props.onClose()}
      onCancel={close}
    >
      <View
        role="menu"
        testID={`playbook-menu-${props.playbook.id}`}
        accessibilityLabel={props.label}
        class="min-w-[176px] gap-[2px] p-[5px] bg-pane border border-line rounded-(--radius-md)"
        style={{ boxShadow: shadow("menu") }}
      >
        {[
          ...(props.isDefault ? [] : [item("default", "star", c().makeDefault, props.onMakeDefault)]),
          item("new", "plus", c().newFrom, props.onNew),
          ...(props.playbook.builtin ? [] : [item("rename", "edit", c().rename, props.onRename)]),
          item("history", "history", c().history, props.onHistory, { note: props.playbook.revision > 0 ? c().revision(props.playbook.revision) : undefined }),
          ...(props.playbook.builtin
            ? []
            : [
                <View role="none" class="h-px mx-2 my-[3px] bg-line-subtle" />,
                item("remove", "trash", c().remove, props.onRemove, { danger: true, disabled: props.isDefault, title: props.isDefault ? c().removeIsDefault : undefined }),
              ]),
        ]}
      </View>
    </Overlay>
  );
}
