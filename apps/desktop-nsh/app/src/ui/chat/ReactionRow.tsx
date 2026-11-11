/** A message's reactions under it, one chip per emoji; on your own lines they keep to the right (`ReactionRow.svelte`). */
import { Text, View } from "nsh";
import { USER_MEMBER, type Message } from "@real-bot/protocol";
import { groupReactions } from "../../m/chat/chat-view";
import { runtime } from "../../runtime";

export function ReactionRow(props: {
  message: Message;
  lockedComposer: boolean;
  /** Your own line's: the row keeps to the right, under the bubble. */
  right?: boolean;
}) {
  const groups = () => groupReactions(props.message.reactions, USER_MEMBER);
  return (
    <If when={groups().length > 0}>
      <View testID="reaction-row" class={`flex-row flex-wrap gap-[8px] mt-[8px] ${props.right ? "justify-end" : ""}`}>
        <Each of={groups()} key={(g) => g.emoji}>
          {(rx) => (
            <View
              role={props.lockedComposer ? "text" : "button"}
              testID={`reaction-${rx().emoji}`}
              accessibilityState={{ selected: rx().userReacted }}
              onPress={props.lockedComposer ? undefined : () => void runtime.toggleReaction(props.message.id, rx().emoji)}
              class={`${props.lockedComposer ? "" : "cursor-pointer select-none "}flex-row items-center gap-[4px] px-[8px] py-[2px] rounded-full border ${
                rx().userReacted ? "bg-accent-tint border-accent-border" : props.lockedComposer ? "bg-reaction-bg border-line" : "bg-reaction-bg border-line hover:bg-line-subtle hover:border-line-hover"
              }`}
            >
              <Text class="text-[12px]">{rx().emoji}</Text>
              <Text class={`font-mono text-[11px] font-semibold ${rx().userReacted ? "text-brand" : "text-ink"}`}>{rx().count}</Text>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
