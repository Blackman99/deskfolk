/**
 * A phone's archived list heads itself (`MobileArchivedHead.svelte`): Back on the left, the title
 * and count in the middle. On a wider window it draws nothing.
 */
import { safeArea, Text, View } from "nsh";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";

export function MobileArchivedHead(props: { count: number; onBack: () => void }) {
  return (
    <If when={narrowWindow()}>
      <View
        testID="mobile-archived-head"
        class="flex-row items-center justify-between h-[52px] pb-[6px] pr-3 pl-2 bg-pane border-b border-line shrink-0"
        style={{ paddingTop: Math.max(6, safeArea().top) }}
      >
        <View
          role="button"
          testID="mobile-archived-back"
          tooltip={tip(copy().sidebar.backToSessions)}
          accessibilityLabel={copy().sidebar.backToSessions}
          onPress={() => props.onBack()}
          class="cursor-pointer select-none w-[38px] h-[38px] items-center justify-center rounded-(--radius-md) shrink-0 active:bg-row-hover"
        >
          <Icon name="chevron-left" size={20} class="tint-brand" />
        </View>
        <View class="flex-row items-center gap-[6px]">
          <Text role="header" class="text-[16px] font-semibold text-ink">{copy().sidebar.archivedSessions}</Text>
          <If when={props.count > 0}>
            <Text testID="mobile-archived-count" class="text-[13px] font-medium text-ink-muted">{`(${props.count})`}</Text>
          </If>
        </View>
        <View class="w-[38px] shrink-0" accessible={false} />
      </View>
    </If>
  );
}
