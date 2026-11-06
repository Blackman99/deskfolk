/**
 * The two buttons of a settings subpage's head that only a phone shows (`settings/SettingsSubpageButton.svelte`):
 * Back, and ✕ (on a wide window the editor's own dismiss button is the ✕, so this one stays hidden
 * there). Narrow means 680 wide or less (`narrowWindow()`). What each does, and whether it is busy,
 * is the caller's.
 *
 * Props: `kind` ("back" | "close"); `label` (the accessible name, and the hover text unless `title`
 * says otherwise); `title` (the hover text, when it differs from `label`; either stands in for the
 * other); `disabled`; `onPress`; `testID`.
 */
import { Text, View } from "nsh";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";

export function SettingsSubpageButton(props: {
  kind: "back" | "close";
  label?: string;
  title?: string;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const name = () => props.label ?? props.title ?? "";
  const hover = () => props.title ?? props.label ?? "";
  return (
    <If when={narrowWindow()}>
      <View
        role="button"
        testID={props.testID}
        accessibilityLabel={name()}
        accessibilityState={{ disabled: props.disabled === true }}
        tooltip={tip(hover())}
        disabled={props.disabled}
        onPress={() => props.onPress()}
        class="w-10 h-11 shrink-0 items-center justify-center rounded-(--radius-md) active:bg-row-hover disabled:opacity-[0.45]"
      >
        <If when={props.kind === "back"} else={<Text class="text-[16px] text-ink-muted">✕</Text>}>
          <Icon name="chevron-left" size={20} class="tint-brand" />
        </If>
      </View>
    </If>
  );
}
