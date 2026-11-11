/**
 * What a dropdown opens as on a phone (`BottomSheet.svelte`): a sheet from the bottom of the
 * window, rows sized for a thumb, over a scrim. Mount it while it is open (`<If when={open}>`), as
 * the Svelte one: it is `Sheet` (nsh/base) underneath, so the backdrop, Escape and the phone's Back
 * are NSH's. The backdrop and ✕ close it with `onClose`; Back and Escape do `onBack ?? onClose`, one
 * level up in a sheet that goes down a level at a time.
 *
 * `SheetItem` and `SheetSeparator` are the rows every sheet's list is made of.
 */
import { safeArea, Scroll, Text, View, type JSX } from "nsh";
import { Sheet } from "nsh/base";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";
import { shadow } from "./styles";
import { WheelLayer } from "../platform/wheel-layer";

export function BottomSheet(props: {
  /** The heading, and the sheet's name for a screen reader. None: just the grip. */
  title?: string | null;
  /** The sheet's name for a screen reader when it has no heading (a picture's one-line menu). */
  label?: string | null;
  /** The close button's and the backdrop's name. */
  closeLabel: string;
  onClose: () => void;
  /** One level up: a Back button before the heading, and what the phone's Back and Escape do. */
  onBack?: () => void;
  backLabel?: string;
  /** Classes for the panel itself. */
  class?: string;
  testID?: string;
  children?: JSX.Element;
}) {
  return (
    <Sheet
      open
      side="bottom"
      closeOnSwipe
      onOpenChange={(e) => {
        if (e.open) return;
        if (e.reason === "cancel") (props.onBack ?? props.onClose)();
        else props.onClose();
      }}
      backdropClass="bg-modal-backdrop"
      popupClass={`bg-pane rounded-t-[16px] max-h-[86%] ${props.class ?? ""}`}
      popupStyle={{ boxShadow: shadow("lg"), paddingBottom: safeArea().bottom }}
    >
      <WheelLayer>
        <View testID={props.testID} accessibilityLabel={props.title ?? props.label ?? undefined} class="shrink min-h-0">
          <View class="w-[36px] h-[4px] rounded-full bg-line self-center mt-[8px] mb-[4px]" accessible={false} />
          <If when={props.title}>
            {(title) => (
              <View class={`flex-row items-center gap-2 pt-[2px] pb-[6px] pr-2 ${props.onBack ? "pl-1" : "pl-5"}`}>
                <If when={props.onBack}>
                  <IconButton icon="chevron-left" size="lg" testID="bottom-sheet-back" label={props.backLabel ?? ""} class="rounded-full" onPress={() => props.onBack?.()} />
                </If>
                <Text role="header" class="flex-1 min-w-0 text-[16px] font-semibold text-ink line-clamp-1">{title()}</Text>
                <IconButton icon="x" size="lg" label={props.closeLabel} testID="bottom-sheet-close" class="rounded-full" onPress={() => props.onClose()} />
              </View>
            )}
          </If>
          <Scroll class="shrink min-h-0 px-2 pt-1 pb-3">{props.children}</Scroll>
        </View>
      </WheelLayer>
    </Sheet>
  );
}

/** A row of a sheet's list (`.sheet-item`): 48pt tall, the accent when `active`, red when `danger`. */
export function SheetItem(props: {
  label: string;
  detail?: string;
  icon?: IconName;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  testID?: string;
  role?: "button" | "menuitem" | "option";
  trailing?: JSX.Element;
}) {
  const ink = () => (props.danger ? "text-danger-text" : props.active ? "text-brand font-semibold" : "text-ink");
  const tint = () => (props.danger ? "tint-danger-text" : props.active ? "tint-brand" : "tint-ink");
  return (
    <View
      role={props.role ?? "button"}
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.active, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onPress?.()}
      class="cursor-pointer select-none disabled:cursor-default flex-row items-center gap-3 w-full min-h-[48px] px-3 py-[10px] rounded-(--radius-md) active:bg-line-subtle disabled:opacity-[0.45]"
    >
      <If when={props.icon}>{(name) => <Icon name={name()} size={20} class={tint()} />}</If>
      <View class="flex-1 min-w-0">
        <Text class={`text-[15px] line-clamp-1 ${ink()}`}>{props.label}</Text>
        <If when={props.detail}>{(d) => <Text class="text-[12px] text-ink-muted line-clamp-1">{d()}</Text>}</If>
      </View>
      {props.trailing}
    </View>
  );
}

export function SheetSeparator() {
  return <View class="h-[1px] mx-3 my-[6px] bg-line" />;
}
