/**
 * What a conversation's runs go on (for a Bot first what runs it, then an account, a model, a
 * thinking level) in one picker that cascades a level at a time (`TunePicker.svelte`,
 * `tune-picker.ts`). It opens on the first level alone; a row opens what is under it beside it (a
 * runner its endpoints or its agent's models, an account its models, a model the levels it takes)
 * when it is pointed at or pressed; only a row with nothing under it is a pick, which takes the path
 * up to it and closes. ↑↓ walk a column, → goes into a row, ← back a column, Enter picks, Esc closes.
 * On a phone a sheet from the bottom that goes into a row the same way, Back going up one; there a
 * composer's + may hold the picker instead (`bare`: the sheet alone, opened through `onHandle`). What each
 * level lists and what a pick does is the tree's (`AgentTune`, `BotTune`); the walking is
 * `tune-picker-state.ts`.
 *
 * Different from the Svelte one: the columns sit in an nsh/base `Popover` on the trigger, each next
 * column level with the row it came from by the measured row positions (`columnShifts`), not by
 * reading rects; the keyboard opens it by pressing the trigger (Return or Space), not ↑↓.
 *
 * The popover is placed by its size, its edge on the trigger: the columns line up on that edge (their
 * feet when it opens upwards) and each one after the first stands off it by a margin, so a taller
 * column opening grows the panel away from the trigger and the ones already open stay where they are.
 *
 * A press outside closes it, the message box and the sidebar's empty space included: NSH tells the
 * popover of neither (`platform/press.ts`), so the picker also closes on the shell's presses that
 * land outside its columns and its trigger. Not in a modal (the Bot↔Bot direct's): a frame measured
 * there is the dialog's, not the window's, and a press on a row would read as outside.
 */
import { Scroll, Text, View, cleanup, effect, keymap, signal, untracked, type ViewRef } from "nsh";
import { viewportSize } from "../../platform/viewport";
import { Popover } from "nsh/base";
import { frameOf, onPressOutside } from "../../platform/press";
import type { ModelSource } from "../../m/model-source";
import type { TuneRow, TuneTree } from "../../m/chat/tune-picker";
import { copy } from "../../runtime";
import { holdLevels } from "../../platform/page-levels";
import { BottomSheet, SheetItem } from "../BottomSheet";
import { Icon } from "../Icon";
import { ModelSourceMark } from "../ModelSourceMark";
import { shadow } from "../styles";
import { tip } from "../tip";
import { InModal, narrowWindow as phoneSheet } from "../Modal";
import { POPOVER_MARGIN, columnFit, columnHeight, columnShifts, createTune, type ColumnFrame } from "./tune-picker-state";

/** What opens the picker from elsewhere (the phone composer's +, which holds a bare one). */
export type TuneHandle = { open(): void };
/** What the closed picker says, for the row that stands in for it on the phone's + (`AgentTune`, `BotTune`). */
export type TuneShown = { mark: ModelSource | null; value: string; level: string | null; aside: string | null };
export type ShownTuneHandle = TuneHandle & { shown(): TuneShown };
/** The model, its level and the account in one line, as the closed picker reads. */
export const tuneLine = (shown: TuneShown) => [shown.value, shown.level, shown.aside].filter(Boolean).join(" · ");

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
  /** Instead of the closed picker's box, one plain row with this word (the consultants' "add one", inside their menu). */
  plain?: string;
  /** Called as the picker opens: what it lists may have changed since (another sign-in). */
  onOpen?: () => void;
  /** Whether its columns are out now: a menu it sits in leaves a press on them alone. */
  onOpenChange?: (open: boolean) => void;
  /** No closed picker of its own: only the phone's sheet, which `onHandle`'s opener opens (the composer's +). */
  bare?: boolean;
  onHandle?: (handle: TuneHandle | null) => void;
  testID?: string;
}) {
  const tune = createTune({ tree: () => props.tree, disabled: () => props.disabled, phone: phoneSheet, sheetTitle: () => props.sheetTitle, onOpen: () => props.onOpen?.() });
  effect(() => props.onOpenChange?.(tune.open()));
  props.onHandle?.({ open: () => tune.openPicker() });
  cleanup(() => props.onHandle?.(null));
  const phone = phoneSheet;
  // The phone sheet's levels have history entries of their own on the hosted page; Back there steps up one.
  cleanup(holdLevels({ name: "tune-sheet", depth: () => tune.sheetDepth(), inModal: true, stepOut: () => tune.sheetBack() }));
  const frames = signal<Record<string, ColumnFrame | undefined>>({});
  /** Where the popover went and the room it has there (`onPosition`); the room is null until it says. */
  const side = signal<"top" | "bottom">("top");
  const room = signal<number | null>(null);
  /** The columns and the trigger, measured at a press to tell whether it was outside both. */
  let panelRef: ViewRef | null = null;
  let triggerRef: ViewRef | null = null;

  function measure(key: string, patch: (frame: ColumnFrame) => ColumnFrame): void {
    const now = frames()[key] ?? { height: 0, listTop: 0, scroll: 0, rows: {} };
    const next = patch(now);
    if (next.height === now.height && next.listTop === now.listTop && next.scroll === now.scroll && JSON.stringify(next.rows) === JSON.stringify(now.rows)) return;
    frames.set({ ...frames(), [key]: next });
  }
  const shifts = () =>
    columnShifts(
      tune.shown().map((level) => level.key),
      tune.focusOf,
      frames(),
      side(),
      room(),
    );
  const height = () => columnHeight(room());
  /**
   * How much every column narrows so the widest path the picker can open fits the window side by
   * side (a Bot's goes runner, endpoint, model, level: some 880 pt). Read once at each open, the
   * window's width untracked, so a column never changes width while the picker is open.
   */
  const fit = signal(1);
  effect(() => {
    if (!tune.open() || phone()) return;
    untracked(() => fit.set(columnFit(props.tree.room(tune.focus()).map((level) => level.width), viewportSize().width)));
  });

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
  const inModal = InModal();
  // Both are read at the press: the columns grow as they open, and the box grows with its text and
  // moves the trigger. Pressing the trigger toggles the picker itself, on release, so a press there
  // is not outside.
  onPressOutside(
    async () => {
      if (!tune.open() || phone() || inModal) return [];
      return Promise.all([panelRef, triggerRef].map((view) => frameOf(view)));
    },
    () => {
      if (tune.open() && !phone() && !inModal) tune.close();
    },
  );

  const plainRow = (word: string) => (
    <View
      role="button"
      testID={props.testID ?? "tune-trigger"}
      ref={(node: ViewRef) => (triggerRef = node)}
      accessibilityLabel={word}
      accessibilityState={{ expanded: tune.open(), disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => (tune.open() ? tune.close() : tune.openPicker())}
      class={`cursor-pointer select-none disabled:cursor-default flex-row items-center w-full disabled:opacity-[0.45] hover:bg-line-subtle ${phone() ? "gap-3 min-h-[48px] px-3 py-[10px] rounded-(--radius-md) active:bg-line-subtle" : "gap-2 px-[10px] py-[6px] rounded-(--radius-sm)"} ${tune.open() ? "bg-line-subtle" : ""}`}
    >
      {/* In a phone's sheet it is one of the sheet's rows (`SheetItem`'s size). */}
      <Icon name="plus" size={phone() ? 20 : 16} class="tint-ink opacity-75" />
      <Text class={`flex-1 min-w-0 text-ink line-clamp-1 ${phone() ? "text-[15px]" : "text-[13px] font-medium"}`}>{word}</Text>
      <Icon name="chevron-right" size={phone() ? 16 : 12} class="tint-ink-muted" />
    </View>
  );

  const trigger = props.plain ? plainRow(props.plain) : (
    <View
      role="button"
      testID={props.testID ?? "tune-trigger"}
      ref={(node: ViewRef) => (triggerRef = node)}
      tooltip={tip(props.title)}
      accessibilityLabel={props.label}
      accessibilityState={{ expanded: tune.open(), disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => (tune.open() ? tune.close() : tune.openPicker())}
      class={`cursor-pointer select-none disabled:cursor-default flex-row items-center gap-2 w-full px-[10px] py-[6px] bg-input-bg border rounded-(--radius-md) hover:border-line-hover hover:bg-line-subtle disabled:opacity-[0.55] disabled:bg-line-subtle ${tune.open() ? "border-field-focus-border" : "border-line"}`}
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
    // The keys' ring is a 2 pt border every row has, clear but under the keys, so the rows and the
    // columns lined up on them (`columnShifts`) stay put as the keys walk (as `ModelRow`).
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
        class={`cursor-pointer select-none disabled:cursor-default flex-row items-center gap-[6px] px-[6px] py-[4px] rounded-(--radius-sm) border-2 disabled:opacity-[0.45] ${focused() ? "bg-line-subtle" : "hover:bg-line-subtle"} ${keyed() ? "border-accent-border" : "border-transparent"}`}
      >
        <If when={rowProps.row.mark}>{(mark) => <ModelSourceMark source={mark()} tile />}</If>
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
    <View testID="tune-panel" ref={(node: ViewRef) => (panelRef = node)} accessibilityLabel={props.label} class={`flex-row gap-1 ${side() === "top" ? "items-end" : "items-start"}`}>
      <Each of={tune.shown()} key={(level) => level.key}>
        {(level, at) => {
          const shift = () => shifts()[at()] ?? 0;
          // A column beside another waits unseen for its first measure, not drawn a frame on the edge first.
          const measured = () => at() === 0 || (frames()[level().key]?.height ?? 0) > 0;
          return (
            <View
              testID={`tune-column-${level().key}`}
              onLayout={(e) => measure(level().key, (frame) => ({ ...frame, height: e.bounds.size.height }))}
              class="p-1 bg-pane border border-line rounded-(--radius-md)"
              style={{
                width: Math.floor(level().width * fit()),
                maxHeight: height(),
                marginBottom: side() === "top" ? shift() : 0,
                marginTop: side() === "bottom" ? shift() : 0,
                opacity: measured() ? 1 : 0,
                boxShadow: shadow("menu"),
              }}
            >
              <Text class="px-2 pt-[6px] pb-1 text-[11px] text-ink-muted">{level().heading}</Text>
              <Scroll
                style={{ maxHeight: height() - 60 }}
                onLayout={(e) => measure(level().key, (frame) => ({ ...frame, listTop: e.bounds.origin.y }))}
                onScroll={(e) => measure(level().key, (frame) => ({ ...frame, scroll: e.offset.y }))}
              >
                <View accessibilityLabel={level().heading}>
                  <Each of={tune.rowsOf(level().key)} key={(row) => row.value}>
                    {(row) => <Row level={level().key} row={row()} at={at()} details={level().details} leaf={level().leaf} />}
                  </Each>
                </View>
              </Scroll>
              <If when={level().note}>{(note) => <Text class="mx-2 my-1 text-[11px] text-ink-muted">{note()}</Text>}</If>
            </View>
          );
        }}
      </Each>
    </View>
  );

  const sheet = (
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
                    leading={row().mark ? <ModelSourceMark source={row().mark!} tile size={20} /> : undefined}
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
  );

  // Bare, it takes no room where it sits: only its sheet, opened by its owner, which on the desktop
  // shows the closed picker instead (`bare` is the phone's).
  if (props.bare) return sheet;

  // `shrink` on the picker and on the popover's own box: NSH's flex items keep their content's width
  // unless told to give way (CSS's default `flex-shrink: 1` is 0 here), and the closed picker ran
  // past the send button instead of cutting its account first.
  return (
    <View class="shrink min-w-0 max-w-[460px]">
      <If when={!phone()} else={<>{trigger}</>}>
        <Popover
          class="shrink min-w-0"
          open={tune.open()}
          placement="top"
          align="start"
          offset={4}
          margin={POPOVER_MARGIN}
          onPosition={(e) => {
            if (e.placement === "top" || e.placement === "bottom") side.set(e.placement);
            room.set(Math.floor(e.available.height));
          }}
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
      {sheet}
    </View>
  );
}
