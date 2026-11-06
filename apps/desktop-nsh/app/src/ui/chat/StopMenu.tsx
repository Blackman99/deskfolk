/**
 * The stop menu (`StopMenu.svelte`, ADR 0040 P2): a square-and-chevron button that opens the choices
 * of what to stop (this Bot, this job, every Bot; in a project session, the run or one of its
 * background tasks). Picking one hands it to the owner, which makes the stop; a refusal it hands back
 * is said by the button until your next press. On a desktop an nsh/base `Menu` (arrow keys, Escape
 * and a press outside are NSH's); on a phone the choices open as a sheet from the bottom
 * (`BottomSheet`). Nothing left to choose closes it.
 */
import { effect, signal, Text, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { copy } from "../../runtime";
import type { StopMenuItem } from "../../m/chat/stop-menu";
import { BottomSheet, SheetItem } from "../BottomSheet";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";
import { narrowWindow as phoneSheet } from "../Modal";

export function StopMenu<Item extends { key: string; label: string } = StopMenuItem>(props: {
  items: readonly Item[];
  /** Opens upward over a composer, downward under a header. */
  placement?: "above" | "below";
  /** A word beside the icon, where there is room for one. */
  label?: string | null;
  /** `sm` beside a header's small buttons; `md` beside the composer's send button. */
  size?: "sm" | "md";
  disabled?: boolean;
  /** Makes the stop; what it resolves to is a refusal to show (an `ApiError`), or nothing. */
  onPick: (item: Item) => Promise<unknown> | void;
}) {
  const open = signal(false);
  const failed = signal(false);
  const below = () => props.placement === "below";
  const small = () => props.size === "sm";
  const off = () => props.disabled || props.items.length === 0;

  // Nothing left to choose (it was all stopped meanwhile): the menu goes with it.
  effect(() => {
    if (props.items.length === 0) open.set(false);
  });

  async function pick(item: Item): Promise<void> {
    open.set(false);
    failed.set(false);
    try {
      failed.set(Boolean(await props.onPick(item)));
    } catch {
      failed.set(true);
    }
  }

  const trigger = (
    <View
      role="button"
      testID="stop-menu"
      tooltip={tip(copy().control.menu)}
      accessibilityLabel={copy().control.menu}
      accessibilityState={{ expanded: open(), disabled: off() }}
      disabled={off()}
      onPress={() => {
        if (phoneSheet()) {
          failed.set(false);
          open.set(!open());
        }
      }}
      class={`flex-row items-center justify-center gap-1 bg-pane border hover:border-ink-secondary disabled:opacity-[0.5] ${open() ? "border-ink-secondary" : "border-line"} ${
        props.label ? "px-[10px] rounded-(--radius-sm)" : "px-2 rounded-full"
      } ${small() ? "h-[26px] min-w-[26px]" : "h-[34px] min-w-[34px]"}`}
    >
      <Icon name="stop" size={12} class="tint-ink-secondary" />
      <If when={props.label}>{(label) => <Text class="text-[12px] font-medium text-ink-secondary">{label()}</Text>}</If>
      <Icon name={below() ? "chevron-down" : "chevron-up"} size={12} class="tint-ink-secondary" />
    </View>
  );

  return (
    <View class="shrink-0 relative">
      <If when={!phoneSheet()} else={trigger}>
        <Menu
          open={open()}
          placement={below() ? "bottom" : "top"}
          align="end"
          offset={6}
          onOpenChange={(e) => {
            if (e.open) failed.set(false);
            open.set(e.open);
          }}
          trigger={trigger}
          popupClass="min-w-[200px] max-w-[320px] p-1 bg-pane border border-line rounded-(--radius-md)"
          popupStyle={{ boxShadow: shadow("menu") }}
        >
          <Each of={props.items} key={(item) => item.key}>
            {(item) => (
              <MenuItem
                testID={`stop-item-${item().key}`}
                accessibilityLabel={item().label}
                onSelect={() => void pick(item())}
                class="px-[10px] py-[7px] rounded-(--radius-sm) hover:bg-chip focus:bg-chip"
              >
                <Text class="text-[13px] text-ink line-clamp-1">{item().label}</Text>
              </MenuItem>
            )}
          </Each>
        </Menu>
      </If>
      <If when={phoneSheet() && open()}>
        <BottomSheet title={copy().control.menu} closeLabel={copy().common.close} onClose={() => open.set(false)}>
          <View role="menu" accessibilityLabel={copy().control.menu}>
            <Each of={props.items} key={(item) => item.key}>
              {(item) => <SheetItem role="menuitem" testID={`stop-item-${item().key}`} icon="stop" label={item().label} onPress={() => void pick(item())} />}
            </Each>
          </View>
        </BottomSheet>
      </If>
      <If when={failed() && !open()}>
        <View
          role="text"
          testID="stop-menu-failed"
          class={`absolute right-0 px-2 py-1 bg-pane border border-line rounded-(--radius-sm) ${below() ? "top-[40px]" : "bottom-[40px]"}`}
          style={{ boxShadow: shadow("menu") }}
        >
          <Text class="text-[12px] text-danger-text">{copy().control.failed}</Text>
        </View>
      </If>
    </View>
  );
}
