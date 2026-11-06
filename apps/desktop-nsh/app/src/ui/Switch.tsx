/**
 * The app's on/off switch (`Switch.svelte`): a 40×22 track with an 18pt thumb, the brand colour when
 * on. Behaviour (presses, keys, the switch role) is nsh/base's; this is its look.
 */
import { type JSX } from "nsh";
import { Switch as BaseSwitch } from "nsh/base";

export function Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  testID?: string;
  children?: JSX.Element;
}) {
  return (
    <BaseSwitch
      checked={props.checked}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      testID={props.testID}
      onChange={(e) => props.onChange(e.checked)}
      class="flex-row items-center gap-2 disabled:opacity-[0.5]"
      trackClass="w-[40px] h-[22px] rounded-full bg-line checked:bg-brand justify-center px-[2px]"
      thumbClass="w-[18px] h-[18px] rounded-full bg-switch-thumb checked:translate-x-[18px]"
    >
      {props.children}
    </BaseSwitch>
  );
}
