/**
 * The month view: the weeks of the month, a cell per day with its routines in time order. A cell
 * lists at most `DAY_MAX_EVENTS` rows; past that it shows the first three and "+N more", which
 * opens that day's view (the package opened a popover).
 */
import type { Bot } from "@real-bot/protocol";
import { Text, View } from "nsh";
import { cssColor } from "../styles";
import { clock, DAY_MAX_EVENTS, dayEvents, isSameDay, monthGrid, TOOLBAR, weekdayShort, type CalEvent, type CalLocale } from "./calendar-dates";
import { botOfEvent, isPaused, SmallFace } from "./EventFace";

export function MonthGrid(props: {
  date: Date;
  events: readonly CalEvent[];
  bots: ReadonlyMap<string, Bot>;
  locale: CalLocale;
  onOpen: (event: CalEvent) => void;
  onOpenDay: (day: Date) => void;
}) {
  const weeks = () => monthGrid(props.date);
  return (
    <View testID="calendar-month" class="flex-1 min-h-0">
      <View class="flex-row border-b border-line bg-pane">
        <Each of={(weeks()[0] ?? []).slice()} key={(day) => day.getTime()}>
          {(day) => (
            <View class="flex-1 min-w-0 items-center py-2">
              <Text class="text-[11px] text-ink-muted">{weekdayShort(day(), props.locale)}</Text>
            </View>
          )}
        </Each>
      </View>
      <View class="flex-1 min-h-0">
        <Each of={weeks()} key={(week) => week[0]!.getTime()}>
          {(week) => (
            <View class="flex-1 min-h-0 flex-row border-b border-line-subtle">
              <Each of={week().slice()} key={(day) => day.getTime()}>
                {(day) => {
                  const events = () => dayEvents(props.events, day());
                  const overflow = () => events().length > DAY_MAX_EVENTS;
                  const shown = () => (overflow() ? events().slice(0, DAY_MAX_EVENTS - 1) : events());
                  const today = () => isSameDay(day(), new Date());
                  const inMonth = () => day().getMonth() === props.date.getMonth();
                  return (
                    <View class={`flex-1 min-w-0 min-h-0 border-l border-line-subtle px-1 py-1 gap-[2px] overflow-hidden ${inMonth() ? "" : "bg-line-subtle"}`}>
                      <View class="self-end">
                        <View class={`w-[22px] h-[22px] rounded-full items-center justify-center ${today() ? "bg-brand" : ""}`}>
                          <Text class={`text-[12px] ${today() ? "text-on-accent font-semibold" : inMonth() ? "text-ink" : "text-ink-muted"}`}>{String(day().getDate())}</Text>
                        </View>
                      </View>
                      <Each of={shown()} key={(event) => event.id}>
                        {(event) => (
                          <View
                            role="button"
                            testID={`calendar-event-${event().id}`}
                            accessibilityLabel={`${botOfEvent(event(), props.bots)?.name ?? ""} ${event().title}`}
                            onPress={() => props.onOpen(event())}
                            class={`flex-row items-center gap-1 px-1 py-[2px] rounded-(--radius-xs) hover:bg-line-subtle ${isPaused(event()) ? "opacity-[0.6]" : ""}`}
                          >
                            <View class="w-[6px] h-[6px] rounded-full" style={{ backgroundColor: cssColor(event().color ?? "") }} accessible={false} />
                            <If when={botOfEvent(event(), props.bots)}>{(bot) => <SmallFace bot={bot()} size={14} />}</If>
                            <Text class="text-[11px] text-ink-muted">{clock(event().start)}</Text>
                            <Text class="flex-1 min-w-0 text-[11px] text-ink line-clamp-1">{event().title}</Text>
                          </View>
                        )}
                      </Each>
                      <If when={overflow()}>
                        <View
                          role="button"
                          testID={`calendar-more-${day().getTime()}`}
                          onPress={() => props.onOpenDay(day())}
                          class="px-1 rounded-(--radius-xs) hover:bg-line-subtle"
                        >
                          <Text class="text-[11px] font-medium text-ink-muted">{TOOLBAR[props.locale].more(events().length - shown().length)}</Text>
                        </View>
                      </If>
                    </View>
                  );
                }}
              </Each>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}
