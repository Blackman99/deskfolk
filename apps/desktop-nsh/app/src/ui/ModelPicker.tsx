/**
 * A model picker for more models than one list can carry: endpoints, Claude Code and your other
 * local agents (ADR 0079), OpenCode's hundreds among them (`ModelPicker.svelte`). On a wide window a
 * popover: a search over everything, the rows that are not models across the top, then where models
 * come from on the left and the models of the one under the pointer on the right, in groups. On a
 * phone a sheet from the bottom, one level at a time (sources, a provider's group when there are
 * many, models) with Back going up a level. A source that lists no models, or not the one you want,
 * takes a name typed into the search when it says how (`PickerSource.custom`).
 *
 * The data and the searching are `src/m/model-picker.ts`'s. `bind:value` is `value` + `onChange`
 * (called on a change only); the copy is `copy()`'s, not a `t` prop.
 */
import { Scroll, Text, View, effect, keymap, signal, type ScrollRef } from "nsh";
import { Popover, Sheet } from "nsh/base";
import { copy } from "../runtime";
import { holdBack } from "../m/chat/message-text-pages";
import { sourceCount, type PickerData, type PickerRow } from "../m/model-picker";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { ModelSourceMark } from "./ModelSourceMark";
import { ModelRow, SearchField } from "./model-picker/Rows";
import { ResultsList, SheetLevel, SourceModels } from "./model-picker/Lists";
import { createPicker } from "./model-picker/state";
import { shadow } from "./styles";

/** The tallest a list in the popover grows before it scrolls: the messenger's panel is 460 under its search and specials. */
const LIST_MAX = 380;

export function ModelPicker(props: {
  value?: string;
  data: PickerData;
  placeholder?: string;
  ariaLabel?: string;
  /** The sheet's heading on a phone; the field's label. */
  title?: string;
  disabled?: boolean;
  error?: boolean;
  size?: "default" | "sm";
  class?: string;
  testID?: string;
  /** The model changed (not called when the row picked is the one chosen). */
  onChange?: (value: string) => void;
}) {
  const t = () => copy().modelPicker;
  /** The picker keeps its own value, so it works with or without a parent that follows `onChange`. */
  const chosen = signal(props.value ?? "");
  effect(() => chosen.set(props.value ?? ""));
  const value = () => chosen();

  const picker = createPicker({
    data: () => props.data,
    value,
    placeholder: () => props.placeholder ?? "",
    title: () => props.title,
    ariaLabel: () => props.ariaLabel,
    pick: choose,
  });

  function choose(row: PickerRow): void {
    if (row.disabled) return;
    const changed = row.value !== chosen();
    chosen.set(row.value);
    picker.close();
    if (changed) props.onChange?.(row.value);
  }

  const width = signal(0);
  const small = () => props.size === "sm";
  const scroller: { ref: ScrollRef | null } = { ref: null };
  const bounds = new Map<number, { y: number; height: number }>();
  const viewport = { y: 0, height: 0 };

  /** Keeps the row the keys are on in view. */
  const reveal = (index: number) => {
    const at = bounds.get(index);
    if (!at || !scroller.ref || viewport.height === 0) return;
    if (at.y < viewport.y) scroller.ref.scrollTo({ y: at.y });
    else if (at.y + at.height > viewport.y + viewport.height) scroller.ref.scrollTo({ y: at.y + at.height - viewport.height });
  };
  effect(() => {
    if (picker.open() && !picker.phone()) reveal(picker.cursor());
  });

  // The keys the search input does not use itself: the arrows walk the sources and rows.
  effect(() => {
    if (!picker.open() || picker.phone()) return;
    const off = [
      keymap.bind("down", () => picker.arrow("down"), { repeat: true, when: "always" }),
      keymap.bind("up", () => picker.arrow("up"), { repeat: true, when: "always" }),
    ];
    if (!picker.trimmed()) {
      off.push(keymap.bind("left", () => picker.arrow("left"), { when: "always" }), keymap.bind("right", () => picker.arrow("right"), { when: "always" }));
    }
    return () => off.forEach((fn) => fn());
  });

  // The phone's Back walks up the sheet's levels, then closes it.
  effect(() => {
    if (!picker.open() || !picker.phone()) return;
    return holdBack(() => picker.sheetBack());
  });

  const label = () => props.ariaLabel ?? props.title;
  const trigger = (
    <View
      role="button"
      testID={props.testID ?? "model-picker"}
      accessibilityLabel={props.ariaLabel}
      accessibilityState={{ expanded: picker.open(), disabled: props.disabled }}
      disabled={props.disabled}
      onLayout={(e) => width.set(e.bounds.size.width)}
      onPress={() => (picker.phone() ? (picker.open() ? picker.close() : picker.openPicker()) : undefined)}
      class={`w-full flex-row items-center gap-[8px] rounded-(--radius-md) border bg-input-bg disabled:opacity-[0.55] ${
        small() ? "px-[10px] py-[6px]" : "px-[12px] py-[8px]"
      } ${props.error ? "border-danger-line" : picker.open() ? "border-field-focus-border" : "border-line hover:border-line-hover hover:bg-line-subtle"} ${props.class ?? ""}`}
      style={{ boxShadow: shadow("xs") }}
    >
      <If when={picker.picked()?.source?.mark ?? picker.picked()?.row.mark}>{(mark) => <ModelSourceMark source={mark()} />}</If>
      <Text
        testID="model-picker-value"
        class={`flex-1 min-w-0 line-clamp-1 ${small() ? "text-[13px]" : "text-[14px]"} ${!picker.picked() && !value() ? "text-ink-muted" : "font-medium text-ink"}`}
      >
        {picker.display()}
        <If when={picker.displayHint()}>{(hint) => <Text class="text-[12px] font-normal text-ink-muted">{`  ${hint()}`}</Text>}</If>
      </Text>
      <Icon name="chevron-down" size={12} class={picker.open() ? "tint-brand" : "tint-ink-muted"} />
    </View>
  );

  const panelWidth = () => (picker.many() ? 620 : Math.max(width(), 340));

  const Panel = () => (
    <View testID="model-picker-panel" accessibilityLabel={label()} class="overflow-hidden" >
      <SearchField picker={picker} placeholder={t().search} />
      <If when={picker.trimmed() === ""}>
        <>
            <If when={picker.specials().length > 0}>
              <View class="p-[4px] border-b border-line">
                <Each of={picker.specials()} key={(row) => row.value}>
                  {(row, i) => (
                    <ModelRow
                      row={row()}
                      selected={row().value === value()}
                      active={picker.column() === "rows" && picker.cursor() === i()}
                      onPick={choose}
                      onHover={() => !row().disabled && (picker.cursor.set(i()), picker.column.set("rows"))}
                      onLayout={(b) => bounds.set(i(), b)}
                    />
                  )}
                </Each>
              </View>
            </If>
            <View class="flex-row min-h-0 flex-1">
              <If when={picker.many()}>
                <Scroll class="shrink-0 border-r border-line bg-line-subtle" style={{ width: 196, maxHeight: LIST_MAX }} testID="model-sources">
                  <View class="p-[4px] gap-[1px]" accessibilityLabel={t().sources}>
                    <Each of={picker.sources()} key={(source) => source.key}>
                      {(source) => {
                        const active = () => source().key === picker.activeSource()?.key;
                        return (
                          <View
                            role="button"
                            testID={`model-source-${source().key}`}
                            accessibilityState={{ selected: active(), disabled: source().disabled }}
                            disabled={source().disabled}
                            onMouseEnter={() => picker.activate(source())}
                            onPress={() => {
                              picker.activate(source());
                              picker.column.set("rows");
                            }}
                            class={`flex-row items-center gap-[8px] w-full px-[8px] py-[7px] rounded-(--radius-sm) disabled:opacity-[0.5] ${
                              active() ? "bg-pane" : ""
                            } ${picker.column() === "sources" && active() ? "border-2 border-accent-border" : ""}`}
                            style={active() ? { boxShadow: shadow("xs") } : undefined}
                          >
                            <If when={source().mark}>{(mark) => <ModelSourceMark source={mark()} tile />}</If>
                            <Text class={`flex-1 min-w-0 line-clamp-1 text-[13px] font-medium ${active() ? "text-ink" : "text-ink-secondary"}`}>{source().label}</Text>
                            <Text class="text-[11px] text-ink-muted">{source().note ?? t().count(sourceCount(source()))}</Text>
                          </View>
                        );
                      }}
                    </Each>
                  </View>
                </Scroll>
              </If>
              <Scroll
                class="flex-1 min-w-0"
                style={{ maxHeight: LIST_MAX }}
                testID="model-scroll"
                ref={(node: ScrollRef | null) => (scroller.ref = node)}
                onLayout={(e) => (viewport.height = e.bounds.size.height)}
                onScroll={(e) => (viewport.y = e.offset.y)}
              >
                <SourceModels picker={picker} value={value} onPick={choose} onRowLayout={(i, b) => bounds.set(i, b)} />
              </Scroll>
            </View>
        </>
      </If>
      <If when={picker.trimmed() !== ""}>
        <Scroll
          testID="model-results-scroll"
          style={{ maxHeight: LIST_MAX }}
          ref={(node: ScrollRef | null) => (scroller.ref = node)}
          onLayout={(e) => (viewport.height = e.bounds.size.height)}
          onScroll={(e) => (viewport.y = e.offset.y)}
        >
          <ResultsList picker={picker} value={value} onPick={choose} onRowLayout={(i, b) => bounds.set(i, b)} />
        </Scroll>
      </If>
    </View>
  );

  return (
    <View class="w-full">
      <If when={!picker.phone()} else={trigger}>
        <Popover
          open={picker.open()}
          placement="bottom"
          align="start"
          offset={4}
          onOpenChange={(e) => {
            if (e.open) picker.openPicker();
            else if (e.reason === "cancel") picker.escape();
            else picker.close();
          }}
          trigger={trigger}
          popupClass="rounded-(--radius-md) border border-line bg-pane"
          popupStyle={{ width: panelWidth(), boxShadow: shadow("lg") }}
        >
          <Panel />
        </Popover>
      </If>
      <If when={picker.phone()}>
        <Sheet
          open={picker.open()}
          side="bottom"
          onOpenChange={(e) => {
            if (!e.open) {
              if (e.reason === "cancel") picker.escape();
              else picker.close();
            }
          }}
          backdropClass="bg-modal-backdrop"
          popupClass="bg-pane rounded-t-[16px]"
          popupStyle={{ minHeight: "52%", maxHeight: "86%", boxShadow: shadow("lg") }}
        >
          <View testID="model-picker-sheet" accessibilityLabel={picker.sheetTitle()}>
            <View class="items-center pt-[8px] pb-[2px]">
              <View class="w-[36px] h-[4px] rounded-full bg-line" />
            </View>
            <View class={`flex-row items-center gap-[8px] pb-[8px] pr-[8px] ${picker.sheetDepth() > 0 ? "pl-[4px]" : "pl-[16px] pt-[4px]"}`}>
              <If when={picker.sheetDepth() > 0}>
                <IconButton icon="chevron-left" size="lg" label={t().back} testID="model-sheet-back" onPress={() => picker.sheetBack()} />
              </If>
              <If when={picker.sheetAt()?.mark && picker.sheetGroup() === null ? picker.sheetAt()!.mark : null}>
                {(mark) => <ModelSourceMark source={mark()} tile />}
              </If>
              <Text testID="model-sheet-title" class="flex-1 min-w-0 line-clamp-1 text-[16px] font-semibold text-ink">
                {picker.sheetTitle()}
              </Text>
              <IconButton icon="x" size="lg" label={t().close} testID="model-sheet-close" onPress={() => picker.close()} />
            </View>
            <SearchField
              picker={picker}
              phone
              placeholder={picker.sheetAt() ? t().searchIn(picker.sheetGroupAt()?.label ?? picker.sheetAt()!.label) : t().search}
            />
            <Scroll class="flex-1">
              <SheetLevel picker={picker} value={value} onPick={choose} />
            </Scroll>
          </View>
        </Sheet>
      </If>
    </View>
  );
}
