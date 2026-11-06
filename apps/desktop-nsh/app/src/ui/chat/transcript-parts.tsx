/**
 * What the transcript's three message groups (`TranscriptUserGroup`, `TranscriptBotGroup`,
 * `TranscriptSystem`) share, each drawn once here: the Bot's portrait, the name over a Bot's line,
 * the ring a found or selected line wears, the rise of a line that has just arrived, and the
 * hover pill of a message (quick reactions, reply, edit, copy, more).
 *
 * The pill of the Svelte groups is a CSS-hover strip; here it is drawn while the pointer is over the
 * segment (`onMouseEnter` / `onMouseLeave`), absolutely placed on the segment's top edge so it never
 * moves the layout. On a phone (window 680 wide or less) it has no job: the long press opens the menu.
 */
import { createMotion, reduceMotion, Text, token, View, type JSX, type Point, type ViewStyle } from "nsh";
import type { Bot, Message } from "@real-bot/protocol";
import { avatarSrc, botAvatarColor } from "../../m/avatar.ts";
import { QUICK_REACTIONS } from "../../m/chat/quick-reactions.ts";
import { canQuoteReply } from "../../m/chat/quote-reply.ts";
import type { TranscriptStage } from "../../m/chat/transcript-stage.ts";
import { rosterLetter } from "../../m/sidebar/roster-letter.ts";
import { copy, runtime } from "../../runtime";
import { AvatarPicture } from "../AvatarPicture";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { cssColor, shadow } from "../styles";
import { tip } from "../tip";

/** A secondary press on a message (right click, long press) or the pill's "more": the shell opens the message's menu at `position`. */
export type MessageMenuHandler = (message: Message, position: Point) => void;

/** The 32px portrait of a Bot (or `?` for one that is gone); pressing it opens the Bot's profile. `glow`: it is working. */
export function BotPortrait(props: { bot: Bot | undefined; author: string; stage: TranscriptStage; glow?: boolean; testID?: string }) {
  const pal = () => botAvatarColor(props.author);
  const face = () => (
    <View
      class="w-[32px] h-[32px] rounded-[10px] items-center justify-center overflow-hidden border"
      style={{
        backgroundColor: cssColor(pal().bg),
        borderColor: cssColor(pal().border),
        boxShadow: props.glow ? `0 0 0 2px ${token("accent-glow")}` : shadow("xs"),
      }}
    >
      <If
        when={props.bot}
        else={
          <Text class="text-[13px] font-bold" style={{ color: cssColor(pal().text) }}>
            {rosterLetter("?")}
          </Text>
        }
      >
        {(bot: () => Bot) => (
          <If
            when={avatarSrc(bot().avatar)}
            else={
              <Text class="text-[13px] font-bold" style={{ color: cssColor(pal().text) }}>
                {rosterLetter(bot().name)}
              </Text>
            }
          >
            <AvatarPicture avatar={bot().avatar} alt={bot().name} />
          </If>
        )}
      </If>
    </View>
  );
  return (
    <View class="shrink-0 items-center">
      <If when={props.bot} else={<View testID={props.testID} tooltip={tip(copy().top.deleted)}>{face()}</View>}>
        {(bot: () => Bot) => (
          <View
            role="button"
            testID={props.testID ?? "bot-avatar"}
            accessibilityLabel={copy().top.botSettings}
            tooltip={tip(copy().top.botSettings)}
            onPress={() => props.stage.onOpenProfile(bot().id)}
            class="hover:scale-[1.06]"
          >
            {face()}
          </View>
        )}
      </If>
    </View>
  );
}

/** A Bot's name over its lines: pressing it opens the Bot's profile. */
export function SenderName(props: { bot: Bot | undefined; label: string; stage: TranscriptStage; testID?: string }) {
  return (
    <If when={props.bot} else={<Text class="text-[13px] font-semibold text-ink">{props.label}</Text>}>
      {(bot: () => Bot) => (
        <View
          role="button"
          testID={props.testID ?? "sender-name"}
          tooltip={tip(copy().top.botSettings)}
          onPress={() => props.stage.onOpenProfile(bot().id)}
          class="group min-w-0 shrink"
        >
          <Text class="text-[13px] font-semibold text-ink group-hover:text-brand line-clamp-1">{props.label}</Text>
        </View>
      )}
    </If>
  );
}

/** A quiet tag beside a name (「Bot」, 「Deskfolk」): the accent is kept for what you can act on. */
export function Badge(props: { children: string; testID?: string }) {
  return (
    <View testID={props.testID} class="shrink-0 px-[5px] py-[1px] rounded-(--radius-xs) border border-line">
      <Text class="text-[10px] font-semibold text-ink-muted">{props.children}</Text>
    </View>
  );
}

/** A found line's and a selected line's ring and wash. */
export function ringStyle(on: boolean): ViewStyle | undefined {
  return on ? { backgroundColor: token("accent-tint"), boxShadow: `0 0 0 2px ${token("accent-border")}` } : undefined;
}

/**
 * A row that has just arrived rises into place (`msg-arrive`); history and a reply replacing its
 * working bubble do not. `on` is read once, when the row mounts.
 */
export function arriveMotion(on: () => boolean) {
  const m = createMotion();
  if (on() && !reduceMotion()) void m.play({ duration: 260, keyframes: { opacity: [0, 1], translateY: [8, 0] } });
  return m;
}

const PILL_BUTTON = "min-w-[24px] h-[24px] px-[5px] rounded-[7px] flex-row items-center justify-center gap-[4px] hover:bg-row-hover active:scale-[0.92]";

/**
 * The pill that stands on a message's top edge while the pointer is over it. `top`: how far above
 * the segment (your bubble's steps a little onto it). `extra`: a Bot's middle part keeps its time
 * here. `onEdit` is given for a line of yours that can still be changed.
 */
export function MessageToolbar(props: {
  message: Message;
  stage: TranscriptStage;
  onMenu?: MessageMenuHandler;
  /** Your own bubble's: reply and edit, on the right. */
  side: "you" | "bot";
  extra?: JSX.Element;
  onEdit?: () => void;
}) {
  const t = () => copy();
  const copied = () => props.stage.copiedMessageId === props.message.id;
  return (
    <View
      testID="msg-toolbar"
      class={`absolute z-10 ${props.side === "you" ? "right-[8px]" : "left-[8px] right-[8px] items-end"}`}
      style={{ top: props.side === "you" ? -26 : -30 }}
    >
      <View
        class="flex-row items-center gap-[1px] p-[2px] bg-pane border border-line rounded-(--radius-md)"
        style={{ boxShadow: shadow("md") }}
      >
        <If when={!props.stage.lockedComposer}>
          <Each of={[...QUICK_REACTIONS]}>
            {(emoji) => (
              <View
                role="button"
                testID={`react-${emoji()}`}
                accessibilityLabel={t().chat.reactWith(emoji())}
                tooltip={tip(emoji())}
                onPress={() => void runtime.toggleReaction(props.message.id, emoji())}
                class="w-[24px] h-[24px] rounded-[7px] items-center justify-center hover:bg-row-hover hover:scale-[1.15] active:scale-[0.95]"
              >
                <Text class="text-[14px]">{emoji()}</Text>
              </View>
            )}
          </Each>
          <View class="w-px h-[14px] mx-[3px] bg-line" accessible={false} />
        </If>
        {props.extra}
        <If when={canQuoteReply(props.message) && !props.stage.lockedComposer}>
          <View
            role="button"
            testID="act-reply"
            accessibilityLabel={t().chat.replyMessage}
            tooltip={tip(t().chat.replyMessage)}
            onPress={() => props.stage.startQuoteReply(props.message)}
            class={`group ${PILL_BUTTON}`}
          >
            <Icon name="reply" size={12} class="tint-ink-muted group-hover:tint-ink" />
          </View>
        </If>
        <If when={props.onEdit}>
          <View
            role="button"
            testID="act-edit"
            accessibilityLabel={t().chat.editThisLine}
            tooltip={tip(t().chat.editMessage)}
            onPress={() => props.onEdit?.()}
            class={`group ${PILL_BUTTON}`}
          >
            <Icon name="edit" size={12} class="tint-ink-muted group-hover:tint-ink" />
          </View>
        </If>
        <View
          role="button"
          testID="act-copy"
          accessibilityLabel={t().chat.copyMessage}
          tooltip={tip(t().chat.copyMessage)}
          onPress={() => props.stage.copyMessageBody(props.message.id, props.message.body)}
          class={`group ${PILL_BUTTON}`}
        >
          <If when={copied()} else={<Icon name="copy" size={12} class="tint-ink-muted group-hover:tint-ink" />}>
            <Text class="text-[11px] font-semibold text-ok">{`✓ ${t().chat.copied}`}</Text>
          </If>
        </View>
        <View
          role="button"
          testID="act-more"
          accessibilityLabel={t().chat.moreActions}
          tooltip={tip(t().chat.moreActions)}
          onPress={(e) => props.onMenu?.(props.message, e.pagePosition)}
          class={`group ${PILL_BUTTON}`}
        >
          <Icon name="more" size={12} class="tint-ink-muted group-hover:tint-ink" />
        </View>
      </View>
    </View>
  );
}

/** Whether the hover pill is wanted at all: not on a phone, where the long press opens the menu. */
export const toolbarWanted = () => !narrowWindow();
