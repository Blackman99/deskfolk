/**
 * The roster filter: which Bots' routines the calendar shows. A trigger with how many are shown,
 * a reset once some are hidden, and under the trigger (a popover on a desktop, a sheet from the
 * bottom on a phone) a search over names and duties and a ticked row per Bot. Arrows move the
 * highlight, Return ticks it, Escape and a press outside close it. It filters only what is drawn:
 * nothing is written.
 */
import type { Bot } from "@real-bot/protocol";
import { effect, keymap, Scroll, signal, Text, View, type ScrollRef } from "nsh";
import { Input, Popover } from "nsh/base";
import { copy } from "../../runtime";
import { BottomSheet } from "../BottomSheet";
import { Icon } from "../Icon";
import { cssColor, shadow } from "../styles";
import type { CalSource } from "./calendar-dates";
import { SmallFace } from "./EventFace";
import { widthAtMost } from "../../platform/viewport";

/** `PHONE_SHEET_QUERY` (`bottom-sheet.ts`): what drops down opens as a sheet at this width or less. */
const phone = () => widthAtMost(720);

export function RosterFilter(props: {
  sources: readonly CalSource[];
  bots: ReadonlyMap<string, Bot>;
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onShowAll: () => void;
}) {
  const t = () => copy().calendar;
  const open = signal(false);
  const query = signal("");
  const highlight = signal(0);
  const composing = signal(false);

  const visibleCount = () => props.sources.filter((source) => source.visible).length;
  const summary = () => (visibleCount() === props.sources.length ? t().filterAll : `${visibleCount()}/${props.sources.length}`);
  const listed = () => {
    const needle = query().trim().toLowerCase();
    if (!needle) return props.sources;
    return props.sources.filter((source) => source.name.toLowerCase().includes(needle) || (props.bots.get(source.id)?.duties ?? "").toLowerCase().includes(needle));
  };
  const activeIndex = () => (listed().length === 0 ? -1 : Math.min(Math.max(highlight(), 0), listed().length - 1));

  function close(): void {
    open.set(false);
    query.set("");
    highlight.set(0);
  }
  function toggleOpen(): void {
    if (open()) close();
    else {
      open.set(true);
      query.set("");
      highlight.set(0);
    }
  }
  effect(() => {
    if (props.sources.length === 0 && open()) close();
  });

  function move(direction: 1 | -1): void {
    if (composing() || listed().length === 0) return;
    const start = activeIndex() < 0 ? (direction === 1 ? -1 : 0) : activeIndex();
    highlight.set((start + direction + listed().length) % listed().length);
  }
  function choose(): void {
    if (composing()) return;
    const source = listed()[activeIndex()];
    if (source) props.onToggle(source.id);
  }
  effect(() => {
    if (!open()) return;
    const off = [
      keymap.bind("down", () => move(1), { when: "always", repeat: true }),
      keymap.bind("up", () => move(-1), { when: "always", repeat: true }),
      keymap.bind("escape", () => !composing() && close(), { when: "always" }),
    ];
    return () => off.forEach((fn) => fn());
  });

  // Keeps the highlighted row in view.
  const rows = new Map<number, { y: number; height: number }>();
  const viewport = { y: 0, height: 0 };
  let scroller: ScrollRef | null = null;
  effect(() => {
    const at = rows.get(highlight());
    if (!at || !scroller || viewport.height === 0) return;
    if (at.y < viewport.y) scroller.scrollTo({ y: at.y });
    else if (at.y + at.height > viewport.y + viewport.height) scroller.scrollTo({ y: at.y + at.height - viewport.height });
  });

  const body = () => (
    <View testID="roster-filter-body">
      <Input
        testID="roster-filter-search"
        accessibilityLabel={t().filterSearch}
        placeholder={t().filterSearch}
        value={query()}
        autoFocus={!phone()}
        autoCapitalize="none"
        autoCorrect={false}
        submitBehavior="submit"
        onChange={(e) => {
          query.set(e.value);
          highlight.set(0);
        }}
        onSubmit={choose}
        onCompositionChange={(e) => composing.set(e.composing)}
        class="w-full px-[10px] py-2 text-[13px] text-ink bg-input-bg border-b border-line"
      />
      <Scroll
        class="max-h-[280px]"
        ref={(node: ScrollRef | null) => (scroller = node)}
        onLayout={(e) => (viewport.height = e.bounds.size.height)}
        onScroll={(e) => (viewport.y = e.offset.y)}
      >
        <View role="list" accessibilityLabel={t().filter} class="p-1">
          {() =>
            listed().length === 0 ? (
              <Text testID="roster-filter-empty" class="px-[10px] py-[14px] text-[12px] text-ink-muted">{t().filterNoMatch}</Text>
            ) : (
              listed().map((source, idx) => {
                const bot = props.bots.get(source.id);
                return (
                  <View
                    role="checkbox"
                    testID={`roster-filter-option-${source.id}`}
                    accessibilityLabel={`${source.visible ? t().filterHide : t().filterShow} ${source.name}`}
                    accessibilityState={{ checked: source.visible, selected: source.visible }}
                    onPress={() => props.onToggle(source.id)}
                    onMouseEnter={() => highlight.set(idx)}
                    onLayout={(e) => rows.set(idx, { y: e.bounds.origin.y, height: e.bounds.size.height })}
                    class={`cursor-pointer select-none flex-row items-center gap-2 px-2 rounded-(--radius-sm) ${phone() ? "min-h-[48px]" : "min-h-[34px]"} ${idx === activeIndex() ? "bg-line-subtle" : ""}`}
                  >
                    <View class={`w-[16px] h-[16px] rounded-[4px] border items-center justify-center shrink-0 ${source.visible ? "bg-brand border-brand" : "border-line-hover"}`} accessible={false}>
                      <If when={source.visible}>
                        <Icon name="check" size={12} class="tint-on-accent" />
                      </If>
                    </View>
                    <If when={bot}>{(b) => <SmallFace bot={b()} size={20} />}</If>
                    <Text class="shrink-0 text-[13px] font-medium text-ink">{source.name}</Text>
                    <Text class="flex-1 min-w-0 text-[11px] text-ink-muted line-clamp-1">{bot?.duties?.trim() ?? ""}</Text>
                    <View class="w-[10px] h-[10px] rounded-full shrink-0" style={{ backgroundColor: cssColor(source.color ?? "") }} accessible={false} />
                  </View>
                );
              })
            )
          }
        </View>
      </Scroll>
    </View>
  );

  const trigger = (
    <View
      role="button"
      testID="roster-filter-trigger"
      accessibilityLabel={t().filter}
      accessibilityState={{ expanded: open() }}
      onPress={phone() ? toggleOpen : undefined}
      class={`cursor-pointer select-none flex-row items-center gap-[6px] px-[10px] py-[5px] border rounded-(--radius-sm) bg-btn-secondary-bg hover:bg-line-subtle ${props.hidden.size > 0 ? "border-accent-border" : "border-line"}`}
    >
      <Icon name="funnel" size={16} class="tint-ink-muted" />
      <Text class="text-[12px] font-medium text-ink">{t().filter}</Text>
      <Text testID="roster-filter-count" class="text-[12px] text-ink-muted">{summary()}</Text>
      <Icon name="chevron-down" size={12} class="tint-ink-muted" />
    </View>
  );

  return (
    <View class="flex-row items-center gap-2">
      <If
        when={phone()}
        else={
          <Popover
            open={open()}
            onOpenChange={(e) => (e.open ? toggleOpen() : close())}
            placement="bottom"
            align="start"
            offset={6}
            popupClass="w-[280px] bg-pane border border-line rounded-(--radius-md) overflow-hidden"
            popupStyle={{ boxShadow: shadow("lg") }}
            trigger={trigger}
          >
            {body}
          </Popover>
        }
      >
        {trigger}
      </If>
      <If when={props.hidden.size > 0}>
        <View
          role="button"
          testID="roster-filter-reset"
          accessibilityLabel={t().filterReset}
          onPress={props.onShowAll}
          class="cursor-pointer select-none px-2 py-1 rounded-(--radius-sm) hover:bg-line-subtle"
        >
          <Text class="text-[12px] text-brand">{t().filterReset}</Text>
        </View>
      </If>
      <If when={phone() && open()}>
        <BottomSheet title={t().filter} closeLabel={copy().common.close} onClose={close} testID="roster-filter-sheet">
          {body()}
        </BottomSheet>
      </If>
    </View>
  );
}
