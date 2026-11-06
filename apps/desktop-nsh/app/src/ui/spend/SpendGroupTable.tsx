/**
 * The overview's distribution table (`SpendGroupTable.svelte`): the ledger grouped by model, session
 * or Bot, sortable by every column, the busiest rows first and the rest behind a button. Wide it is
 * a table with a share bar under each name; narrow (a phone, a narrow pane) every group is two lines
 * and a bar, the whole row picks it, and the sort moves into a picker beside the switch.
 */
import { effect, signal, Text, View } from "nsh";
import type { Bot, SpendGroup } from "@real-bot/protocol";
import { formatTokens, formatUsd } from "../../m/spend-format.ts";
import type { ModelSource } from "../../m/model-source.ts";
import type { SpendCopy } from "../../m/spend/spend-copy.ts";
import type { SpendLedger } from "../../m/spend/spend-ledger.svelte.ts";
import type { SpendDimension, SpendSortColumn } from "../../m/spend/spend-query.ts";
import { Icon } from "../Icon";
import { ModelSourceMark } from "../ModelSourceMark";
import { narrowWindow } from "../Modal";
import { Select } from "../Select";
import { tip } from "../tip";
import { Segmented } from "./Segmented";
import { SpendAmount } from "./SpendAmount";
import { SpendBotFace } from "./SpendBotFace";
import { SECTION_HEAD, SURFACE } from "./spend-style";

const DIMENSIONS: SpendDimension[] = ["model", "session", "bot"];
/** The first rows of a long list; the rest wait behind a button. A new dimension starts short again. */
const FIRST_ROWS = 6;

type ColumnLabel = keyof Pick<SpendCopy, "calls" | "input" | "output" | "totalTokens" | "reported" | "estimated"> | "name";
type Column = { key: SpendSortColumn; label: ColumnLabel };

const ALL_COLUMNS: Column[] = [
  { key: "name", label: "name" },
  { key: "calls", label: "calls" },
  { key: "input", label: "input" },
  { key: "output", label: "output" },
  { key: "total", label: "totalTokens" },
  { key: "reported", label: "reported" },
  { key: "estimated", label: "estimated" },
];

function columnValue(group: SpendGroup, column: SpendSortColumn): number | null {
  switch (column) {
    case "calls":
      return group.calls;
    case "input":
      return group.input_tokens;
    case "output":
      return group.output_tokens;
    case "total":
      return group.total_tokens;
    case "reported":
      return group.reported_usd_ticks;
    case "estimated":
      return group.estimated_usd_ticks;
    default:
      return null;
  }
}

const NUM_WIDTH = 84;
const MONEY_WIDTH = 96;

export function SpendGroupTable(props: {
  copy: SpendCopy;
  ledger: SpendLedger;
  num: (value: number | null) => string;
  /** Open the conversation this row belongs to. */
  onOpenSession?: (sessionId: string) => void;
  /** The roster's Bot for an id, for its face on the Bot dimension. */
  botOf?: (id: string | null) => Bot | null;
  /** Where a model ran, for its agent's or vendor's logo on the model dimension. */
  sourceOf?: (providerId: string | null, providerName: string | null) => ModelSource | null;
  /** The ledger is narrower than 620 points (its container query); defaults to a phone-sized window. */
  narrow?: boolean;
  /** The ledger is 1000 points or wider: the input and output columns show. */
  wide?: boolean;
}) {
  const narrow = () => props.narrow ?? narrowWindow();
  const wide = () => props.wide ?? !narrowWindow();
  const copy = () => props.copy;
  const ledger = () => props.ledger;

  const sortedGroups = () => {
    const rows = [...(ledger().summary?.groups ?? [])];
    const dir = ledger().view.dir === "asc" ? 1 : -1;
    const sort = ledger().view.sort;
    rows.sort((a, b) => {
      if (sort === "name") return ledger().groupLabel(a).localeCompare(ledger().groupLabel(b)) * dir;
      const av = columnValue(a, sort);
      const bv = columnValue(b, sort);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
    return rows;
  };

  const showAll = signal(false);
  effect(() => {
    void ledger().view.dimension;
    showAll.set(false);
  });
  const shownGroups = () => (showAll() ? sortedGroups() : sortedGroups().slice(0, FIRST_ROWS));

  /** An amount column no row has a figure in is a column of dashes; it is left out. One stays. */
  const hasReported = () => sortedGroups().some((group) => group.reported_usd_ticks != null);
  const hasEstimated = () => sortedGroups().some((group) => group.estimated_usd_ticks != null);
  const widest = () => Math.max(0, ...sortedGroups().map((group) => group.total_tokens ?? 0));
  const share = (value: number | null) => (value != null && widest() > 0 ? (value / widest()) * 100 : 0);

  function sortBy(column: SpendSortColumn): void {
    const view = ledger().view;
    if (view.sort === column) view.dir = view.dir === "asc" ? "desc" : "asc";
    else {
      view.sort = column;
      view.dir = column === "name" ? "asc" : "desc";
    }
  }

  const sortMark = (column: SpendSortColumn) => (ledger().view.sort !== column ? "" : ledger().view.dir === "asc" ? " ↑" : " ↓");

  function shows(column: Column): boolean {
    if (column.key === "reported") return hasReported();
    if (column.key === "estimated") return hasEstimated() || !hasReported();
    if (column.key === "input" || column.key === "output") return wide();
    return true;
  }
  const columns = () => ALL_COLUMNS.filter(shows);
  /** The narrow sort picker: every column on show, and whatever is sorting now. */
  const sortChoices = () => ALL_COLUMNS.filter((column) => (column.key !== "input" && column.key !== "output" ? shows(column) : true) || column.key === ledger().view.sort);

  const columnLabel = (column: Column) => (column.label === "name" ? copy().dimensions[ledger().shownDimension] : copy()[column.label]);
  const sortLabel = () => (ledger().view.dir === "asc" ? copy().ascending : copy().descending);

  const canOpen = (group: SpendGroup) => ledger().groupsActionable && ledger().shownDimension === "session" && !!group.id && !group.deleted && !!props.onOpenSession;
  const inactive = () => !ledger().groupsActionable || ledger().loading;

  const columnStyle = (column: Column) => (column.key === "name" ? { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 160 } : { width: column.key === "reported" || column.key === "estimated" ? MONEY_WIDTH : NUM_WIDTH, flexShrink: 0 });

  const nameCell = (group: () => SpendGroup, index: () => number, narrowRow: boolean) => {
    const source = () => (ledger().shownDimension === "model" ? props.sourceOf?.(group().provider_id, group().provider_name) ?? null : null);
    return (
      <View class="min-w-0 gap-[6px]">
        <View class="flex-row items-center gap-[6px] min-w-0">
          <If when={ledger().shownDimension === "bot"}>
            <SpendBotFace id={group().id} name={group().name} bot={props.botOf?.(group().id) ?? null} />
          </If>
          <If when={source()}>{(s) => <ModelSourceMark source={s()} tile />}</If>
          <View
            testID={`spend-group-name-${index()}`}
            role="button"
            disabled={inactive()}
            onPress={() => ledger().drillGroup(group())}
            class="group shrink min-w-0 min-h-[28px] justify-center"
          >
            <Text
              class={`font-semibold ${narrowRow ? "text-[14px] line-clamp-1" : "text-[13px]"} ${inactive() || group().deleted ? "text-ink-muted" : "text-ink group-hover:text-brand"}`}
            >
              {ledger().groupLabel(group())}
            </Text>
          </View>
          <If when={group().deleted}>
            <Text class="px-[5px] text-[10px] font-medium text-ink-muted border border-line rounded-(--radius-xs)">{copy().deleted}</Text>
          </If>
          <If when={canOpen(group())}>
            <View
              testID={`spend-open-session-${index()}`}
              role="button"
              tooltip={tip(copy().openSession)}
              accessibilityLabel={copy().openSession}
              onPress={() => props.onOpenSession?.(group().id!)}
              class={`group items-center justify-center shrink-0 rounded-(--radius-sm) hover:bg-line-subtle ${narrowRow ? "w-[40px] h-[40px]" : "w-[28px] h-[28px]"}`}
            >
              <Icon name="arrow-right" size={12} class="tint-ink-muted group-hover:tint-brand" />
            </View>
          </If>
        </View>
        <If when={!narrowRow}>
          <View class="h-[4px] max-w-[360px] bg-line-subtle rounded-full overflow-hidden" accessible={false}>
            <View class={`h-full min-w-[2px] rounded-full ${group().deleted ? "bg-muted-light" : "bg-brand"}`} style={{ width: `${share(group().total_tokens)}%` }} />
          </View>
        </If>
      </View>
    );
  };

  const wideRow = (group: () => SpendGroup, index: () => number) => (
    <View testID={`spend-group-${index()}`} class="flex-row items-center border-t border-line-subtle hover:bg-row-hover px-[18px] py-[10px] gap-3">
      <View style={columnStyle(ALL_COLUMNS[0]!)}>{nameCell(group, index, false)}</View>
      <Text testID={`spend-group-calls-${index()}`} class="text-[13px] text-ink text-right" style={columnStyle(ALL_COLUMNS[1]!)}>
        {formatTokens(group().calls)}
      </Text>
      <If when={wide()}>
        <Text testID={`spend-group-input-${index()}`} class="text-[13px] text-ink text-right" style={columnStyle(ALL_COLUMNS[2]!)}>
          {props.num(group().input_tokens)}
        </Text>
        <Text testID={`spend-group-output-${index()}`} class="text-[13px] text-ink text-right" style={columnStyle(ALL_COLUMNS[3]!)}>
          {props.num(group().output_tokens)}
        </Text>
      </If>
      <Text testID={`spend-group-total-${index()}`} class="text-[13px] text-ink text-right" style={columnStyle(ALL_COLUMNS[4]!)}>
        {props.num(group().total_tokens)}
      </Text>
      <If when={hasReported()}>
        <Text testID={`spend-group-reported-${index()}`} class="text-[13px] font-semibold text-ink text-right" style={columnStyle(ALL_COLUMNS[5]!)}>
          {group().reported_usd_ticks == null ? copy().dash : formatUsd(group().reported_usd_ticks!)}
        </Text>
      </If>
      <If when={hasEstimated() || !hasReported()}>
        <Text
          testID={`spend-group-estimated-${index()}`}
          class="text-[13px] font-semibold text-ink text-right"
          style={columnStyle(ALL_COLUMNS[6]!)}
          tooltip={group().estimated_usd_ticks == null && group().reported_usd_ticks == null ? tip(copy().estimateUnknown) : undefined}
        >
          {group().estimated_usd_ticks == null ? copy().dash : formatUsd(group().estimated_usd_ticks!)}
        </Text>
      </If>
    </View>
  );

  /** Narrow: the row is two lines, its money on the right and its calls and tokens under the name; the whole row picks it. */
  const narrowRow = (group: () => SpendGroup, index: () => number) => (
    <View
      testID={`spend-group-${index()}`}
      role="button"
      disabled={inactive()}
      onPress={() => ledger().drillGroup(group())}
      class="border-t border-line-subtle px-[14px] pt-[11px] pb-3 gap-[2px] active:bg-row-hover"
    >
      <View class="flex-row items-center gap-3">
        <View class="flex-1 min-w-0 gap-[2px]">
          {nameCell(group, index, true)}
          <Text testID={`spend-group-meta-${index()}`} class="text-[11.5px] text-ink-muted">
            {`${copy().recordedCalls(group().calls)} · ${copy().tokens(props.num(group().total_tokens))}`}
          </Text>
        </View>
        <SpendAmount copy={copy()} reported={group().reported_usd_ticks} estimated={group().estimated_usd_ticks} missing={copy().estimateUnknown} />
      </View>
      <View class="h-[3px] mt-[6px] bg-line-subtle rounded-full overflow-hidden" accessible={false}>
        <View class={`h-full min-w-[2px] rounded-full ${group().deleted ? "bg-muted-light" : "bg-brand"}`} style={{ width: `${share(group().total_tokens)}%` }} />
      </View>
    </View>
  );

  return (
    <View testID="spend-groups" role="region" accessibilityLabel={copy().dimension} class={SURFACE}>
      <View class={`${SECTION_HEAD} ${narrow() ? "gap-x-2 gap-y-[10px] px-[14px] py-3" : ""}`}>
        <View class={`gap-[2px] min-w-0 ${narrow() ? "w-full" : ""}`}>
          <Text role="header" class="text-[14px] font-semibold text-ink">
            {copy().distribution}
          </Text>
          <Text class="text-[12px] text-ink-muted">{copy().breakdownHint}</Text>
        </View>
        <Segmented
          testID="spend-dimension"
          label={copy().dimension}
          value={ledger().view.dimension}
          onChange={(dimension) => {
            ledger().view.dimension = dimension;
          }}
          items={DIMENSIONS.map((dimension) => ({ value: dimension, label: copy().dimensions[dimension], testID: `spend-dimension-${dimension}` }))}
        />
        <If when={narrow()}>
          <View class="flex-row items-center gap-1 ml-auto">
            <Text class="text-[12px] text-ink-muted">{copy().sort}</Text>
            <View class="min-w-[104px]">
              <Select
                testID="spend-sort-select"
                size="sm"
                ariaLabel={copy().sort}
                value={ledger().view.sort}
                options={sortChoices().map((column) => ({ value: column.key, label: columnLabel(column) }))}
                onChange={(value) => {
                  ledger().view.sort = value as SpendSortColumn;
                }}
              />
            </View>
            <View
              testID="spend-sort-dir"
              role="button"
              tooltip={tip(sortLabel())}
              accessibilityLabel={sortLabel()}
              onPress={() => {
                ledger().view.dir = ledger().view.dir === "asc" ? "desc" : "asc";
              }}
              class="w-[30px] h-[30px] items-center justify-center rounded-full bg-line-subtle"
            >
              <Text class="text-[13px] text-ink">{ledger().view.dir === "asc" ? "↑" : "↓"}</Text>
            </View>
          </View>
        </If>
      </View>

      <If when={!narrow()}>
        <View testID="spend-group-head" class="flex-row items-center gap-3 px-[18px] py-[10px] bg-sidebar-bg border-t border-line-subtle">
          <Each of={columns()} key={(column) => column.key}>
            {(column) => (
              <View
                testID={`spend-sort-${column().key}`}
                role="button"
                accessibilityLabel={copy().sortBy(columnLabel(column()))}
                accessibilityState={{ selected: ledger().view.sort === column().key }}
                onPress={() => sortBy(column().key)}
                class={`group min-h-[24px] justify-center ${column().key === "name" ? "items-start" : "items-end"}`}
                style={columnStyle(column())}
              >
                <Text class="text-[12px] font-medium text-ink-muted group-hover:text-ink">{`${columnLabel(column())}${sortMark(column().key)}`}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>

      <View testID="spend-group-rows">
        <Each of={shownGroups()} key={(group) => `${group.id ?? "null"}-${group.provider_id ?? ""}-${group.model ?? ""}`}>
          {(group, index) => (narrow() ? narrowRow(group, index) : wideRow(group, index))}
        </Each>
      </View>

      <If when={sortedGroups().length > FIRST_ROWS}>
        <View class="items-center px-3 pt-[6px] pb-2 border-t border-line-subtle">
          <View
            testID="spend-group-more"
            role="button"
            accessibilityState={{ expanded: showAll() }}
            onPress={() => showAll.set(!showAll())}
            class="group min-h-[28px] justify-center px-1"
          >
            <Text class="text-[12px] font-medium text-brand group-hover:underline">{showAll() ? copy().showFewerRows : copy().showAllRows(sortedGroups().length)}</Text>
          </View>
        </View>
      </If>
    </View>
  );
}
