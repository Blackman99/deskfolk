/**
 * The routines' calendar (`RoutineCalendar.svelte`): every Bot's scheduled turns laid on a grid by
 * week, day, month or an agenda. A block is a rule unfolded in the range on screen
 * (`projectRoutines`), not a record of a run, and nothing here writes: a press on a block opens
 * the routine read-only. The Svelte one drew its grid with `svelte5plus-calendar`; here the
 * toolbar, `WeekGrid`, `MonthGrid` and `Agenda` are NSH views, and the date maths is `calendar-dates`.
 */
import { signal, Text, View } from "nsh";
import { copy, runtime } from "../../runtime";
import { projectRoutines } from "../../m/calendar/project-routines.ts";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";
import { narrowWindow } from "../Modal";
import { Agenda } from "./Agenda";
import { MonthGrid } from "./MonthGrid";
import { RosterFilter } from "./RosterFilter";
import { RoutineDetail } from "./RoutineDetail";
import { WeekGrid } from "./WeekGrid";
import { navigate, TOOLBAR, viewRange, viewTitle, visibleDays, VIEWS, type CalEvent, type CalLocale, type CalSource, type CalView } from "./calendar-dates";

export function RoutineCalendar() {
  const t = () => copy();
  const date = signal(new Date());
  const view = signal<CalView>("week");
  const hidden = signal<ReadonlySet<string>>(new Set());
  const showInfo = signal(false);
  const openRoutineId = signal<string | null>(null);
  const openWasDue = signal(false);

  const locale = (): CalLocale => (runtime.snapshot.settings.locale === "en" ? "en" : "zh-CN");
  const words = () => TOOLBAR[locale()];
  const projected = () => {
    const range = viewRange(view(), date());
    return projectRoutines({
      bots: runtime.snapshot.bots,
      routines: runtime.snapshot.routines,
      rangeStart: range.start,
      rangeEnd: range.end,
      hostLocal: !runtime.remote,
      archivedLabel: t().top.archived,
    });
  };
  const sources = (): CalSource[] => projected().sources.map((source) => ({ ...source, visible: !hidden().has(source.id) }));
  const events = (): CalEvent[] => projected().events;
  const shownEvents = () => events().filter((event) => !hidden().has(event.calendarId ?? ""));
  const botsById = () => new Map(runtime.snapshot.bots.map((bot) => [bot.id, bot]));
  const openRoutine = () => runtime.snapshot.routines.find((row) => row.id === openRoutineId()) ?? null;
  const openBot = () => {
    const routine = openRoutine();
    return routine ? (botsById().get(routine.bot_id) ?? null) : null;
  };

  function openEvent(event: CalEvent): void {
    const id = event.meta?.routineId;
    if (typeof id !== "string") return;
    openWasDue.set(event.meta?.lastFired === true);
    openRoutineId.set(id);
  }
  function openDay(day: Date): void {
    date.set(day);
    view.set("day");
  }
  function toggleSource(id: string): void {
    const next = new Set(hidden());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    hidden.set(next);
  }

  const en = () => locale() === "en";
  const notes = () => (
    <>
      <Text testID="note-zone" class="text-[12px] leading-[1.45] text-ink-muted">{t().routines.zone}</Text>
      <Text testID="note-availability" class="text-[12px] leading-[1.45] text-ink-muted">{t().routines.availability}</Text>
      <Text testID="note-projection" class="text-[12px] leading-[1.45] text-ink-muted">{runtime.remote ? t().calendar.lastFiredHostOnly : t().calendar.projectionHint}</Text>
      <Text testID="note-phone" class="text-[12px] leading-[1.45] text-ink-muted">{t().calendar.phoneReadOnly}</Text>
    </>
  );

  return (
    <View testID="routine-calendar" role="region" accessibilityLabel={t().calendar.title} class="flex-1 min-w-0 min-h-0 bg-pane">
      <View class={`flex-row items-center justify-between gap-3 border-b border-line bg-pane h-[52px] px-4`}>
        <View class="flex-row items-center gap-3 min-w-0 shrink">
          <View
            role="button"
            testID="calendar-back"
            accessibilityLabel={t().common.back}
            onPress={() => runtime.closeRoutines()}
            class="flex-row items-center gap-[6px] px-[10px] py-[6px] border border-line rounded-(--radius-sm) bg-btn-secondary-bg hover:bg-line-subtle active:scale-[0.98]"
          >
            <Icon name="chevron-left" size={16} class="tint-ink" />
            <If when={!narrowWindow()}>
              <Text class="text-[13px] font-medium text-ink">{t().common.back}</Text>
            </If>
          </View>
          <If when={!narrowWindow()}>
            <View class="w-[1px] h-[18px] bg-line" accessible={false} />
          </If>
          <View class="flex-row items-center gap-[10px] min-w-0 shrink">
            <Text role="header" class="text-[15px] font-semibold text-ink line-clamp-1">{t().calendar.title}</Text>
            <If when={sources().length > 0 && !narrowWindow()}>
              <View class="px-2 py-[2px] rounded-full bg-line-subtle border border-line">
                <Text testID="calendar-stat" class="text-[11px] font-medium text-ink-muted">
                  {`${sources().length} Bot · ${events().length} ${en() ? "routines" : "日程"}`}
                </Text>
              </View>
            </If>
          </View>
        </View>
        <View
          role="button"
          testID="calendar-info-toggle"
          accessibilityLabel={en() ? "Schedule info" : "日程规则说明"}
          accessibilityState={{ expanded: showInfo(), selected: showInfo() }}
          onPress={() => showInfo.set(!showInfo())}
          class={`flex-row items-center gap-[5px] px-[10px] py-[5px] border rounded-(--radius-sm) hover:bg-line-subtle ${showInfo() ? "bg-accent-tint border-accent-border" : "bg-btn-secondary-bg border-line"}`}
        >
          <Icon name="info" size={16} class={showInfo() ? "tint-brand" : "tint-ink-muted"} />
          <Text class={`text-[12px] font-medium ${showInfo() ? "text-brand" : "text-ink-muted"}`}>{en() ? "Rules" : "规则"}</Text>
        </View>
      </View>

      <If when={showInfo()}>
        <View testID="calendar-info" class="mx-4 mt-2 mb-1 px-[14px] py-[10px] rounded-(--radius-md) bg-line-subtle border border-line gap-2">
          <View class="flex-row items-center justify-between">
            <View class="flex-row items-center gap-[6px]">
              <Icon name="info" size={16} class="tint-brand" />
              <Text class="text-[12px] font-semibold text-brand">{en() ? "Schedule Rules & Availability" : "日程展开与运行规则"}</Text>
            </View>
            <IconButton icon="x" size="xs" label={t().common.close} testID="calendar-info-close" onPress={() => showInfo.set(false)} />
          </View>
          <View class="gap-[6px]">{notes()}</View>
        </View>
      </If>

      <If
        when={sources().length > 0}
        else={
          <View class="px-4 py-3">
            <Text testID="calendar-empty" class="text-[13px] text-ink-muted">{t().calendar.empty}</Text>
          </View>
        }
      >
        <View class="flex-row items-center px-4 py-2">
          <RosterFilter sources={sources()} bots={botsById()} hidden={hidden()} onToggle={toggleSource} onShowAll={() => hidden.set(new Set())} />
        </View>
      </If>

      <View class={`flex-row items-center gap-2 px-4 pb-2 ${narrowWindow() ? "flex-wrap" : ""}`}>
        <View
          role="button"
          testID="calendar-today"
          accessibilityLabel={words().today}
          onPress={() => date.set(new Date())}
          class="px-3 py-[5px] border border-line rounded-(--radius-sm) bg-btn-secondary-bg hover:bg-line-subtle"
        >
          <Text class="text-[13px] font-medium text-ink">{words().today}</Text>
        </View>
        <IconButton icon="chevron-left" size="sm" label={words().previous} testID="calendar-previous" onPress={() => date.set(navigate(view(), date(), -1))} />
        <IconButton icon="chevron-right" size="sm" label={words().next} testID="calendar-next" onPress={() => date.set(navigate(view(), date(), 1))} />
        <Text testID="calendar-title" role="header" class="text-[15px] font-semibold text-ink line-clamp-1 shrink">{viewTitle(view(), date(), locale())}</Text>
        <View class="flex-1" />
        <View role="tablist" accessibilityLabel="View" class="flex-row border border-line rounded-(--radius-sm) overflow-hidden">
          <Each of={VIEWS.slice()} key={(v) => v}>
            {(v) => (
              <View
                role="tab"
                testID={`calendar-view-${v()}`}
                accessibilityLabel={words()[v()]}
                accessibilityState={{ selected: view() === v() }}
                onPress={() => view.set(v())}
                class={`px-3 py-[5px] ${view() === v() ? "bg-accent-tint" : "bg-btn-secondary-bg hover:bg-line-subtle"}`}
              >
                <Text class={`text-[13px] ${view() === v() ? "text-brand font-semibold" : "text-ink"}`}>{words()[v()]}</Text>
              </View>
            )}
          </Each>
        </View>
      </View>

      <View class="flex-1 min-h-0 border-t border-line">
        <If when={view() === "week" || view() === "day"}>
          <WeekGrid
            days={visibleDays(view(), date())}
            events={shownEvents()}
            bots={botsById()}
            locale={locale()}
            nowIndicator={!runtime.remote}
            onOpen={openEvent}
          />
        </If>
        <If when={view() === "month"}>
          <MonthGrid date={date()} events={shownEvents()} bots={botsById()} locale={locale()} onOpen={openEvent} onOpenDay={openDay} />
        </If>
        <If when={view() === "agenda"}>
          <Agenda events={shownEvents()} bots={botsById()} locale={locale()} onOpen={openEvent} onOpenDay={openDay} />
        </If>
      </View>

      <If when={openRoutineId()}>
        <RoutineDetail routine={openRoutine()} bot={openBot()} wasDue={openWasDue()} locale={locale()} onClose={() => openRoutineId.set(null)} />
      </If>
    </View>
  );
}
