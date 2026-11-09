/**
 * Focus mode's switch (`FocusToggle.svelte`; see `m/chat/focus-mode.svelte.ts`), beside the working
 * filter: next to the mark, or next to the search on a phone. Settings › General has the same switch.
 */
import { View } from "nsh";
import { copy } from "../../runtime";
import { focusMode } from "../../m/chat/focus-mode.svelte";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { SIDE_MUTED_TINT } from "../glass";

export function FocusToggle() {
  const on = () => focusMode.on;
  const phone = () => narrowWindow();
  const box = () =>
    phone()
      ? `w-[38px] h-[38px] rounded-(--radius-md) border ${on() ? "border-accent-border bg-accent-tint" : "border-line bg-pane active:bg-row-hover"}`
      : `w-[30px] h-[30px] rounded-(--radius-sm) border ${on() ? "border-accent-border bg-accent-tint" : "border-transparent hover:bg-row-hover"}`;
  return (
    <View
      role="button"
      testID="focus-toggle"
      tooltip={tip(on() ? copy().sidebar.focusModeOff : copy().sidebar.focusMode)}
      accessibilityLabel={copy().settings.focusMode}
      accessibilityState={{ pressed: on() }}
      onPress={() => focusMode.toggle()}
      class={`cursor-pointer select-none group shrink-0 items-center justify-center focus-visible:border-brand ${box()}`}
    >
      <Icon name="target" class={on() ? "tint-brand" : phone() ? "tint-ink-secondary" : `${SIDE_MUTED_TINT} group-hover:tint-ink`} />
    </View>
  );
}
