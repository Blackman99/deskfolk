/** The list's "only what is working or unread" switch (`WorkingFilter.svelte`). Beside the mark, or beside the search on a phone. */
import { View } from "nsh";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";

export function WorkingFilter(props: { workingOnly: boolean; toggleWorkingOnly: () => void }) {
  const on = () => props.workingOnly;
  const phone = () => narrowWindow();
  const box = () =>
    phone()
      ? `w-[38px] h-[38px] rounded-(--radius-md) border ${on() ? "border-accent-border bg-accent-tint" : "border-line bg-pane active:bg-row-hover"}`
      : `w-[30px] h-[30px] rounded-(--radius-sm) border ${on() ? "border-accent-border bg-accent-tint" : "border-transparent hover:bg-row-hover"}`;
  return (
    <View
      role="button"
      testID="working-filter"
      tooltip={tip(on() ? copy().sidebar.workingOnlyOff : copy().sidebar.workingOnly)}
      accessibilityLabel={copy().sidebar.workingOnly}
      accessibilityState={{ pressed: on() }}
      onPress={() => props.toggleWorkingOnly()}
      class={`group shrink-0 items-center justify-center focus-visible:border-brand ${box()}`}
    >
      <Icon name="activity" class={on() ? "tint-brand" : phone() ? "tint-ink-secondary" : "tint-ink-muted group-hover:tint-ink"} />
    </View>
  );
}
