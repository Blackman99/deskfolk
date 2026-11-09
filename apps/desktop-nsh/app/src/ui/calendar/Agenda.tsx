/**
 * The agenda: the shown routines of the next 30 days, a row per day with its routines in time
 * order (`.routine-agenda`). A press on the date opens that day; a press on a routine opens it.
 */
import type { Bot } from "@real-bot/protocol";
import { Scroll, Text, View } from "nsh";
import { copy } from "../../runtime";
import { cssColor } from "../styles";
import { narrowWindow } from "../Modal";
import { agendaDayLabel, agendaGroups, clock, isSameDay, type CalEvent, type CalLocale } from "./calendar-dates";
import { botOfEvent, isPaused, PausedBadge, SmallFace } from "./EventFace";

export function Agenda(props: {
  events: readonly CalEvent[];
  bots: ReadonlyMap<string, Bot>;
  locale: CalLocale;
  onOpen: (event: CalEvent) => void;
  onOpenDay: (day: Date) => void;
}) {
  const groups = () => agendaGroups(props.events);
  return (
    <Scroll testID="calendar-agenda" class="flex-1 min-h-0">
      <View class="px-4 py-2">
        <If when={groups().length > 0} else={<Text testID="agenda-empty" class="py-8 text-center text-[13px] text-ink-muted">{copy().calendar.agendaEmpty}</Text>}>
          <Each of={groups()} key={(group) => group.key}>
            {(group) => (
              <View class="flex-row gap-3 py-3 border-b border-line-subtle">
                <View
                  role="button"
                  testID={`agenda-day-${group().key}`}
                  accessibilityLabel={agendaDayLabel(group().day, props.locale)}
                  onPress={() => props.onOpenDay(group().day)}
                  class={`cursor-pointer select-none items-start ${narrowWindow() ? "w-[72px] min-h-[44px]" : "w-[120px]"}`}
                >
                  <Text class={`text-[24px] font-medium ${isSameDay(group().day, new Date()) ? "text-brand" : "text-ink"}`}>{String(group().day.getDate())}</Text>
                  <Text class="text-[12px] text-ink-muted">{agendaDayLabel(group().day, props.locale)}</Text>
                </View>
                <View class="flex-1 min-w-0 gap-1">
                  <Each of={group().items} key={(event) => event.id}>
                    {(event) => (
                      <View
                        role="button"
                        testID={`agenda-event-${event().id}`}
                        accessibilityLabel={`${botOfEvent(event(), props.bots)?.name ?? ""} ${event().title}`}
                        onPress={() => props.onOpen(event())}
                        class={`cursor-pointer select-none flex-row items-center gap-[10px] px-[10px] py-2 rounded-(--radius-sm) hover:bg-line-subtle ${isPaused(event()) ? "opacity-[0.6]" : ""} ${narrowWindow() ? "min-h-[44px]" : ""}`}
                      >
                        <View class="w-[8px] h-[8px] rounded-full" style={{ backgroundColor: cssColor(event().color ?? "") }} accessible={false} />
                        <Text class="text-[12px] text-ink-muted">{`${clock(event().start)} – ${clock(event().end)}`}</Text>
                        <If when={botOfEvent(event(), props.bots)}>
                          {(bot) => (
                            <View class="flex-row items-center gap-[5px]">
                              <SmallFace bot={bot()} />
                              <Text class="text-[12px] font-semibold text-ink-secondary">{bot().name}</Text>
                            </View>
                          )}
                        </If>
                        <Text class="flex-1 min-w-0 text-[13px] text-ink line-clamp-1">{event().title}</Text>
                        <If when={isPaused(event())}>
                          <PausedBadge locale={props.locale} />
                        </If>
                      </View>
                    )}
                  </Each>
                </View>
              </View>
            )}
          </Each>
        </If>
      </View>
    </Scroll>
  );
}
