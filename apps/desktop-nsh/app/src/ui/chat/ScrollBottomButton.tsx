/**
 * The jump-to-the-end control (`ScrollBottomButton.svelte`): a round button that rises out from
 * behind the composer card's top right edge while the transcript is scrolled up. The slot clips it
 * to the 32pt circle plus its travel, so it grows out of the card; hidden it is pushed out of the
 * slot and takes no presses. The stage owns stick-to-bottom; this only draws the control.
 */
import { View } from "nsh";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { tip } from "../tip";

export function ScrollBottomButton(props: { shown: boolean; onScrollToBottom?: () => void }) {
  return (
    <View
      testID="scroll-bottom-slot"
      accessible={false}
      class="absolute -top-[44px] right-2 w-[32px] h-[76px] overflow-hidden"
      style={{ pointerEvents: props.shown ? "box-none" : "none" }}
    >
      <View
        role="button"
        testID="scroll-bottom"
        tooltip={tip(copy().chat.scrollToBottom)}
        accessibilityLabel={copy().chat.scrollToBottom}
        disabled={!props.shown}
        onPress={() => props.onScrollToBottom?.()}
        class="cursor-pointer select-none disabled:cursor-default group w-[32px] h-[32px] rounded-full items-center justify-center bg-input-bg border border-line hover:bg-line-subtle transition-transform duration-[220ms]"
        style={{ transform: props.shown ? "translateY(0px)" : "translateY(76px)" }}
      >
        <Icon name="chevron-down" class="tint-ink-muted group-hover:tint-brand" />
      </View>
    </View>
  );
}
