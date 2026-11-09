/**
 * The Bots still deciding whether to join in on a line, under it (`ReplyingIndicator.svelte`). A Bot
 * at work has a message of its own instead (the working bubble), with its step and its time at the
 * end: this row only says who is thinking about it. "Thinking" is the mark's two teammates taking
 * turns: two overlapping circles, one swelling as the other shrinks.
 */
import { createMotion, effect, Text, View } from "nsh";
import { reduceMotion } from "../interface/motion";
import type { Bot } from "@real-bot/protocol";
import type { ReplyingEntry } from "../../m/chat/transcript";
import { shadow } from "../styles";
import { tip } from "../tip";
import { BotFace } from "./BotFace";
import { enterMotion } from "./labels";

export function ReplyingIndicator(props: {
  entries: readonly ReplyingEntry[];
  botsById: Map<string, Bot>;
  isUser?: boolean;
  thinkingText: string;
  deletedText?: string;
  onOpenProfile?: (botId: string) => void;
}) {
  const enter = enterMotion();
  const a = createMotion();
  const b = createMotion();
  effect(() => {
    if (props.entries.length > 0 && !reduceMotion()) {
      void a.play({ duration: 1200, iterations: "infinite", direction: "alternate", keyframes: { scale: [1, 0.62] } });
      void b.play({ duration: 1200, delay: -600, iterations: "infinite", direction: "alternate", keyframes: { scale: [1, 0.62] } });
    } else {
      a.reset();
      b.reset();
    }
  });
  const deleted = () => props.deletedText ?? "?";

  const dots = () => (
    <View testID="replying-dots" accessible={false} class="shrink-0 mx-[4px]" style={{ width: 15, height: 9 }}>
      <View class="absolute rounded-full bg-brand" style={{ left: 0, top: 0, width: 9, height: 9, transform: [...a.transform] }} />
      <View
        class="absolute rounded-full bg-art-ring border-pane"
        style={{ left: 6, top: 0, width: 9, height: 9, borderWidth: 1.5, transform: [...b.transform] }}
      />
    </View>
  );

  const identity = (entry: ReplyingEntry, single: boolean) => {
    const bot = () => props.botsById.get(entry.bot_id);
    const face = (
      <BotFace id={entry.bot_id} name={bot()?.name ?? deleted()} avatar={bot()?.avatar} size={single ? 20 : 18} motion="running" letterSize={10} />
    );
    const name = <Text class={`max-w-[140px] text-[12px] ${single ? "font-semibold" : "font-medium"} text-ink line-clamp-1`}>{bot()?.name ?? deleted()}</Text>;
    const frame = single ? "" : "pl-[3px] pr-[8px] py-[2.5px] bg-bg border border-line rounded-full";
    return (
      <If
        when={props.onOpenProfile && bot()}
        else={
          <View testID={`replying-chip-${entry.bot_id}`} tooltip={tip(bot()?.name ?? deleted())} class={`flex-row items-center ${single ? "gap-[6px]" : "gap-[5px]"} ${frame}`}>
            {face}
            {name}
          </View>
        }
      >
        <View
          role="button"
          testID={`replying-chip-${entry.bot_id}`}
          accessibilityLabel={bot()?.name}
          tooltip={tip(bot()?.name ?? "")}
          onPress={() => props.onOpenProfile?.(entry.bot_id)}
          class={`cursor-pointer select-none flex-row items-center ${single ? "gap-[6px]" : "gap-[5px]"} ${frame} ${single ? "" : "hover:bg-line-hover hover:border-muted-light active:scale-[0.98]"}`}
        >
          {face}
          {name}
        </View>
      </If>
    );
  };

  return (
    <If when={props.entries.length > 0}>
      <If
        when={props.entries.length === 1 ? props.entries[0] : null}
        else={
          <View
            testID="replying-card"
            class="max-w-full gap-[7px] pl-[10px] pr-[10px] pt-[7px] pb-[9px] bg-pane border border-line rounded-(--radius-lg)"
            style={{ boxShadow: shadow("xs"), opacity: enter.opacity, transform: [...enter.transform] }}
          >
            <View class="flex-row items-center px-[4px] gap-[6px]">
              {dots()}
              <Text class="text-[12px] font-medium text-ink-muted">{props.thinkingText}</Text>
              <View class="px-[6px] py-[1px] rounded-full bg-chip border border-line">
                <Text class="font-mono text-[10px] font-semibold text-ink-muted">{props.entries.length}</Text>
              </View>
            </View>
            <View class="flex-row flex-wrap items-center gap-[5px]">
              <Each of={props.entries} key={(e) => e.judgement_id}>{(entry) => identity(entry(), false)}</Each>
            </View>
          </View>
        }
      >
        {(entry) => (
          <View
            testID="replying-card"
            class="flex-row items-center gap-[6px] max-w-full pl-[4px] pr-[10px] py-[3px] bg-pane border border-line rounded-full"
            style={{ boxShadow: shadow("xs"), opacity: enter.opacity, transform: [...enter.transform] }}
          >
            {identity(entry(), true)}
            {dots()}
            <Text class="min-w-0 shrink text-[12px] text-ink-muted line-clamp-1">{props.thinkingText}</Text>
          </View>
        )}
      </If>
    </If>
  );
}
