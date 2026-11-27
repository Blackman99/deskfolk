/**
 * The phone's + in a composer (ADR 0116 addendum 2026-11-23, 「输入框范围有限」). A phone's row had no
 * room for the clip, plan mode, the consultants and the model picker side by side: at 360 pt a
 * Claude Code session with three consultants and the microphone left the picker some 20 pt, and a
 * run's Stop beside Send pushed it off. So on a phone one + holds them, as the agents' own phone apps
 * do, and opens a sheet from the bottom with a row for each that says where it stands (the model and
 * level, who the consultants are). A switch flips where it is; the model and the consultants open
 * their own sheets over this one (`TunePicker` bare, `ConsultPill` without its pill), so Back comes
 * back here; picking files puts the sheet away first. Those two are held in this sheet's content,
 * not elsewhere in the composer: in the phone e2e a dialog opened from under another one did not
 * show on the web. What changes what Send does stays on the row as a chip while it is on (plan
 * mode, the consultants), one press from off; the composers draw those.
 *
 * The composer gives the rows (`children`, handed the sheet's `close`); `PlusSwitch` is a row that
 * is a switch, its track at the end, so a thumb anywhere on it flips it.
 */
import { signal, Text, View, type JSX } from "nsh";
import { Switch as BaseSwitch } from "nsh/base";
import { copy } from "../../runtime";
import { BottomSheet } from "../BottomSheet";
import { Icon, type IconName } from "../Icon";

export function ComposerPlus(props: {
  testID: string;
  disabled: boolean;
  /** Subtle circular button fill when sitting beside an inline input pill on a phone. */
  filled?: boolean;
  /** The sheet's rows; `close` puts the sheet away. */
  children: (close: () => void) => JSX.Element;
}) {
  const t = () => copy();
  const open = signal(false);
  const close = () => open.set(false);
  return (
    <>
      <View
        role="button"
        testID={props.testID}
        accessibilityLabel={t().composer.more}
        accessibilityState={{ expanded: open(), disabled: props.disabled }}
        disabled={props.disabled}
        onPress={() => open.set(true)}
        class={`cursor-pointer select-none disabled:cursor-default shrink-0 w-[40px] h-[40px] items-center justify-center rounded-full active:scale-[0.96] active:bg-line-subtle disabled:opacity-[0.4] ${props.filled ? "bg-chip border border-line hover:bg-line-subtle" : ""}`}
      >
        <Icon name="plus" size={20} class="tint-ink-secondary" />
      </View>
      <If when={open()}>
        <BottomSheet title={t().composer.more} closeLabel={t().common.close} onClose={close} testID={`${props.testID}-sheet`}>
          <View accessibilityLabel={t().composer.more}>{props.children(close)}</View>
        </BottomSheet>
      </If>
    </>
  );
}

/** A sheet row that is a switch (`SheetItem`'s size): its icon, words and what it does, the track at the end. */
export function PlusSwitch(props: {
  testID: string;
  icon: IconName;
  label: string;
  detail?: string | null;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <BaseSwitch
      testID={props.testID}
      checked={props.checked}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      onChange={(e) => props.onChange(e.checked)}
      class="cursor-pointer select-none disabled:cursor-default flex-row-reverse items-center gap-3 w-full min-h-[48px] px-3 py-[10px] rounded-(--radius-md) active:bg-line-subtle disabled:opacity-[0.45]"
      trackClass="shrink-0 w-[40px] h-[22px] rounded-full bg-line checked:bg-brand justify-center px-[2px]"
      thumbClass="w-[18px] h-[18px] rounded-full bg-switch-thumb checked:translate-x-[18px]"
    >
      <View class="flex-1 min-w-0 flex-row items-center gap-3">
        <Icon name={props.icon} size={20} class={props.checked ? "tint-brand" : "tint-ink"} />
        <View class="flex-1 min-w-0">
          <Text class="text-[15px] text-ink line-clamp-1">{props.label}</Text>
          <If when={props.detail}>{(detail) => <Text class="text-[12px] text-ink-muted line-clamp-2">{detail()}</Text>}</If>
        </View>
      </View>
    </BaseSwitch>
  );
}

/** The chevron a row wears when it opens a sheet of its own. */
export const Deeper = () => <Icon name="chevron-right" size={16} class="tint-ink-muted" />;
