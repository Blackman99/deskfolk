/**
 * The tools menu's button (`ToolsToggle.svelte`): in the footer on a wide list, beside the search on a
 * phone. The menu itself is the sidebar's (`ToolsMenu`); this is only its anchor, and the arrow keys
 * that open it. `onAnchor` hands over the button, which is what the menu hangs off.
 */
import { cleanup, effect, keymap, signal, Text, View, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";
import { footActionClass, footActionInk } from "./foot-action";

export function ToolsToggle(props: {
  phone: boolean;
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  /** ArrowUp opens with the last item focused. */
  onFocusLast?: (last: boolean) => void;
  onAnchor?: (node: ViewRef) => void;
  /** The footer row's state: a list under ~300px tightens, and the row with no room keeps its icons only. */
  tight?: boolean;
  iconsOnly?: boolean;
  /** The button's width as laid out, for the footer's measure of whether its words fit. */
  onWidth?: (width: number) => void;
}) {
  const open = () => props.open === true;
  const focused = signal(false);
  const ink = () => footActionInk(open());

  // The arrows open the menu only while the button has the focus.
  effect(() => {
    if (!focused()) return;
    const off = [
      keymap.bind("down", () => openFrom(false), { when: "always" }),
      keymap.bind("up", () => openFrom(true), { when: "always" }),
    ];
    return () => off.forEach((f) => f());
  });
  cleanup(() => focused.set(false));

  function openFrom(last: boolean): void {
    props.onFocusLast?.(last);
    props.onOpenChange(true);
  }

  return (
    <View
      role="button"
      testID="tools-toggle"
      ref={(node: ViewRef) => props.onAnchor?.(node)}
      tooltip={tip(copy().sidebar.tools)}
      accessibilityLabel={copy().sidebar.tools}
      accessibilityState={{ expanded: open() }}
      onFocus={() => focused.set(true)}
      onBlur={() => focused.set(false)}
      onLayout={(e) => props.onWidth?.(e.bounds.size.width)}
      onPress={() => props.onOpenChange(!open())}
      hoverStyle={props.phone ? undefined : { boxShadow: shadow("xs") }}
      class={`group ${
        props.phone
          ? `w-[38px] h-[38px] items-center justify-center rounded-(--radius-md) border ${open() ? "bg-row-hover border-line-hover" : "bg-pane border-line active:bg-row-hover"}`
          : footActionClass({ active: open(), tight: props.tight, iconsOnly: props.iconsOnly })
      }`}
    >
      <Icon name="grid" class={props.phone ? (open() ? "tint-ink" : "tint-ink-secondary") : ink().tint} />
      <If when={!props.phone && !props.iconsOnly}>
        <Text class={`text-[12px] font-medium ${ink().text}`}>{copy().sidebar.tools}</Text>
        <If when={!props.tight}>
          <Icon name="chevron-up" size={12} class={`${ink().tint} opacity-[0.65]`} />
        </If>
      </If>
    </View>
  );
}
