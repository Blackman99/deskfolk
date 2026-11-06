/**
 * The week and day views: a day's column per day over a 24-hour ruler, 96 points to the hour. The
 * routines are blocks laid where their time is, side by side when they overlap, and a line marks
 * now (on the execution Mac only). A press on a block opens it.
 */
import type { Bot } from "@real-bot/protocol";
import { effect, Scroll, signal, Text, View, type ScrollRef } from "nsh";
import { cssColor } from "../styles";
import { EVENT_MIN_HEIGHT, HOUR_HEIGHT, isSameDay, layoutDay, minutesOfDay, weekdayShort, type CalEvent, type CalLocale } from "./calendar-dates";
import { botOfEvent, EventFace, isPaused } from "./EventFace";

const RULER = 52;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function WeekGrid(props: {
  days: readonly Date[];
  events: readonly CalEvent[];
  bots: ReadonlyMap<string, Bot>;
  locale: CalLocale;
  nowIndicator: boolean;
  onOpen: (event: CalEvent) => void;
}) {
  const now = signal(new Date());
  effect(() => {
    if (!props.nowIndicator) return;
    const timer = setInterval(() => now.set(new Date()), 30_000);
    return () => clearInterval(timer);
  });

  // Opens on the working hours, an hour above now.
  let scroller: ScrollRef | null = null;
  let placed = false;
  const reveal = () => {
    if (placed || !scroller) return;
    placed = true;
    scroller.scrollTo({ y: Math.max(0, new Date().getHours() - 1) * HOUR_HEIGHT, animated: false });
  };

  return (
    <View testID="calendar-week" class="flex-1 min-h-0">
      <View class="flex-row border-b border-line bg-pane">
        <View style={{ width: RULER }} />
        <Each of={props.days.slice()} key={(day) => day.getTime()}>
          {(day) => {
            const today = () => isSameDay(day(), new Date());
            return (
              <View class="flex-1 min-w-0 items-center py-2 border-l border-line gap-[2px]">
                <Text class={`text-[11px] ${today() ? "text-brand font-semibold" : "text-ink-muted"}`}>{weekdayShort(day(), props.locale)}</Text>
                <View class={`w-[28px] h-[28px] rounded-full items-center justify-center ${today() ? "bg-brand" : ""}`}>
                  <Text class={`text-[15px] font-medium ${today() ? "text-on-accent" : "text-ink"}`}>{String(day().getDate())}</Text>
                </View>
              </View>
            );
          }}
        </Each>
      </View>
      <Scroll
        class="flex-1 min-h-0"
        ref={(node: ScrollRef | null) => (scroller = node)}
        onLayout={reveal}
      >
        <View class="flex-row" style={{ height: 24 * HOUR_HEIGHT }}>
          <View style={{ width: RULER }}>
            <Each of={HOURS} key={(h) => h}>
              {(h) => (
                <Text class="absolute right-2 text-[11px] text-ink-muted" style={{ top: Math.max(0, h() * HOUR_HEIGHT - 7) }}>
                  {h() === 0 ? "" : `${String(h()).padStart(2, "0")}:00`}
                </Text>
              )}
            </Each>
          </View>
          <Each of={props.days.slice()} key={(day) => day.getTime()}>
            {(day) => {
              const timed = () => props.events.filter((event) => isSameDay(event.start, day()));
              const placements = () => layoutDay(timed(), day(), (EVENT_MIN_HEIGHT / HOUR_HEIGHT) * 60);
              const nowTop = () => (props.nowIndicator && isSameDay(now(), day()) ? (minutesOfDay(now()) / 60) * HOUR_HEIGHT : null);
              return (
                <View class="flex-1 min-w-0 border-l border-line">
                  <Each of={HOURS} key={(h) => h}>
                    {(h) => <View class="absolute left-0 right-0 border-t border-line-subtle" style={{ top: h() * HOUR_HEIGHT }} accessible={false} />}
                  </Each>
                  <Each of={placements()} key={(p) => p.event.id}>
                    {(p) => (
                      <View
                        role="button"
                        testID={`calendar-event-${p().event.id}`}
                        accessibilityLabel={`${botOfEvent(p().event, props.bots)?.name ?? ""} ${p().event.title}`}
                        onPress={() => props.onOpen(p().event)}
                        class={`absolute rounded-(--radius-xs) border border-line bg-pane px-[6px] py-1 hover:bg-line-subtle overflow-hidden ${isPaused(p().event) ? "border-dashed" : ""}`}
                        style={{
                          top: (p().startMin / 60) * HOUR_HEIGHT,
                          height: Math.max(((p().endMin - p().startMin) / 60) * HOUR_HEIGHT, EVENT_MIN_HEIGHT),
                          left: `${(p().col / p().cols) * 100}%`,
                          width: `${100 / p().cols}%`,
                          borderLeftWidth: 3,
                          borderLeftColor: cssColor(p().event.color ?? ""),
                        }}
                      >
                        <EventFace event={p().event} bot={botOfEvent(p().event, props.bots)} locale={props.locale} />
                      </View>
                    )}
                  </Each>
                  <If when={nowTop()}>
                    {(top) => <View testID="calendar-now" class="absolute left-0 right-0 h-[2px] bg-danger" style={{ top: top() }} accessible={false} />}
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
      </Scroll>
    </View>
  );
}
