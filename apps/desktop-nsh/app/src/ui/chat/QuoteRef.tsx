/** The line a message answers, above its text: who said it and how it began; a press goes to it (`QuoteRef.svelte`). */
import { Text, token, View } from "nsh";
import type { Message, SessionSummary } from "@real-bot/protocol";
import type { MessageLookup } from "../../m/chat/chat-view";
import { quotePreview } from "../../m/chat/quote-reply";
import { copy, runtime } from "../../runtime";

export function QuoteRef(props: {
  message: Message;
  selected: SessionSummary | null;
  messageLookup: MessageLookup;
  who: (message: Message) => string;
  /** Inside your own bubble, on the accent: the quote is drawn in the bubble's ink. */
  inverted?: boolean;
}) {
  const quoted = () => (props.message.parent_id ? props.messageLookup.byId.get(props.message.parent_id) : undefined);
  const ink = () => token(props.inverted ? "on-accent" : "ink");
  return (
    <If when={props.message.parent_id}>
      <View
        role="button"
        testID="quote-ref"
        onPress={() => {
          const q = quoted();
          if (q) void runtime.setHighlightedMessage(q.id, props.selected?.id);
        }}
        class="w-full mb-[8px] px-[10px] py-[6px] gap-[2px] overflow-hidden"
        style={{ borderTopRightRadius: 8, borderBottomRightRadius: 8, borderLeftWidth: 2, borderLeftColor: ink() }}
      >
        <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: ink(), opacity: 0.08 }} accessible={false} />
        <Text class="text-[11px] font-semibold" style={{ color: ink() }}>{quoted() ? props.who(quoted()!) : copy().top.deleted}</Text>
        <Text class="text-[12px] line-clamp-1" style={{ color: ink(), opacity: 0.92 }}>{quotePreview(quoted()?.body ?? "")}</Text>
      </View>
    </If>
  );
}
