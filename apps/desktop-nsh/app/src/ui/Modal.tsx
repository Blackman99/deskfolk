/**
 * The dialog frame every modal of the messenger shares (`.modal-backdrop`, `.modal-dialog`,
 * `.modal-head`, `.modal-body`, `.modal-foot` in `styles/shared.css` and `styles/modals.css`): a
 * card over the scrim, a head with the title and ✕, a body that scrolls, a foot of actions. The
 * settings, the create-Bot and create-group sheets, the memory and skill editors and every
 * confirmation wear it; each dialog's contents stay in its own component.
 *
 * It is nsh/base's `Dialog` underneath, so Escape, the phone's Back and a press on the scrim are
 * close attempts NSH reports; all of them call `onClose`, unless `busy` holds the dialog open.
 *
 * `pageOnPhone` is the messenger's `page-on-phone`: in a window 680 wide or less the dialog is the
 * whole page, its ✕ a back chevron, and only the foot's first action (full width) shows.
 */
import { Scroll, Text, View, windowSize, type JSX } from "nsh";
import { Dialog } from "nsh/base";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";
import { shadow } from "./styles";

/** The messenger's phone breakpoint (`@media (max-width: 680px)`). */
export const PHONE_WIDTH = 680;
export const narrowWindow = () => windowSize().width <= PHONE_WIDTH;

export function Modal(props: {
  /** The heading (`h2`), and the dialog's name for a screen reader. */
  title: string;
  /** The ✕'s name (`t.common.close`). */
  closeLabel: string;
  onClose: () => void;
  /** A confirmation's role: screen readers say it asks something. */
  alert?: boolean;
  /** While true nothing closes it (an action is running). */
  busy?: boolean;
  /** The card's width on a desktop (px); a phone's is the window's. */
  width?: number;
  /** Its height cap on a desktop, as a share of the window (default 0.86). */
  maxHeight?: number;
  /** The whole page in a narrow window (`page-on-phone`); a confirmation stays a dialog. */
  pageOnPhone?: boolean;
  /** The back chevron's name in that page (`t.common.back`). */
  backLabel?: string;
  /** A line under the title in that page: whose settings they are (`modal-head-subject`). */
  subject?: JSX.Element;
  /** More of the head, between the title and ✕ (a tab strip, a status). */
  headExtra?: JSX.Element;
  /** The actions (`ModalAction`s), first the one the dialog is for. */
  foot?: JSX.Element;
  /** The body's own classes (its padding, its gap). */
  bodyClass?: string;
  /** The body scrolls (default); false lays the body out as it is, for a list that scrolls itself. */
  scroll?: boolean;
  testID?: string;
  children?: JSX.Element;
}) {
  const page = () => props.pageOnPhone === true && narrowWindow();
  const close = () => {
    if (!props.busy) props.onClose();
  };
  const cardWidth = () => (narrowWindow() ? windowSize().width - (page() ? 0 : 32) : Math.min(props.width ?? 520, windowSize().width - 48));
  const cardMaxHeight = () => (page() ? windowSize().height : Math.round(windowSize().height * (props.maxHeight ?? 0.86)));
  return (
    <Dialog
      open
      animation="fade"
      closeOnEscape={!props.busy}
      closeOnBackdropPress={!props.busy}
      onCancel={close}
      onOpenChange={(e) => {
        if (!e.open) close();
      }}
      backdropClass={page() ? "bg-pane" : "bg-modal-backdrop"}
      class={`m-auto bg-pane overflow-hidden ${page() ? "" : "rounded-(--radius-xl) border border-line"}`}
      style={{
        width: cardWidth(),
        maxHeight: cardMaxHeight(),
        height: page() ? windowSize().height : undefined,
        boxShadow: page() ? undefined : "0 24px 56px -12px rgba(18, 28, 32, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.05)",
      }}
    >
      <View
        testID={props.testID}
        role={props.alert ? "alert" : "group"}
        accessibilityLabel={props.title}
        accessibilityState={{ busy: props.busy === true }}
        class="flex-col shrink min-h-0"
      >
        <View
          class={`flex-row items-center border-b border-line bg-pane ${page() ? "h-[52px] pl-1 pr-[6px] gap-[2px]" : "px-5 py-[14px] justify-between gap-3"}`}
        >
          <If when={page()}>
            <IconButton icon="chevron-left" size="lg" label={props.backLabel ?? props.closeLabel} testID="modal-back" onPress={close} />
          </If>
          <View class="flex-1 min-w-0 flex-col gap-[1px]">
            <Text role="header" class="text-[16px] font-bold text-ink line-clamp-1">
              {props.title}
            </Text>
            <If when={page() && props.subject}>{props.subject}</If>
          </View>
          {props.headExtra}
          <If when={!page()}>
            <IconButton icon="x" size="sm" label={props.closeLabel} testID="modal-close" disabled={props.busy} onPress={close} />
          </If>
        </View>
        <If
          when={props.scroll !== false}
          else={<View class={`flex-col shrink min-h-0 ${props.bodyClass ?? "px-5 py-[18px] gap-[14px]"}`}>{props.children}</View>}
        >
          <Scroll class="shrink min-h-0">
            <View class={`flex-col ${props.bodyClass ?? "px-5 py-[18px] gap-[14px]"}`}>{props.children}</View>
          </Scroll>
        </If>
        <If when={props.foot}>
          <View class={`flex-row justify-end gap-[10px] border-t border-line bg-sidebar-bg ${page() || narrowWindow() ? "px-4 py-3" : "px-5 py-[14px]"}`}>
            {props.foot}
          </View>
        </If>
      </View>
    </Dialog>
  );
}

const ACTION = {
  primary: { box: "bg-brand hover:bg-accent-hover border-transparent", ink: "text-on-accent", tint: "tint-on-accent" },
  secondary: { box: "bg-btn-secondary-bg hover:bg-line-subtle border-line hover:border-line-hover", ink: "text-ink", tint: "tint-ink" },
  deny: { box: "bg-btn-secondary-bg hover:bg-danger-bg border-danger-line hover:border-danger", ink: "text-danger-text", tint: "tint-danger-text" },
} as const;

/**
 * A button of a modal's foot (`.modal-foot button`): the first is the dialog's own action
 * (`primary`), the rest `secondary`; a confirmation's loss is `deny`. `busy` turns a spinner.
 * In a narrow window the actions share the width, sized for a thumb.
 */
export function ModalAction(props: {
  kind?: keyof typeof ACTION;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  testID?: string;
  children: string;
}) {
  const look = () => ACTION[props.kind ?? "secondary"];
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.children}
      accessibilityState={{ disabled: props.disabled === true, busy: props.busy === true }}
      disabled={props.disabled || props.busy}
      onPress={() => props.onPress()}
      class={`flex-row items-center justify-center gap-[6px] border rounded-(--radius-md) px-[18px] active:scale-[0.97] disabled:opacity-[0.45] ${narrowWindow() ? "flex-1 min-h-[46px]" : "py-2"} ${look().box}`}
      style={{ boxShadow: props.kind === "primary" ? undefined : shadow("xs") }}
    >
      <If when={props.busy}>
        <Icon name="spinner" size={12} class={`animate-spin ${look().tint}`} />
      </If>
      <If when={props.busy ? undefined : props.icon}>{(name) => <Icon name={name()} size={12} class={look().tint} />}</If>
      <Text class={`text-[13px] font-semibold line-clamp-1 ${look().ink}`}>{props.children}</Text>
    </View>
  );
}
