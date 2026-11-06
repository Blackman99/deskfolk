/**
 * The line above the box naming the message being replied to (`ComposerQuote.svelte`): whose it
 * is, a one-line preview, and ✕ to drop the reply.
 */
import { Text, View } from "nsh";
import { USER_MEMBER, type Bot, type Message } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { quotePreview, quotedBotName } from "../../m/chat/quote-reply";
import { IconButton } from "../IconButton";

export function ComposerQuote(props: { message: Message; botsById: Map<string, Bot>; onCancel: () => void }) {
  const label = () => {
    const t = copy();
    if (props.message.author === USER_MEMBER) return t.chat.replyToYou;
    const name = quotedBotName(props.message, props.botsById);
    return name ? t.chat.replyTo(name) : t.chat.replyToDeleted;
  };
  return (
    <View testID="composer-quote" class="flex-row items-start gap-2 pl-3 pr-[10px] py-2 mb-1 border-b border-line-subtle border-l-2 border-l-brand">
      <View class="flex-1 min-w-0 gap-1">
        <Text testID="composer-quote-who" class="text-[12px] font-semibold text-brand">{label()}</Text>
        <Text testID="composer-quote-body" class="text-[12px] text-ink-muted line-clamp-1">{quotePreview(props.message.body)}</Text>
      </View>
      <IconButton icon="x" size="xs" label={copy().chat.cancelReply} testID="composer-quote-cancel" onPress={props.onCancel} />
    </View>
  );
}
