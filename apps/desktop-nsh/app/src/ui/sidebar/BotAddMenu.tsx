/**
 * What the + of the 「Bot」 section offers (`BotAddMenu.svelte`): a new Bot or a new group, the two
 * kinds of conversation the section lists together. It hangs under the +, walks with the arrow keys,
 * closes on Escape, Tab or a press elsewhere, and hands focus back to the +. `anchor` is the +'s ref.
 */
import { Overlay, Text, View, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { rovingMenu } from "./menu-roving";

export function BotAddMenu(props: {
  /** The + it hangs from. */
  anchor: ViewRef | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateBot: () => void;
  onCreateGroup: () => void;
}) {
  const roving = rovingMenu({ open: () => props.open, keys: () => ["bot", "group"], onTab: () => close() });

  function close(): void {
    props.onOpenChange(false);
    props.anchor?.focus();
  }

  function choose(action: () => void): void {
    props.onOpenChange(false);
    action();
  }

  const item = (key: "bot" | "group", icon: "bot" | "users", label: () => string, action: () => void) => (
    <View
      role="menuitem"
      testID={`bot-add-${key}`}
      ref={roving.ref(key)}
      accessibilityLabel={label()}
      onFocus={() => roving.focused(key)}
      onBlur={() => roving.blurred(key)}
      onPress={() => choose(action)}
      class="group flex-row items-center gap-[10px] min-h-[36px] px-[10px] rounded-(--radius-sm) hover:bg-row-hover focus:bg-row-hover"
    >
      <Icon name={icon} class="tint-ink-muted" />
      <Text class="text-[13px] font-medium text-ink">{label()}</Text>
    </View>
  );

  return (
    <If when={props.open ? props.anchor : null}>
      {(anchor) => (
        <Overlay anchor={anchor()} placement="bottom" align="end" offset={4} margin={8} onPressOutside={() => props.onOpenChange(false)} onCancel={close}>
          <View
            role="menu"
            testID="bot-add-menu"
            accessibilityLabel={copy().sidebar.createMenu}
            class="min-w-[200px] p-[5px] bg-pane border border-line rounded-(--radius-md)"
            style={{ boxShadow: shadow("lg") }}
          >
            {item("bot", "bot", () => copy().sidebar.addBot, props.onCreateBot)}
            {item("group", "users", () => copy().sidebar.addGroup, props.onCreateGroup)}
          </View>
        </Overlay>
      )}
    </If>
  );
}
