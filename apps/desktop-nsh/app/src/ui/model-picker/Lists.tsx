/** The lists a picker draws, popover and sheet alike: search results, a source's models, the sheet's levels. */
import { Text, View } from "nsh";
import { copy } from "../../runtime";
import { sourceCount, type PickerGroup, type PickerRow, type PickerSource } from "../../m/model-picker";
import { Icon } from "../Icon";
import { ModelSourceMark } from "../ModelSourceMark";
import { groupsLevel, type Picker } from "./state";
import { Empty, GroupHeading, Heading, ModelRow } from "./Rows";

export type ListProps = {
  picker: Picker;
  value: () => string;
  onPick: (row: PickerRow) => void;
  /** The popover reports where each row is, to keep the keys' row in view. */
  onRowLayout?: (index: number, bounds: { y: number; height: number }) => void;
};

/** What a search found, by source, then the name typed when the source in view takes one. */
export function ResultsList(props: ListProps & { phone?: boolean }) {
  const p = props.picker;
  const keyed = () => !props.phone;
  const before = (r: number) => p.results().slice(0, r).reduce((sum, prior) => sum + prior.rows.length, 0);
  return (
    <View testID="model-results" class={props.phone ? "px-[8px] pb-[12px]" : "p-[4px]"}>
      <Each of={p.results()} key={(result) => result.source?.key ?? "·special"}>
        {(result, r) => (
          <>
            <If when={result().source}>{(source) => <Heading source={source()} phone={props.phone} />}</If>
            <Each of={result().rows} key={(row) => row.value}>
              {(row, i) => (
                <ModelRow
                  row={row()}
                  selected={row().value === props.value()}
                  active={keyed() && p.cursor() === before(r()) + i()}
                  phone={props.phone}
                  onPick={props.onPick}
                  onHover={() => keyed() && !row().disabled && (p.cursor.set(before(r()) + i()), p.column.set("rows"))}
                  onLayout={(b) => props.onRowLayout?.(before(r()) + i(), b)}
                />
              )}
            </Each>
          </>
        )}
      </Each>
      <If when={p.typedRow()}>
        {(typed) => (
          <ModelRow
            row={typed()}
            selected={false}
            from={p.typingFor()}
            active={keyed() && p.cursor() === p.rows().length - 1}
            phone={props.phone}
            onPick={props.onPick}
            onLayout={(b) => props.onRowLayout?.(p.rows().length - 1, b)}
          />
        )}
      </If>
      <If when={p.results().length === 0 && !p.typedRow()}>
        <Empty>{copy().modelPicker.noMatch}</Empty>
      </If>
    </View>
  );
}

/** The models of the source in view on the popover's right, in groups. */
export function SourceModels(props: ListProps) {
  const p = props.picker;
  const source = () => p.activeSource();
  const offset = (group: PickerGroup) => {
    const s = source();
    return s ? s.groups.slice(0, s.groups.indexOf(group)).reduce((sum, prior) => sum + prior.rows.length, 0) : 0;
  };
  // Where the rows start in the keys' order: after the specials, which are drawn above.
  const base = () => p.specials().length;
  return (
    <View testID="model-source-models" class="p-[4px]">
      <If when={source()}>
        {(s) => (
          <>
            <If when={sourceCount(s()) === 0}>
              <Empty>
                {copy().modelPicker.noModels}
                {s().custom ? `\n${copy().modelPicker.typeOwn}` : ""}
              </Empty>
            </If>
            <Each of={s().groups} key={(group) => group.key}>
              {(group) => (
                <>
                  <If when={group().label}>{(label) => <GroupHeading label={label()} count={group().rows.length} />}</If>
                  <Each of={group().rows} key={(row) => row.value}>
                    {(row, i) => {
                      const index = () => base() + offset(group()) + i();
                      return (
                        <ModelRow
                          row={row()}
                          selected={row().value === props.value()}
                          active={p.column() === "rows" && p.cursor() === index()}
                          onPick={props.onPick}
                          onHover={() => !row().disabled && (p.cursor.set(index()), p.column.set("rows"))}
                          onLayout={(b) => props.onRowLayout?.(index(), b)}
                        />
                      );
                    }}
                  </Each>
                </>
              )}
            </Each>
          </>
        )}
      </If>
    </View>
  );
}

/** One level down on the phone: a source or a group of a source's models, with where the chosen model is. */
export function SheetNav(props: { testID: string; mark?: PickerSource["mark"]; label: string; detail: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      class="flex-row items-center gap-[12px] min-h-[48px] px-[12px] py-[8px] rounded-(--radius-md) active:bg-line-subtle disabled:opacity-[0.5]"
    >
      <If when={props.mark}>{(mark) => <ModelSourceMark source={mark()} tile size={28} />}</If>
      <View class="flex-1 min-w-0">
        <Text class="text-[15px] font-medium text-ink line-clamp-1">{props.label}</Text>
        <Text class="text-[12px] text-ink-muted line-clamp-1">{props.detail}</Text>
      </View>
      <Icon name="chevron-right" size={16} class="tint-ink-muted" />
    </View>
  );
}

/** The sheet's current level, below the search: sources, a source's groups, or its models. */
export function SheetLevel(props: ListProps) {
  const p = props.picker;
  const t = () => copy().modelPicker;
  const pickedHere = (key: string) => (p.picked()?.source?.key === key ? ` · ${p.picked()!.row.label}` : "");
  const specials = () => p.specials();
  const specialRows = () => (
    <Each of={specials()} key={(row) => row.value}>
      {(row) => <ModelRow row={row()} selected={row().value === props.value()} phone onPick={props.onPick} />}
    </Each>
  );
  return (
    <If
      when={p.trimmed()}
      else={
        <If
          when={p.sheetAt()}
          else={
            <View testID="model-sheet-sources" class="px-[8px] pb-[12px]">
              {specialRows()}
              <Each of={p.sources()} key={(source) => source.key}>
                {(source) => (
                  <SheetNav
                    testID={`model-source-nav-${source().key}`}
                    mark={source().mark}
                    label={source().label}
                    detail={`${source().note ?? t().count(sourceCount(source()))}${pickedHere(source().key)}`}
                    disabled={source().disabled}
                    onPress={() => p.sheetInto(source())}
                  />
                )}
              </Each>
            </View>
          }
        >
          {(at) => (
            <If
              when={!p.sheetGroupAt() && groupsLevel(at())}
              else={
                <View testID="model-sheet-models" class="px-[8px] pb-[12px]">
                  <If when={!p.many() && !p.sheetGroupAt()}>{specialRows()}</If>
                  <If when={sourceCount(at()) === 0}>
                    <Empty>
                      {t().noModels}
                      {at().custom ? `\n${t().typeOwn}` : ""}
                    </Empty>
                  </If>
                  <Each of={p.sheetGroupAt() ? [p.sheetGroupAt()!] : at().groups} key={(group) => group.key}>
                    {(group) => (
                      <>
                        <If when={group().label && !p.sheetGroupAt()}>{() => <GroupHeading label={group().label!} count={group().rows.length} phone />}</If>
                        <Each of={group().rows} key={(row) => row.value}>
                          {(row) => <ModelRow row={row()} selected={row().value === props.value()} phone onPick={props.onPick} />}
                        </Each>
                      </>
                    )}
                  </Each>
                </View>
              }
            >
              <View testID="model-sheet-groups" class="px-[8px] pb-[12px]">
                <If when={!p.many()}>{specialRows()}</If>
                <Each of={at().groups} key={(group) => group.key}>
                  {(group) => (
                    <SheetNav
                      testID={`model-group-nav-${group().key}`}
                      label={group().label ?? at().label}
                      detail={`${t().count(group().rows.length)}${p.picked()?.group?.key === group().key && p.picked()?.source?.key === at().key ? ` · ${p.picked()!.row.label}` : ""}`}
                      onPress={() => p.sheetIntoGroup(group())}
                    />
                  )}
                </Each>
              </View>
            </If>
          )}
        </If>
      }
    >
      <ResultsList picker={p} value={props.value} onPick={props.onPick} phone />
    </If>
  );
}
