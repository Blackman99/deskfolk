/** The picker's parts, as `ModelPicker.svelte` draws them: a model's row, a heading, the search field. */
import { Text, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import type { PickerRow, PickerSource } from "../../m/model-picker";
import { Icon } from "../Icon";
import { ModelSourceMark } from "../ModelSourceMark";
import type { Picker } from "./state";

/** One model: its source's mark (or the row's own), the name with its hint, the detail under it, a check when chosen. */
export function ModelRow(props: {
  row: PickerRow;
  selected: boolean;
  /** Where the keys are. */
  active?: boolean;
  /** The source whose mark leads the row (a typed name's). */
  from?: PickerSource | null;
  phone?: boolean;
  onPick: (row: PickerRow) => void;
  onHover?: () => void;
  onLayout?: (bounds: { y: number; height: number }) => void;
}) {
  const mark = () => props.from?.mark ?? props.row.mark ?? null;
  return (
    <View
      role="button"
      testID={`model-row-${props.row.value}`}
      accessibilityLabel={props.row.label}
      accessibilityState={{ selected: props.selected, disabled: props.row.disabled }}
      disabled={props.row.disabled}
      onPress={() => props.onPick(props.row)}
      onMouseEnter={() => props.onHover?.()}
      onLayout={(e) => props.onLayout?.({ y: e.bounds.origin.y, height: e.bounds.size.height })}
      class={`cursor-pointer select-none disabled:cursor-default flex-row items-center gap-[8px] rounded-(--radius-sm) disabled:opacity-[0.45] ${
        props.phone ? "min-h-[48px] px-[12px] py-[8px]" : "px-[10px] py-[6px]"
      } ${props.selected ? `bg-accent-tint ${props.active ? "border border-accent-border" : ""}` : props.active ? "bg-line-subtle" : "hover:bg-line-subtle active:bg-line-subtle"}`}
    >
      <If when={mark()}>{(m) => <ModelSourceMark source={m()} />}</If>
      <View class="flex-1 min-w-0">
        <Text class={`${props.phone ? "text-[15px]" : "text-[13px]"} line-clamp-1 ${props.selected ? "font-semibold text-brand" : "font-medium text-ink"}`}>
          {props.row.label}
          <If when={props.row.hint}>{(hint) => <Text class="text-[11px] font-normal text-ink-muted">{`  ${hint()}`}</Text>}</If>
        </Text>
        <If when={props.row.detail}>
          {(detail) => (
            <Text class={`${props.phone ? "text-[12px]" : "text-[11px]"} line-clamp-1 ${props.selected ? "text-ink-secondary" : "text-ink-muted"}`}>{detail()}</Text>
          )}
        </If>
      </View>
      <If when={props.selected}>
        <Icon name="check" size={16} class="tint-brand" />
      </If>
    </View>
  );
}

/** A source's heading over its rows in the search results. */
export function Heading(props: { source: PickerSource; phone?: boolean }) {
  return (
    <View class={`flex-row items-center gap-[6px] ${props.phone ? "px-[12px] pt-[10px] pb-[6px]" : "px-[10px] pt-[8px] pb-[4px]"}`}>
      <If when={props.source.mark}>{(mark) => <ModelSourceMark source={mark()} tile />}</If>
      <Text class={`${props.phone ? "text-[12px]" : "text-[11px]"} font-semibold text-ink-secondary`}>{props.source.label}</Text>
    </View>
  );
}

/** A group's heading, with its count. */
export function GroupHeading(props: { label: string; count: number; phone?: boolean }) {
  return (
    <View class={`flex-row items-center gap-[6px] ${props.phone ? "px-[12px] pt-[10px] pb-[6px]" : "px-[10px] pt-[8px] pb-[4px]"}`}>
      <Text class={`${props.phone ? "text-[12px]" : "text-[11px]"} text-ink-muted`}>{props.label}</Text>
      <Text class={`${props.phone ? "text-[12px]" : "text-[11px]"} text-ink-muted opacity-80`}>{String(props.count)}</Text>
    </View>
  );
}

export function Empty(props: { children?: JSX.Element }) {
  return (
    <View class="px-[12px] py-[18px] items-center">
      <Text class="text-[13px] text-ink-muted text-center">{props.children}</Text>
    </View>
  );
}

/** The search field: its own icon, a bare input. Enter and the arrow keys are the controller's (`ModelPicker.tsx` binds them). */
export function SearchField(props: { picker: Picker; placeholder: string; phone?: boolean }) {
  return (
    <View
      class={`flex-row items-center gap-[8px] ${
        props.phone ? "mx-[12px] mb-[6px] px-[12px] py-[9px] rounded-(--radius-md) bg-line-subtle" : "px-[12px] py-[8px] border-b border-line"
      }`}
    >
      <Icon name="search" size={16} class="tint-ink-muted" />
      <Input
        testID="model-picker-search"
        value={props.picker.query()}
        onChange={(e) => props.picker.query.set(e.value)}
        onSubmit={() => props.picker.enter()}
        placeholder={props.placeholder}
        accessibilityLabel={props.placeholder}
        autoFocus={!props.phone}
        autoCorrect={false}
        autoCapitalize="none"
        class={`flex-1 min-w-0 text-ink ${props.phone ? "text-[16px]" : "text-[13px]"}`}
      />
    </View>
  );
}
