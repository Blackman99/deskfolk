/**
 * The stop menu (`StopMenu.svelte`, ADR 0040 P2): a square-and-chevron button that opens the choices
 * of what to stop (this Bot, this job, every Bot; in a project session, the run or one of its
 * background tasks). Picking one hands it to the owner, which makes the stop; a refusal it hands back
 * is said by the button until your next press. On a desktop an nsh/base `Menu` (arrow keys, Escape
 * and a press outside are NSH's); on a phone the choices open as a sheet from the bottom
 * (`BottomSheet`). Nothing left to choose closes it. The button is one of the floor (`floor()`,
 * ADR 0108).
 *
 * Unlike the Svelte one (2026-11-11): beside the composer's Send the button is the composer's Stop,
 * a secondary button with a chevron; each choice has an icon of what it stops, and lines part the
 * whole conversation, its parts and every Bot, as the session menu draws its rows. Its tip goes
 * while the menu is open.
 */
import { effect, signal, Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";
import { copy } from "../../runtime";
import type { StopMenuItem } from "../../m/chat/stop-menu";
import { BottomSheet, SheetItem, SheetSeparator } from "../BottomSheet";
import { SECONDARY_LOOK } from "../Button";
import { Icon, type IconName } from "../Icon";
import { floor } from "../interface/floor";
import { shadow } from "../styles";
import { tip } from "../tip";
import { narrowWindow as phoneSheet } from "../Modal";

/** What a choice stops, by its key: the run, a background task, a conversation, a Bot, a job, every Bot. */
export function stopIcon(key: string): IconName {
  if (key.startsWith("task:")) return "terminal";
  if (key.startsWith("session:")) return "message";
  if (key.startsWith("bot:")) return "bot";
  if (key.startsWith("plan:")) return "kanban";
  if (key === "global") return "users";
  return "stop";
}

/** A line goes before choice `i`: after the whole conversation (its run, the group), and before every Bot. */
export function stopBreakBefore(items: readonly { key: string }[], i: number): boolean {
  if (i === 0) return false;
  const before = items[i - 1]!.key;
  return items[i]!.key === "global" || before === "run" || before.startsWith("session:");
}

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
  /** Beside the composer's Send: the composer's Stop, with a chevron. */
  const composer = () => !small() && !props.label;

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

  /** Open reads as hovered (`hover:` outranks a plain class, so both say the same). */
  const box = () =>
    composer()
      ? `${SECONDARY_LOOK.box} rounded-full px-[10px] gap-[5px] ${open() ? "bg-btn-secondary-hover border-line-hover" : ""}`
      : `bg-pane border hover:border-ink-secondary gap-1 ${open() ? "border-ink-secondary" : "border-line"} ${props.label ? "px-[10px] rounded-(--radius-sm)" : "px-2 rounded-full"}`;

  const trigger = (
    <View
      role="button"
      ref={floor("stop", () => (composer() ? { ink: SECONDARY_LOOK.ink, ground: ["input-bg", SECONDARY_LOOK.ground] } : { ink: "ink-secondary", ground: ["pane"] }))}
      testID="stop-menu"
      tooltip={open() ? undefined : tip(copy().control.menu)}
      accessibilityLabel={copy().control.menu}
      accessibilityState={{ expanded: open(), disabled: off() }}
      disabled={off()}
      onPress={() => {
        if (phoneSheet()) {
          failed.set(false);
          open.set(!open());
        }
      }}
      class={`cursor-pointer select-none disabled:cursor-default flex-row items-center justify-center disabled:opacity-[0.5] ${box()} ${small() ? "h-[26px] min-w-[26px]" : "h-[34px] min-w-[34px]"}`}
    >
      <Icon name="stop" size={composer() ? 16 : 12} class={composer() ? SECONDARY_LOOK.tint : "tint-ink-secondary"} />
      <If when={props.label}>{(label) => <Text class="text-[12px] font-medium text-ink-secondary">{label()}</Text>}</If>
      <Icon name={below() ? "chevron-down" : "chevron-up"} size={12} class={composer() ? "tint-ink-muted" : "tint-ink-secondary"} />
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
          popupClass="min-w-[220px] max-w-[340px] p-1 bg-pane border border-line rounded-(--radius-md)"
          popupStyle={{ boxShadow: shadow("menu") }}
        >
          <Each of={props.items} key={(item) => item.key}>
            {(item, index) => (
              <>
                <If when={stopBreakBefore(props.items, index())}>
                  <MenuSeparator class="h-[1px] bg-line-subtle my-[3px] mx-2" />
                </If>
                <MenuItem
                  testID={`stop-item-${item().key}`}
                  accessibilityLabel={item().label}
                  onSelect={() => void pick(item())}
                  class="cursor-pointer select-none group flex-row items-center gap-2 px-[10px] py-[6px] rounded-(--radius-sm) hover:bg-line-subtle focus:bg-line-subtle"
                >
                  <Icon name={stopIcon(item().key)} size={16} class="tint-ink opacity-75 group-hover:tint-brand group-focus:tint-brand" />
                  <Text class="flex-1 shrink min-w-0 text-[13px] font-medium text-ink line-clamp-1 group-hover:text-brand group-focus:text-brand">{item().label}</Text>
                </MenuItem>
              </>
            )}
          </Each>
        </Menu>
      </If>
      <If when={phoneSheet() && open()}>
        <BottomSheet title={copy().control.menu} closeLabel={copy().common.close} onClose={() => open.set(false)}>
          <View role="menu" accessibilityLabel={copy().control.menu}>
            <Each of={props.items} key={(item) => item.key}>
              {(item, index) => (
                <>
                  <If when={stopBreakBefore(props.items, index())}>
                    <SheetSeparator />
                  </If>
                  <SheetItem role="menuitem" testID={`stop-item-${item().key}`} icon={stopIcon(item().key)} label={item().label} onPress={() => void pick(item())} />
                </>
              )}
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
