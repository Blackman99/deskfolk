/**
 * What a dropdown opens as on a phone (`BottomSheet.svelte`): a sheet from the bottom of the
 * window, rows sized for a thumb, over a scrim. Mount it while it is open (`<If when={open}>`), as
 * the Svelte one. The backdrop and ✕ close it with `onClose`; Back and Escape do `onBack ?? onClose`,
 * one level up in a sheet that goes down a level at a time.
 *
 * It comes in by a style transition, as the Svelte sheet's CSS did: on the web the browser moves it
 * on its compositor, so the page's main thread being busy (the sheet's own content mounting, a Bot's
 * reply arriving) doesn't stop it. `Sheet` (nsh/base) steps its motion on the main thread every
 * frame, and a phone dropped most of them. A sheet that `holdsText` stays on `Sheet`, which lifts it
 * above the keyboard.
 *
 * `SheetItem` and `SheetSeparator` are the rows every sheet's list is made of.
 */
import { cleanup, safeArea, Scroll, signal, Text, View, type JSX, type ViewStyle } from "nsh";
import { Dialog, Sheet } from "nsh/base";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";
import { reduceMotion } from "./interface/motion";
import { SCRIM_BLUR, shadow } from "./styles";
import { WheelLayer } from "../platform/wheel-layer";
import { runtime } from "../runtime";

type BottomSheetProps = {
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
  /** It has a text field: it rises above the keyboard (`Sheet`), at the cost of a stepped entrance. */
  holdsText?: boolean;
  /**
   * What it holds scrolls itself (a tree, a list that makes only the rows in view): no scroll view of
   * the sheet's goes around it. Around one, the two showed two bars, and the outer one took swipes.
   */
  scrollsItself?: boolean;
  testID?: string;
  children?: JSX.Element;
};

export function BottomSheet(props: BottomSheetProps) {
  return (
    <If when={props.holdsText} else={<SlidingSheet p={props} />}>
      <LiftingSheet p={props} />
    </If>
  );
}

/** The Svelte sheet's entrance: 240 ms on a curve that covers most of the way in the first frames. */
const SLIDE: ViewStyle = { transitionProperty: "transform", transitionDuration: 240, transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)" };
const FADE: ViewStyle = { transitionProperty: "opacity", transitionDuration: 180, transitionTimingFunction: "ease" };

/**
 * A dialog of its own drawing: the scrim and the panel, which start away and come in once the
 * dialog is shown (`onOpen`, so the browser has drawn where they start). Until then they carry no
 * transition: a view made with one moved from the style's default to where it starts, so the panel
 * showed in place for a frame and then jumped. Until then the whole stays unseen too. The scrim is
 * ours, not the dialog's: the dialog's would also report a press on it as a cancel, and a sheet with
 * levels would take that for Back.
 */
function SlidingSheet(props: { p: BottomSheetProps }) {
  const p = props.p;
  const still = reduceMotion();
  const shown = signal(still);
  const show = () => shown.set(true);
  // Should the dialog never say it is shown, the panel still comes in.
  const late = setTimeout(show, 400);
  cleanup(() => clearTimeout(late));
  return (
    <Dialog
      open
      animation="none"
      accessibilityLabel={p.title ?? p.label ?? undefined}
      closeOnEscape={runtime.hosted || !p.onBack}
      closeOnBackdropPress={false}
      onOpen={show}
      // One level up, a turn later: the dialog reads `closeOnEscape` as soon as this returns.
      // On the hosted phone page Back between levels is the route's (`holdLevels`), so a cancel here closes.
      onCancel={() => {
        if (p.onBack && !runtime.hosted) queueMicrotask(() => p.onBack?.());
      }}
      onOpenChange={(e) => {
        if (!e.open) p.onClose();
      }}
      class="absolute inset-0"
      style={{ opacity: shown() ? 1 : 0 }}
    >
      <View
        testID="bottom-sheet-backdrop"
        accessibilityLabel={p.closeLabel}
        class="absolute inset-0 bg-modal-backdrop"
        style={{ ...SCRIM_BLUR, ...(shown() ? { opacity: 1, ...(still ? {} : FADE) } : { opacity: 0 }) }}
        onPress={() => p.onClose()}
      />
      <View
        testID="bottom-sheet-panel"
        class={`absolute left-0 right-0 bottom-0 bg-pane rounded-t-[16px] max-h-[86%] ${p.class ?? ""}`}
        style={{ boxShadow: shadow("lg"), paddingBottom: safeArea().bottom, ...(shown() ? { translate: "0 0", ...(still ? {} : SLIDE) } : { translate: "0 100%" }) }}
      >
        <SheetBody p={p} />
      </View>
    </Dialog>
  );
}

/** On `Sheet` (nsh/base): it rises above the keyboard, and swipes down to close. */
function LiftingSheet(props: { p: BottomSheetProps }) {
  const p = props.p;
  return (
    <Sheet
      open
      side="bottom"
      closeOnSwipe
      onOpenChange={(e) => {
        if (e.open) return;
        if (e.reason === "cancel" && !runtime.hosted) (p.onBack ?? p.onClose)();
        else p.onClose();
      }}
      backdropClass="bg-modal-backdrop"
      backdropStyle={SCRIM_BLUR}
      popupClass={`bg-pane rounded-t-[16px] max-h-[86%] ${p.class ?? ""}`}
      popupStyle={{ boxShadow: shadow("lg"), paddingBottom: safeArea().bottom }}
    >
      <SheetBody p={p} />
    </Sheet>
  );
}

function SheetBody(props: { p: BottomSheetProps }) {
  const p = props.p;
  return (
    <WheelLayer>
      <View testID={p.testID} accessibilityLabel={p.title ?? p.label ?? undefined} class="shrink min-h-0">
        <View class="w-[36px] h-[4px] rounded-full bg-line self-center mt-[8px] mb-[4px]" accessible={false} />
        <If when={p.title}>
          {(title) => (
            <View class={`flex-row items-center gap-2 pt-[2px] pb-[6px] pr-2 ${p.onBack ? "pl-1" : "pl-5"}`}>
              <If when={p.onBack}>
                <IconButton icon="chevron-left" size="lg" testID="bottom-sheet-back" label={p.backLabel ?? ""} class="rounded-full" onPress={() => p.onBack?.()} />
              </If>
              <Text role="header" class="flex-1 min-w-0 text-[16px] font-semibold text-ink line-clamp-1">{title()}</Text>
              <IconButton icon="x" size="lg" label={p.closeLabel} testID="bottom-sheet-close" class="rounded-full" onPress={() => p.onClose()} />
            </View>
          )}
        </If>
        <If when={p.scrollsItself} else={<Scroll class="shrink min-h-0 px-2 pt-1 pb-3">{p.children}</Scroll>}>
          <View class="shrink min-h-0 px-2 pt-1 pb-3">{p.children}</View>
        </If>
      </View>
    </WheelLayer>
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
  /** Drawn where `icon` would be, when the row wears something other than an icon (an agent's logo). */
  leading?: JSX.Element;
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
      {props.leading}
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
