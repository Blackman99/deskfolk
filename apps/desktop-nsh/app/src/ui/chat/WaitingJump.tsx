/**
 * A small chip above the composer while something here waits on you (an approval, a question) and
 * its card is scrolled out of sight (`WaitingJump.svelte`). One press brings the card back into
 * view. The Svelte one measured the cards itself with `querySelector` and rects; NSH has no DOM,
 * so the transcript's owner measures (`hiddenWaiting` in `waiting-jump.ts` is the Svelte's logic)
 * and passes what is out of sight as `hidden`.
 */
import { Text, View } from "nsh";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import type { HiddenWaiting } from "./waiting-jump";

export function WaitingJump(props: { hidden: HiddenWaiting; onJump: (id: string) => void }) {
  const approvals = () => props.hidden.items.filter((item) => item.kind === "approval").length;
  const asks = () => props.hidden.items.filter((item) => item.kind === "ask").length;
  const label = () => {
    const t = copy().stream.waitingJump;
    return approvals() && asks() ? t.both(approvals() + asks()) : approvals() ? t.approvals(approvals()) : t.asks(asks());
  };
  const ask = () => approvals() === 0;
  return (
    <If when={props.hidden.items.length > 0}>
      <View
        role="button"
        testID="waiting-jump"
        accessibilityLabel={label()}
        onPress={() => props.onJump(props.hidden.items[0]!.id)}
        class={`cursor-pointer select-none flex-row items-center self-start gap-[6px] h-[32px] pl-[10px] pr-3 rounded-full border active:scale-[0.97] ${ask() ? "bg-purple-bg border-purple-line hover:border-purple" : "bg-warn-bg border-warn-line hover:border-warn"}`}
        style={{ boxShadow: shadow("md") }}
      >
        <Icon name={approvals() ? "shield-check" : "help-circle"} size={12} class={ask() ? "tint-purple-text" : "tint-warn-text"} />
        <Text testID="waiting-jump-label" class={`text-[12px] font-semibold ${ask() ? "text-purple-text" : "text-warn-text"}`}>{label()}</Text>
        <Icon name={props.hidden.above ? "arrow-up" : "arrow-down"} size={12} class={ask() ? "tint-purple-text" : "tint-warn-text"} />
      </View>
    </If>
  );
}
