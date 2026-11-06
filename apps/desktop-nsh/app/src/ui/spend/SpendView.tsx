/**
 * The spend ledger (`SpendView.svelte`): the header with its period picker, then the overview (the
 * totals with the day's cap, the trend and categories, the distribution table) or the call details,
 * and the quality report under either. It fills its host; its layout follows the width it is given
 * (the messenger's container queries), measured here and passed to every part as `narrow` / `wide`.
 */
import { Scroll, signal, Text, token, View } from "nsh";
import type { ScrollRef } from "nsh/types";
import type { Bot, Provider } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api.ts";
import type { ModelSource } from "../../m/model-source.ts";
import { formatTokens, formatUsd } from "../../m/spend-format.ts";
import { spendCopyFor } from "../../m/spend/spend-copy.ts";
import { SpendLedger } from "../../m/spend/spend-ledger.svelte.ts";
import { spendSource } from "../../m/spend/spend-source.ts";
import { Button } from "../Button";
import { narrowWindow } from "../Modal";
import { QualityReport } from "./QualityReport";
import { SpendCap } from "./SpendCap";
import { SpendCategories } from "./SpendCategories";
import { SpendDetailTable } from "./SpendDetailTable";
import { SpendGroupTable } from "./SpendGroupTable";
import { SpendHeader } from "./SpendHeader";
import { SpendIcon } from "./SpendIcon";
import { SpendSummary } from "./SpendSummary";

/** The container query's breakpoints. */
const NARROW_AT = 620;
const WIDE_AT = 1000;

export function SpendView(props: {
  api: MessengerApi | null;
  /** Bumped when a `spend.created` or `spend.repriced` arrives. The ledger itself is not kept on the client. */
  revision?: number;
  locale?: "zh" | "en";
  /** The machine's zone. Day buckets and "today" are cut here. */
  timeZone?: string;
  /** Where the view remembers its range and dimension. Tests pass their own. */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** Clock for "today" and the custom-range default. Tests pin a day with this. */
  now?: () => Date;
  /** Open the conversation this row belongs to. */
  onOpenSession?: (sessionId: string) => void;
  /** Open the message that woke a turn. */
  onOpenTrigger?: (sessionId: string, messageId: string) => void;
  /** The narrow page's way out. A desktop pane leaves this unset and has no back button. */
  onClose?: () => void;
  backLabel?: string;
  /** The day's spend cap (ADR 0088), in USD; null is none. */
  capUsd?: number | null;
  /** Sets the cap; left out, the overview has no cap card. Resolves to a refusal or nothing. */
  onSetCap?: (usd: number | null) => Promise<unknown>;
  /** The roster, for each Bot's face beside its figures. */
  bots?: readonly Bot[];
  /** The endpoints, for the vendor's logo in front of a model. */
  providers?: readonly Pick<Provider, "id" | "base_url" | "api_format">[];
}) {
  const locale = () => props.locale ?? "zh";
  const timeZone = () => props.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const copy = () => spendCopyFor(locale());

  const sourceOf = (providerId: string | null, providerName: string | null): ModelSource | null => spendSource(providerId, providerName, props.providers ?? []);
  const botOf = (id: string | null | undefined): Bot | null => (id ? ((props.bots ?? []).find((bot) => bot.id === id) ?? null) : null);

  const memory = typeof localStorage === "undefined" ? null : localStorage;
  const ledger = new SpendLedger({
    api: () => props.api,
    revision: () => props.revision ?? 0,
    timeZone,
    storage: () => (props.storage === undefined ? memory : props.storage),
    now: () => props.now ?? (() => new Date()),
    copy,
  });

  /** The width the ledger is given; until it is measured, the window's. */
  const width = signal<number | null>(null);
  const narrow = () => (width() == null ? narrowWindow() : width()! <= NARROW_AT);
  const wide = () => (width() == null ? !narrowWindow() : width()! >= WIDE_AT);

  const section = signal<"overview" | "details">("overview");
  let scroll: ScrollRef | null = null;
  const positions = { overview: 0, details: 0 };
  let current = 0;

  function switchSection(next: "overview" | "details"): void {
    if (next === section()) return;
    positions[section()] = current;
    const top = positions[next];
    section.set(next);
    setTimeout(() => scroll?.scrollTo({ y: top, animated: false }), 0);
  }

  const num = (value: number | null) => (value == null ? copy().dash : formatTokens(value));
  const money = (ticks: number | null, estimated = false) => {
    if (ticks == null) return copy().dash;
    const text = formatUsd(ticks);
    return estimated ? `${text} ${copy().estimated}` : text;
  };

  /** With figures to show, the cap is the last tile of the overview's row; without, it stands alone above. */
  const hasFigures = () => !!ledger.summary && ledger.summary.totals.calls > 0 && !ledger.failed;
  const cap = () => (props.onSetCap ? <SpendCap copy={copy()} capUsd={props.capUsd ?? null} onSetCap={props.onSetCap} narrow={narrow()} /> : undefined);


  return (
    <View testID="spend-view" role="region" accessibilityLabel={copy().title} class="flex-1 min-w-0 min-h-0 overflow-hidden bg-sidebar-bg" onLayout={(e) => width.set(e.bounds.size.width)}>
      <SpendHeader copy={copy()} ledger={ledger} api={props.api} section={section()} switchSection={switchSection} onClose={props.onClose} backLabel={props.backLabel} narrow={narrow()} />

      <Scroll
        testID="spend-scroll"
        ref={(r: ScrollRef | null) => {
          scroll = r;
        }}
        onScroll={(e) => {
          current = e.offset.y;
        }}
        accessibilityLabel={section() === "overview" ? copy().overview : copy().details}
        class="flex-1 min-h-0"
        contentClass={narrow() ? "gap-3 px-3 pt-3 pb-6" : "gap-4 px-6 pt-5 pb-7"}
      >
        <If when={section() === "overview" && !hasFigures()}>{cap()}</If>
        <If
          when={!ledger.failed}
          else={
            <View testID="spend-error" role="alert" class="items-center gap-[14px] px-5 py-12">
              <View class="w-[40px] h-[40px] rounded-full items-center justify-center bg-danger-bg">
                <SpendIcon name="info" class="tint-danger-text" />
              </View>
              <Text class="text-[13px] font-semibold text-ink-muted">{copy().error}</Text>
              <Button testID="spend-retry" variant="secondary" disabled={ledger.loading || !!ledger.rangeIssue} onPress={() => ledger.refresh()}>
                {copy().retry}
              </Button>
            </View>
          }
        >
          <If
            when={ledger.summary}
            else={
              <View testID="spend-loading" role="text" class="items-center gap-[14px] px-5 py-12">
                <View class="w-[22px] h-[22px] rounded-full border-[2.5px] border-line animate-spin" style={{ borderTopColor: String(token("brand")) }} accessible={false} />
                <Text class="text-[13px] text-ink-muted">{copy().loading}</Text>
              </View>
            }
          >
            <If
              when={ledger.summary!.totals.calls > 0}
              else={
                <View testID="spend-empty" class="items-center gap-[14px] px-5 py-12">
                  <View class="w-[48px] h-[48px] rounded-(--radius-md) items-center justify-center bg-line-subtle">
                    <SpendIcon name="filter" size={20} />
                  </View>
                  <Text role="header" class="text-[15px] font-semibold text-ink">
                    {copy().empty}
                  </Text>
                  <Text class="max-w-[280px] text-[13px] leading-[19px] text-ink-muted text-center">{copy().emptyHint}</Text>
                  <If when={ledger.chips.length > 0}>
                    <Button
                      testID="spend-empty-clear"
                      variant="secondary"
                      onPress={() => {
                        ledger.drill = {};
                      }}
                    >
                      {copy().clearAll}
                    </Button>
                  </If>
                </View>
              }
            >
              <If
                when={section() === "overview"}
                else={
                  <SpendDetailTable
                    copy={copy()}
                    locale={locale()}
                    timeZone={timeZone()}
                    ledger={ledger}
                    num={num}
                    onOpenTrigger={props.onOpenTrigger}
                    botOf={botOf}
                    sourceOf={sourceOf}
                    narrow={narrow()}
                  />
                }
              >
                <SpendSummary copy={copy()} locale={locale()} totals={ledger.summary!.totals} num={num} money={money} extra={cap()} narrow={narrow()} />
                <SpendCategories copy={copy()} locale={locale()} timeZone={timeZone()} ledger={ledger} categories={ledger.summary!.categories} num={num} narrow={narrow()} wide={wide()} />
                <SpendGroupTable copy={copy()} ledger={ledger} num={num} onOpenSession={props.onOpenSession} botOf={botOf} sourceOf={sourceOf} narrow={narrow()} wide={wide()} />
              </If>
            </If>
          </If>
        </If>
        <QualityReport api={props.api} locale={locale()} revision={props.revision ?? 0} botOf={botOf} narrow={narrow()} />
      </Scroll>
    </View>
  );
}
