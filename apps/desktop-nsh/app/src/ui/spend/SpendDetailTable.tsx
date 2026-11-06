/**
 * The call details (`SpendDetailTable.svelte`): every call the ledger has paged in, under one
 * heading per local day, newest first. Wide it is a table (time, purpose, session and Bot, model,
 * tokens, amount); narrow each call is two lines and the whole row opens the message that woke it.
 */
import { Text, View } from "nsh";
import { SPEND_CATEGORY_OF, spendLineOf } from "@real-bot/protocol";
import type { Bot, SpendDetail } from "@real-bot/protocol";
import { localeTag } from "../../m/locale-tag.ts";
import type { ModelSource } from "../../m/model-source.ts";
import type { SpendCopy } from "../../m/spend/spend-copy.ts";
import type { SpendLedger } from "../../m/spend/spend-ledger.svelte.ts";
import { calendarDate } from "../../m/spend/spend-query.ts";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { ModelSourceMark } from "../ModelSourceMark";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { SpendAmount } from "./SpendAmount";
import { SpendBotFace } from "./SpendBotFace";
import { SECTION_HEAD, SURFACE } from "./spend-style";

/** A purpose's label colours (`.kind-label.is-*`). */
const KIND_CLASS: Record<string, { box: string; text: string }> = {
  turn: { box: "bg-accent-tint", text: "text-brand" },
  judgement: { box: "bg-purple-bg", text: "text-purple-text" },
  decision: { box: "bg-ok-bg", text: "text-ok-text" },
  feedback: { box: "bg-warn-bg", text: "text-warn-text" },
};

export function SpendDetailTable(props: {
  copy: SpendCopy;
  locale: "zh" | "en";
  timeZone: string;
  ledger: SpendLedger;
  num: (value: number | null) => string;
  /** Open the message that woke a turn. */
  onOpenTrigger?: (sessionId: string, messageId: string) => void;
  /** The roster's Bot for an id, for its face beside the row's Bot. */
  botOf?: (id: string | null) => Bot | null;
  /** Where a model ran, for its agent's or vendor's logo in front of it. */
  sourceOf?: (providerId: string | null, providerName: string | null) => ModelSource | null;
  /** The ledger is narrower than 620 points (its container query); defaults to a phone-sized window. */
  narrow?: boolean;
}) {
  const narrow = () => props.narrow ?? narrowWindow();
  const copy = () => props.copy;
  const ledger = () => props.ledger;

  /** The calls of one local day, newest day first as the ledger pages them. */
  const days = () => {
    const out: { key: string; rows: SpendDetail[] }[] = [];
    for (const row of ledger().details) {
      const key = calendarDate(new Date(row.created_at), props.timeZone);
      const last = out[out.length - 1];
      if (last?.key === key) last.rows.push(row);
      else out.push({ key, rows: [row] });
    }
    return out;
  };

  const detailSession = (row: SpendDetail) => row.session_name ?? row.session_id;
  const detailBot = (row: SpendDetail) => (row.bot_id == null ? copy().unassignedBot : (row.bot_name ?? row.bot_id));
  const detailModel = (row: SpendDetail) => (row.model == null ? copy().unrecordedModel : row.provider_name ? `${row.provider_name} · ${row.model}` : row.model);

  function amountTitle(row: SpendDetail): string | undefined {
    if (row.estimated_cost_usd_ticks != null && row.cost_usd_ticks == null) return copy().estimatedHint;
    if (row.cost_usd_ticks == null && row.estimated_cost_usd_ticks == null) {
      if (row.input_tokens == null || row.output_tokens == null) return copy().estimateIncompleteUsage;
      return copy().estimateUnconfigured;
    }
    return undefined;
  }

  /** Every token field of the call, for the hover on its total. */
  const tokenTitle = (row: SpendDetail) =>
    (
      [
        [copy().input, row.input_tokens],
        [copy().cached, row.cached_tokens],
        [copy().output, row.output_tokens],
        [copy().reasoning, row.reasoning_tokens],
      ] as const
    )
      .map(([label, value]) => `${label} ${props.num(value)}`)
      .join(" · ");

  function dayLabel(key: string): string {
    const [year, month, day] = key.split("-").map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day));
    const thisYear = Number(calendarDate(new Date(), props.timeZone).slice(0, 4));
    return new Intl.DateTimeFormat(localeTag(props.locale), {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      weekday: "short",
      ...(year === thisYear ? {} : { year: "numeric" as const }),
    }).format(date);
  }

  const fullTime = (value: string) => new Intl.DateTimeFormat(localeTag(props.locale), { timeZone: props.timeZone, dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
  const timeLabel = (value: string) => new Intl.DateTimeFormat(localeTag(props.locale), { timeZone: props.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
  const canOpen = (row: SpendDetail) => !!row.trigger_message_id && !row.session_deleted && !!props.onOpenTrigger;
  const kindOf = (row: SpendDetail) => spendLineOf(row);
  const kindClass = (row: SpendDetail) => KIND_CLASS[SPEND_CATEGORY_OF[kindOf(row)]] ?? { box: "bg-line-subtle", text: "text-ink-secondary" };

  const deletedTag = (extra = "") => <Text class={`px-[5px] text-[10px] font-medium text-ink-muted border border-line rounded-(--radius-xs) ${extra}`}>{copy().deleted}</Text>;

  const kindLabel = (row: () => SpendDetail, id: string) => (
    <View testID={id} class={`self-start rounded-(--radius-xs) max-w-full ${kindClass(row()).box} ${narrow() ? "px-[5px]" : "px-[7px]"}`}>
      <Text class={`${narrow() ? "text-[10.5px]" : "text-[11px]"} font-medium leading-[16px] ${kindClass(row()).text}`}>{copy().kind[kindOf(row())]}</Text>
    </View>
  );

  const openButton = (row: () => SpendDetail) => (
    <View
      testID={`spend-open-trigger-${row().id}`}
      role="button"
      tooltip={tip(copy().openTrigger)}
      accessibilityLabel={copy().openTrigger}
      onPress={() => props.onOpenTrigger?.(row().session_id, row().trigger_message_id!)}
      class="group items-center justify-center shrink-0 w-[28px] h-[28px] rounded-(--radius-sm) hover:bg-line-subtle"
    >
      <Icon name="arrow-right" size={12} class="tint-ink-muted group-hover:tint-brand" />
    </View>
  );

  const modelName = (row: () => SpendDetail, small: boolean) => (
    <View class="flex-row items-center gap-[5px] min-w-0" tooltip={tip(detailModel(row()))}>
      <If when={row().model != null ? (props.sourceOf?.(row().provider_id, row().provider_name) ?? null) : null}>{(source) => <ModelSourceMark source={source()} tile />}</If>
      <Text class={`shrink min-w-0 line-clamp-1 ${small ? "text-[11.5px] text-ink-muted" : "text-[12px] text-ink-secondary"}`}>{row().model ?? copy().unrecordedModel}</Text>
    </View>
  );

  const ownerBot = (row: () => SpendDetail) => (
    <View class="flex-row items-center gap-[5px] min-w-0 shrink">
      <If when={row().bot_id != null}>
        <SpendBotFace id={row().bot_id} name={row().bot_name} bot={props.botOf?.(row().bot_id) ?? null} size={14} />
      </If>
      <Text class="shrink min-w-0 text-[11.5px] text-ink-muted line-clamp-1">{detailBot(row())}</Text>
    </View>
  );

  const wideRow = (row: () => SpendDetail) => (
    <View testID={`spend-detail-${row().id}`} class={`flex-row items-center gap-[10px] border-t border-line-subtle hover:bg-row-hover pl-[18px] pr-3 py-[9px] ${row().session_deleted || row().bot_deleted ? "opacity-70" : ""}`}>
      <View style={{ width: 54, flexShrink: 0 }}>
        <Text class="text-[12px] text-ink-muted" tooltip={tip(fullTime(row().created_at))}>
          {timeLabel(row().created_at)}
        </Text>
      </View>
      <View style={{ flexGrow: 1.1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>{kindLabel(row, `spend-detail-kind-${row().id}`)}</View>
      <View class="gap-[1px]" style={{ flexGrow: 2.4, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
        <View class="flex-row items-center gap-1 min-w-0">
          <Text class="shrink min-w-0 text-[13px] font-medium text-ink line-clamp-1">{detailSession(row())}</Text>
          <If when={row().session_deleted}>{deletedTag()}</If>
        </View>
        <View class="flex-row items-center gap-1 min-w-0">
          {ownerBot(row)}
          <If when={row().bot_deleted}>{deletedTag()}</If>
        </View>
      </View>
      <View class="gap-[1px]" style={{ flexGrow: 2, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
        {modelName(row, false)}
        <If when={row().model != null && row().provider_name}>
          <Text class="text-[11px] text-ink-muted line-clamp-1">{row().provider_name!}</Text>
        </If>
      </View>
      <View class="items-end" style={{ flexGrow: 1.1, flexShrink: 1, flexBasis: 0, minWidth: 0 }} tooltip={tip(tokenTitle(row()))}>
        <Text testID={`spend-detail-tokens-${row().id}`} class="text-[13px] font-medium text-ink">
          {props.num(row().total_tokens)}
        </Text>
        <If when={row().input_tokens != null || row().output_tokens != null}>
          <Text class="text-[11px] text-ink-muted line-clamp-1">{copy().inOut(props.num(row().input_tokens), props.num(row().output_tokens))}</Text>
        </If>
      </View>
      <View style={{ flexGrow: 1.3, flexShrink: 1, flexBasis: 0, minWidth: 0 }} tooltip={amountTitle(row()) ? tip(amountTitle(row())!) : undefined}>
        <SpendAmount copy={copy()} reported={row().cost_usd_ticks} estimated={row().cost_usd_ticks == null ? row().estimated_cost_usd_ticks : null} />
      </View>
      <View style={{ width: 36, flexShrink: 0 }} class="items-end">
        <If when={canOpen(row())}>{openButton(row)}</If>
      </View>
    </View>
  );

  /** Narrow: session, Bot and money on the first line; purpose, time, model and tokens on the second. */
  const narrowRow = (row: () => SpendDetail) => (
    <View
      testID={`spend-detail-${row().id}`}
      role={canOpen(row()) ? "button" : undefined}
      onPress={canOpen(row()) ? () => props.onOpenTrigger?.(row().session_id, row().trigger_message_id!) : undefined}
      class={`flex-row items-center gap-2 border-t border-line-subtle pl-[14px] pr-[10px] py-[10px] active:bg-row-hover ${row().session_deleted || row().bot_deleted ? "opacity-70" : ""}`}
    >
      <View class="flex-1 min-w-0 gap-1">
        <View class="flex-row items-center justify-between gap-2 min-w-0">
          <View class="flex-row items-baseline gap-[6px] flex-1 min-w-0">
            <Text class="shrink min-w-0 text-[14px] font-medium text-ink line-clamp-1">{detailSession(row())}</Text>
            <If when={row().session_deleted}>{deletedTag()}</If>
            {ownerBot(row)}
            <If when={row().bot_deleted}>{deletedTag()}</If>
          </View>
          <SpendAmount copy={copy()} reported={row().cost_usd_ticks} estimated={row().cost_usd_ticks == null ? row().estimated_cost_usd_ticks : null} />
        </View>
        <View class="flex-row items-center gap-2 min-w-0">
          {kindLabel(row, `spend-detail-kind-${row().id}`)}
          <Text class="text-[11.5px] text-ink-muted">{timeLabel(row().created_at)}</Text>
          <View class="flex-1 min-w-0">{modelName(row, true)}</View>
          <Text testID={`spend-detail-tokens-${row().id}`} class="text-[11.5px] text-ink-muted">
            {copy().tokens(props.num(row().total_tokens))}
          </Text>
        </View>
      </View>
      <If when={canOpen(row())}>
        <Icon name="arrow-right" size={12} class="tint-ink-muted" />
      </If>
    </View>
  );

  return (
    <View testID="spend-details" role="region" accessibilityLabel={copy().details} class={SURFACE}>
      <View class={`${SECTION_HEAD} ${narrow() ? "flex-nowrap px-[14px] py-3" : ""}`}>
        <View class="gap-[2px] min-w-0 shrink">
          <Text role="header" class="text-[14px] font-semibold text-ink">
            {copy().details}
          </Text>
          <If when={!narrow()}>
            <Text class="text-[12px] text-ink-muted">{copy().detailHint}</Text>
          </If>
        </View>
        <Text testID="spend-loaded-count" class="text-[12px] text-ink-muted">
          {copy().loadedCalls(ledger().details.length)}
        </Text>
      </View>

      <If when={!narrow()}>
        <View testID="spend-detail-head" class="flex-row items-center gap-[10px] pl-[18px] pr-3 py-[9px] bg-sidebar-bg border-t border-line-subtle">
          <View style={{ width: 54, flexShrink: 0 }}>
            <Text class="text-[12px] font-medium text-ink-muted">{copy().time}</Text>
          </View>
          <View style={{ flexGrow: 1.1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
            <Text class="text-[12px] font-medium text-ink-muted">{copy().categories}</Text>
          </View>
          <View style={{ flexGrow: 2.4, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
            <Text class="text-[12px] font-medium text-ink-muted">{`${copy().session} / ${copy().bot}`}</Text>
          </View>
          <View style={{ flexGrow: 2, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
            <Text class="text-[12px] font-medium text-ink-muted">{copy().model}</Text>
          </View>
          <View class="items-end" style={{ flexGrow: 1.1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
            <Text class="text-[12px] font-medium text-ink-muted">{copy().totalTokens}</Text>
          </View>
          <View class="items-end" style={{ flexGrow: 1.3, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
            <Text class="text-[12px] font-medium text-ink-muted">{copy().amount}</Text>
          </View>
          <View style={{ width: 36, flexShrink: 0 }} accessible={false} />
        </View>
      </If>

      <Each of={days()} key={(day) => day.key}>
        {(day) => (
          <View testID={`spend-day-${day().key}`}>
            <View class={`border-t border-line-subtle ${narrow() ? "bg-sidebar-bg pt-3 px-[14px] pb-1" : "bg-pane pt-[14px] px-[18px] pb-[6px]"}`}>
              <Text role="header" class="text-[12px] font-semibold text-ink-secondary">
                {dayLabel(day().key)}
              </Text>
            </View>
            <Each of={day().rows} key={(row) => row.id}>
              {(row) => (narrow() ? narrowRow(row) : wideRow(row))}
            </Each>
          </View>
        )}
      </Each>

      <If when={ledger().nextCursor}>
        <View class="items-center px-[18px] py-[14px] border-t border-line-subtle">
          <Button
            testID="spend-load-more"
            variant="secondary"
            disabled={ledger().loadingMore || ledger().loading}
            onPress={() => void ledger().loadMore()}
          >
            {ledger().loadingMore ? copy().loadingMore : copy().loadMore}
          </Button>
        </View>
      </If>
    </View>
  );
}
