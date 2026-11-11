/** What a routine's block says on the grid: the Bot's face and name, a "paused" badge, the title. */
import type { Bot } from "@real-bot/protocol";
import { Text, View } from "nsh";
import { cssColor } from "../styles";
import { BotFace } from "../chat/BotFace";
import type { CalEvent, CalLocale } from "./calendar-dates";

export const isPaused = (event: CalEvent): boolean => event.meta?.paused === true;

/** The Bot a block belongs to (`meta.botId`, else its calendar). */
export function botOfEvent(event: CalEvent, bots: ReadonlyMap<string, Bot>): Bot | undefined {
  const id = typeof event.meta?.botId === "string" ? event.meta.botId : event.calendarId;
  return id ? bots.get(id) : undefined;
}

export function PausedBadge(props: { locale: CalLocale }) {
  return (
    <View class="shrink-0 px-[5px] rounded-full bg-chip" accessible={false}>
      <Text class="text-[10px] font-semibold text-ink-muted">{props.locale === "en" ? "Paused" : "暂停"}</Text>
    </View>
  );
}

/** A small round face of a Bot (the roster filter, the agenda and the blocks). */
export function SmallFace(props: { bot: Bot; size?: number }) {
  return <BotFace id={props.bot.id} name={props.bot.name} avatar={props.bot.avatar} size={props.size ?? 16} border={0} letterSize={(props.size ?? 16) * 0.6} />;
}

/** The inside of a week or day block. */
export function EventFace(props: { event: CalEvent; bot: Bot | undefined; locale: CalLocale }) {
  return (
    <View class={`gap-[2px] flex-1 min-w-0 ${isPaused(props.event) ? "opacity-[0.6]" : ""}`}>
      <View class="flex-row items-center gap-[5px]">
        <If when={props.bot}>{(bot) => <SmallFace bot={bot()} />}</If>
        <Text class="flex-1 min-w-0 text-[11px] font-semibold line-clamp-1" style={{ color: cssColor(props.event.color ?? "") }}>
          {props.bot?.name ?? ""}
        </Text>
        <If when={isPaused(props.event)}>
          <PausedBadge locale={props.locale} />
        </If>
      </View>
      <Text class="text-[12px] font-medium text-ink line-clamp-2">{props.event.title}</Text>
    </View>
  );
}
