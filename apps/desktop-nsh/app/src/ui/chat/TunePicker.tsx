/**
 * What a conversation's runs go on (an account, a model, a thinking level) in one picker that
 * cascades a level at a time (`TunePicker.svelte`, `tune-picker.ts`). It opens on the first level
 * alone; a row opens what is under it beside it (an account its models, a model the levels it takes)
 * when it is pointed at or pressed; only a row with nothing under it is a pick, which takes the path
 * up to it and closes. ↑↓ walk a column, → goes into a row, ← back a column, Enter picks, Esc closes.
 * On a phone a sheet from the bottom that goes into a row the same way, Back going up one. What each
 * level lists and what a pick does is the tree's (`AgentTune`, `BotTune`); the walking is
 * `tune-picker-state.ts`.
 *
 * Different from the Svelte one: the columns sit in an nsh/base `Popover` on the trigger, each next
 * column level with the row it came from by the measured row positions (`columnTops`), not by
 * reading rects; the keyboard opens it by pressing the trigger (Return or Space), not ↑↓.
 */
import { Scroll, Text, View, effect, keymap, signal, type ViewRef } from "nsh";
import { Popover } from "nsh/base";
import type { ModelSource } from "../../m/model-source";
import type { TuneRow, TuneTree } from "../../m/chat/tune-picker";
import { copy } from "../../runtime";
import { BottomSheet, SheetItem } from "../BottomSheet";
import { Icon } from "../Icon";
import { ModelSourceMark } from "../ModelSourceMark";
import { shadow } from "../styles";
import { tip } from "../tip";
import { narrowWindow as phoneSheet } from "../Modal";
import { columnTops, createTune, type ColumnBox } from "./tune-picker-state";

const COLUMN_HEIGHT = 420;

export function TunePicker(props: {
  tree: TuneTree;
  /** The picker's name, for readers. */
  label: string;
  /** On the closed picker: where the model comes from, the model, its level, and quieter after them, cut first, the rest. */
  mark?: ModelSource | null;
  value: string;
  level?: string | null;
  aside?: string | null;
  /** The closed picker's tooltip. */
  title: string;
  /** The phone sheet's heading at its top level. */
  sheetTitle: string;
  disabled: boolean;
  testID?: string;
}) {
  const tune = createTune({ tree: () => props.tree, disabled: () => props.disabled, phone: phoneSheet, sheetTitle: () => props.sheetTitle });
  const phone = phoneSheet;
  const boxes = signal<Record<string, ColumnBox | undefined>>({});

  function measure(key: string, patch: (box: ColumnBox) => ColumnBox): void {
    const now = boxes()[key] ?? { height: 0, listTop: 0, rows: {} };
    const next = patch(now);
    if (next.height === now.height && next.listTop === now.listTop && JSON.stringify(next.rows) === JSON.stringify(now.rows)) return;
    boxes.set({ ...boxes(), [key]: next });
  }
  const tops = () =>
    columnTops(
      tune.shown().map((level) => level.key),
      tune.focusOf,
      boxes(),
    );

  // The keys the picker keeps while its columns are open.
  effect(() => {
    if (!tune.open() || phone()) return;
    const names = ["down", "up", "home", "end", "left", "right", "enter", "space", "tab"] as const;
    const off = names.map((name) => keymap.bind(name, () => void tune.key(name), { when: "always", repeat: name === "down" || name === "up" }));
    return () => off.forEach((fn) => fn());
  });
  effect(() => {
    void tune.shown();
    tune.settleActive();
  });
  effect(() => () => tune.stop());

  const trigger = (
    <View
      role="button"
      testID={props.testID ?? "tune-trigger"}
      tooltip={tip(props.title)}
      accessibilityLabel={props.label}
      accessibilityState={{ expanded: tune.open(), disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => (tune.open() ? tune.close() : tune.openPicker())}
      class={`flex-row items-center gap-2 w-full px-[10px] py-[6px] bg-input-bg border rounded-(--radius-md) hover:border-line-hover hover:bg-line-subtle disabled:opacity-[0.55] disabled:bg-line-subtle ${tune.open() ? "border-field-focus-border" : "border-line"}`}
      style={{ boxShadow: props.disabled ? undefined : shadow("xs") }}
    >
      <If when={props.mark}>{(mark) => <ModelSourceMark source={mark()} />}</If>
      <Text class="flex-1 min-w-0 line-clamp-1 text-[13px] font-medium text-ink">
        <Text testID="tune-model">{props.value}</Text>
        <If when={props.level}>
          {(level) => (
            <>
              <Text class="text-ink-muted">{" · "}</Text>
              <Text testID="tune-effort">{level()}</Text>
            </>
          )}
        </If>
        <If when={props.aside}>{(aside) => <Text testID="tune-account" class="text-[12px] font-normal text-ink-muted">{`  ${aside()}`}</Text>}</If>
      </Text>
      <Icon name="chevron-down" size={12} class={tune.open() ? "tint-brand rotate-180" : "tint-ink-muted"} />
    </View>
  );

  const Row = (rowProps: { level: string; row: TuneRow; at: number; details?: boolean; leaf?: boolean }) => {
    const checked = () => rowProps.row.value === tune.checkedOf(rowProps.level);
    const more = () => !rowProps.leaf && tune.opensMore(rowProps.level, rowProps.row.value);
    const focused = () => rowProps.at < tune.shown().length - 1 && rowProps.row.value === tune.focusOf(rowProps.level);
    const keyed = () => tune.keyed() && tune.active() === rowProps.level && rowProps.row.value === tune.focusOf(rowProps.level);
    return (
      <View
        role="button"
        testID={`tune-row-${rowProps.level}-${rowProps.row.value || "default"}`}
        tooltip={rowProps.row.detail ? tip(rowProps.row.detail) : undefined}
        accessibilityLabel={rowProps.row.label}
        accessibilityState={{ selected: checked(), disabled: rowProps.row.disabled }}
        disabled={rowProps.row.disabled}
        onMouseEnter={() => tune.hover(rowProps.level, rowProps.row)}
        onPress={() => tune.press(rowProps.level, rowProps.row)}
        onLayout={(e) => measure(rowProps.level, (box) => ({ ...box, rows: { ...box.rows, [rowProps.row.value]: e.bounds.origin.y } }))}
        class={`flex-row items-center gap-[6px] px-2 py-[6px] rounded-(--radius-sm) disabled:opacity-[0.45] ${focused() ? "bg-line-subtle" : "hover:bg-line-subtle"} ${keyed() ? "border-2 border-accent-border" : ""}`}
      >
        <View class="flex-1 min-w-0">
          <Text class={`text-[13px] line-clamp-1 ${checked() ? "font-semibold text-brand" : "font-medium text-ink"}`}>{rowProps.row.label}</Text>
          <If when={rowProps.row.detail && rowProps.details}>
            {() => <Text class="text-[11px] text-ink-muted line-clamp-1">{rowProps.row.detail}</Text>}
          </If>
        </View>
        <If when={checked()}>
          <Icon name="check" size={12} class="tint-brand" />
        </If>
        <If when={more()}>
          <Icon name="chevron-right" size={12} class="tint-ink-muted" />
        </If>
      </View>
    );
  };

  const Panel = () => (
    <View testID="tune-panel" accessibilityLabel={props.label} class="flex-row items-start gap-1">
      <Each of={tune.shown()} key={(level) => level.key}>
        {(level, at) => (
          <View
            testID={`tune-column-${level().key}`}
            onLayout={(e) => measure(level().key, (box) => ({ ...box, height: e.bounds.size.height }))}
            class="p-1 bg-pane border border-line rounded-(--radius-md)"
            style={{ width: level().width, maxHeight: COLUMN_HEIGHT, marginTop: tops()[at()] ?? 0, boxShadow: shadow("lg") }}
          >
            <Text class="px-2 pt-[6px] pb-1 text-[11px] text-ink-muted">{level().heading}</Text>
            <Scroll style={{ maxHeight: COLUMN_HEIGHT - 60 }} onLayout={(e) => measure(level().key, (box) => ({ ...box, listTop: e.bounds.origin.y }))}>
              <View accessibilityLabel={level().heading}>
                <Each of={tune.rowsOf(level().key)} key={(row) => row.value}>
                  {(row) => <Row level={level().key} row={row()} at={at()} details={level().details} leaf={level().leaf} />}
                </Each>
              </View>
            </Scroll>
            <If when={level().note}>{(note) => <Text class="mx-2 my-1 text-[11px] text-ink-muted">{note()}</Text>}</If>
          </View>
        )}
      </Each>
    </View>
  );

  return (
    <View class="min-w-0 max-w-[460px]">
      <If when={!phone()} else={<>{trigger}</>}>
        <Popover
          open={tune.open()}
          placement="top"
          align="start"
          offset={4}
          closeOnEscape
          onOpenChange={(e) => {
            if (e.open) tune.openPicker();
            else tune.close();
          }}
          trigger={trigger}
          popupClass="bg-transparent"
        >
          <Panel />
        </Popover>
      </If>
      <If when={phone() && tune.open()}>
        <BottomSheet
          title={tune.sheetTitle()}
          closeLabel={copy().common.close}
          onClose={() => tune.close()}
          onBack={tune.shown().length > 1 ? () => tune.sheetBack() : undefined}
          backLabel={copy().common.back}
          testID="tune-sheet"
        >
          <View>
            <Text class="px-3 pt-[2px] pb-[6px] text-[12px] text-ink-muted">{tune.sheetLevel().heading}</Text>
            <View testID={`tune-list-${tune.sheetLevel().key}`} accessibilityLabel={tune.sheetLevel().heading}>
              <Each of={tune.rowsOf(tune.sheetLevel().key)} key={(row) => row.value}>
                {(row) => {
                  const level = () => tune.sheetLevel();
                  const checked = () => row().value === tune.checkedOf(level().key);
                  return (
                    <SheetItem
                      role="option"
                      testID={`tune-row-${level().key}-${row().value || "default"}`}
                      label={row().label}
                      detail={row().detail}
                      active={checked()}
                      disabled={row().disabled}
                      onPress={() => tune.press(level().key, row())}
                      trailing={
                        <>
                          <If when={checked()}>
                            <Icon name="check" size={16} class="tint-brand" />
                          </If>
                          <If when={!level().leaf && tune.opensMore(level().key, row().value)}>
                            <Icon name="chevron-right" size={16} class="tint-ink-muted" />
                          </If>
                        </>
                      }
                    />
                  );
                }}
              </Each>
            </View>
            <If when={tune.sheetLevel().note}>{(note) => <Text class="mx-3 my-[6px] text-[12px] text-ink-muted">{note()}</Text>}</If>
          </View>
        </BottomSheet>
      </If>
    </View>
  );
}
