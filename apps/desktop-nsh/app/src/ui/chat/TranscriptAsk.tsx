/**
 * A Bot's question for you in the transcript (`TranscriptAsk.svelte`): the Bot's avatar and name, the
 * question's card and its answer form (`AskCard`). Waiting on your answer the card says so, in the
 * question's purple.
 *
 * The row's text-selection handlers of the Svelte one (`mousedown`, `touchstart`, `contextmenu`
 * through the stage) took DOM events; here a secondary press goes to `onContextMenu` with where it
 * was, for the shell to open the message's menu.
 */
import { Image, Text, View } from "nsh";
import type { Point } from "nsh";
import type { Message } from "@real-bot/protocol";
import { avatarSrc, botAvatarColor } from "../../m/avatar.ts";
import { formatFullTimestamp, formatMessageTime, type TranscriptGroup } from "../../m/chat/chat-view.ts";
import { isPendingAsk } from "../../m/chat/transcript.ts";
import type { TranscriptStage } from "../../m/chat/transcript-stage.ts";
import { rosterLetter } from "../../m/sidebar/roster-letter.ts";
import { copy, runtime } from "../../runtime";
import { AvatarPicture } from "../AvatarPicture";
import { Icon } from "../Icon";
import { cssColor, shadow } from "../styles";
import { tip } from "../tip";
import { AskCard } from "./AskCard";

export function TranscriptAsk(props: {
  group: TranscriptGroup;
  stage: TranscriptStage;
  /** A secondary press (right click, long press) on the row: the message's menu, at `position`. */
  onContextMenu?: (message: Message, position: Point) => void;
}) {
  const t = () => copy();
  const single = () => props.group.items[0];
  const message = (): Message | null => {
    const item = single();
    return item && item.type === "message" ? item.message : null;
  };
  return (
    <If when={message()}>
      {(msg: () => Message) => {
        const bot = () => props.stage.botsById.get(msg().author);
        const pal = () => botAvatarColor(msg().author);
        const pending = () => isPendingAsk(msg(), props.stage.snapshot.turns, runtime.notificationCapabilities.pending_ask_v1);
        const waiting = () => !msg().ask_answer && pending();
        const hit = () => props.stage.highlightedId === msg().id;
        const selected = () => props.stage.selectedMessageId === msg().id;
        const avatar = (child: () => ReturnType<typeof Text>) => (
          <View
            class="w-[32px] h-[32px] rounded-[10px] items-center justify-center overflow-hidden border"
            style={{ backgroundColor: cssColor(pal().bg), borderColor: cssColor(pal().border), boxShadow: shadow("xs") }}
          >
            {child()}
          </View>
        );
        return (
          <View
            testID={`ask-row-${msg().id}`}
            onContextMenu={(e) => props.onContextMenu?.(msg(), e.pagePosition)}
            class={`flex-row items-start gap-[10px] w-full self-stretch ${hit() || selected() ? "bg-accent-tint border border-accent-border rounded-(--radius-md)" : ""}`}
          >
            <If when={!props.stage.sidesSayWho}>
              <View class="shrink-0 items-center">
                <If
                  when={bot()}
                  else={avatar(() => (
                    <Text class="text-[13px] font-bold" style={{ color: cssColor(pal().text) }}>?</Text>
                  ))}
                >
                  {(b: () => NonNullable<ReturnType<typeof bot>>) => (
                    <View role="button" testID="ask-avatar" tooltip={tip(t().top.botSettings)} onPress={() => props.stage.onOpenProfile(b().id)} class="cursor-pointer select-none hover:scale-[1.06]">
                      {avatar(() => (
                        <If when={avatarSrc(b().avatar)} else={<Text class="text-[13px] font-bold" style={{ color: cssColor(pal().text) }}>{rosterLetter(b().name)}</Text>}>
                          <AvatarPicture avatar={b().avatar} alt={b().name} />
                        </If>
                      ))}
                    </View>
                  )}
                </If>
              </View>
            </If>
            <View class="flex-1 min-w-0">
              <View class="flex-row items-center gap-[6px] mb-[4px] px-[2px]">
                <If when={!props.stage.sidesSayWho}>
                  <If when={bot()} else={<Text class="text-[13px] font-bold text-ink">{props.stage.who(msg())}</Text>}>
                    <View role="button" testID="ask-sender" tooltip={tip(t().top.botSettings)} onPress={() => props.stage.onOpenProfile(msg().author)} class="cursor-pointer select-none group min-w-0">
                      <Text class="text-[13px] font-bold text-ink group-hover:text-brand line-clamp-1">{props.stage.who(msg())}</Text>
                    </View>
                  </If>
                </If>
                <View class="w-[16px] h-[16px] rounded-full bg-accent-tint border border-accent-border items-center justify-center">
                  <Text class="text-[10px] font-bold text-brand">?</Text>
                </View>
                <If when={!props.stage.focus}>
                  <View tooltip={tip(formatFullTimestamp(msg().created_at))}>
                    <Text class="ml-[2px] text-[11px] font-mono text-ink-muted">{formatMessageTime(msg().created_at)}</Text>
                  </View>
                </If>
              </View>
              <View
                testID="ask-bubble" selectable
                class={`self-start w-full max-w-[440px] px-[16px] py-[14px] bg-pane border rounded-(--radius-lg) ${waiting() ? "border-purple-line" : "border-line"}`}
                style={{ boxShadow: shadow(waiting() ? "sm" : "xs") }}
              >
                <View
                  class={`flex-row items-center gap-[6px] ${
                    waiting() ? "self-start mb-[8px] pl-[7px] pr-[9px] py-[2px] rounded-full bg-purple-bg border border-purple-line" : ""
                  }`}
                >
                  <If when={waiting()}>
                    <Icon name="help-circle" size={12} class="tint-purple-text" />
                  </If>
                  <Text testID="ask-who" class={`text-[12px] font-semibold ${waiting() ? "text-purple-text" : "text-ink-muted"}`}>
                    {waiting() ? t().stream.waitingAnswer : `${t().stream.ask} · ${props.stage.who(msg())}`}
                  </Text>
                </View>
                <Text testID="ask-body" class="text-[14px] leading-[1.55] text-ink">{msg().body}</Text>
                <AskCard
                  message={msg()}
                  answerable={pending() && !props.stage.lockedComposer}
                  draft={runtime.getAskDraft(msg().id)}
                  sending={props.stage.view?.sending ?? false}
                  onDraft={(body) => runtime.setAskDraft(msg().id, body)}
                  onSelect={(picks) => runtime.setAskSelection(msg().id, picks)}
                  onSubmit={() => void props.stage.replyAsk(msg().id)}
                />
              </View>
            </View>
          </View>
        );
      }}
    </If>
  );
}
