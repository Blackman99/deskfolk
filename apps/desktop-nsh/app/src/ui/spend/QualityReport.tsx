/**
 * The quality report under the spend view (ADR 0050; `QualityReport.svelte`): per Bot x model x
 * plan kind over the last week, how its hand-overs fared and what an approved one cost. It only
 * reads; to act on it, pin a model. Shown once there is something to report. Rows are grouped by
 * Bot, the busiest first; a Bot opens to its lines.
 */
import { effect, signal, Text, token, View } from "nsh";
import type { Bot, QualityReportRow } from "@real-bot/protocol";
import { spendCopyFor } from "../../m/spend/spend-copy.ts";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { SpendBotFace } from "./SpendBotFace";
import { SpendIcon } from "./SpendIcon";
import { SURFACE } from "./spend-style";

/** The busiest Bots first; the rest wait behind a button. */
const FIRST_BOTS = 5;

type Tally = { handOvers: number; approved: number; turnedBack: number; complaints: number; cost: number | null; costApproved: number };

function tally(lines: QualityReportRow[]): Tally {
  const sum: Tally = { handOvers: 0, approved: 0, turnedBack: 0, complaints: 0, cost: null, costApproved: 0 };
  for (const row of lines) {
    sum.handOvers += row.hand_overs;
    sum.approved += row.approved;
    sum.turnedBack += row.review_rejected + row.user_rejected + row.checks_failed;
    sum.complaints += row.complaints;
    // Per approval only counts lines that know what they cost.
    if (row.cost_usd != null) {
      sum.cost = (sum.cost ?? 0) + row.cost_usd;
      sum.costApproved += row.approved;
    }
  }
  return sum;
}

const hasWork = (row: QualityReportRow) => row.hand_overs + row.approved + row.review_rejected + row.user_rejected + row.checks_failed + row.complaints + row.failure_shapes + row.review_misses > 0;

export function QualityReport(props: {
  api: { qualityReport?: (days?: number) => Promise<QualityReportRow[]> } | null;
  locale?: "zh" | "en";
  /** Bumped with the spend view's own revision, so a new hand-over shows up. */
  revision?: number;
  /** The roster's Bot for an id, for its face beside its row. */
  botOf?: (id: string | null) => Bot | null;
  /** The ledger is narrower than 620 points (its container query); defaults to a phone-sized window. */
  narrow?: boolean;
}) {
  const narrow = () => props.narrow ?? narrowWindow();
  const copy = () => spendCopyFor(props.locale ?? "zh").quality;
  const rows = signal<QualityReportRow[]>([]);
  const open = signal<Record<string, boolean>>({});
  const showAll = signal(false);
  let seq = 0;

  effect(() => {
    void props.revision;
    const api = props.api;
    const load = api?.qualityReport;
    const mine = ++seq;
    if (!load) return;
    load.call(api, 7).then(
      (items) => {
        if (mine === seq) rows.set(items.filter(hasWork));
      },
      () => {
        if (mine === seq) rows.set([]);
      },
    );
  });

  const total = () => tally(rows());

  /** One entry per Bot, the busiest first. A deleted Bot keeps its own id, so two deleted Bots stay apart. */
  const bots = () => {
    const byBot = new Map<string, QualityReportRow[]>();
    for (const row of rows()) byBot.set(row.bot_id, [...(byBot.get(row.bot_id) ?? []), row]);
    return [...byBot].map(([id, lines]) => ({ id, name: lines[0]!.bot_name, lines, sum: tally(lines) })).sort((a, b) => b.sum.handOvers - a.sum.handOvers || b.lines.length - a.lines.length);
  };
  const shownBots = () => (showAll() ? bots() : bots().slice(0, FIRST_BOTS));

  function usd(value: number | null): string {
    if (value === null) return copy().none;
    return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
  }
  const perApproved = (sum: Tally) => (sum.cost != null && sum.costApproved > 0 ? usd(sum.cost / sum.costApproved) : copy().none);
  const rate = (sum: Tally) => (sum.handOvers > 0 ? `${Math.round(Math.min(1, sum.approved / sum.handOvers) * 100)}%` : copy().none);

  /** The meter's two parts, as shares of what was handed over; turned back fills what approval left. */
  function parts(sum: Tally): { approved: number; turnedBack: number } {
    if (sum.handOvers <= 0) return { approved: 0, turnedBack: 0 };
    const approved = Math.min(100, (sum.approved / sum.handOvers) * 100);
    return { approved, turnedBack: Math.min(100 - approved, (sum.turnedBack / sum.handOvers) * 100) };
  }

  const pad = () => (narrow() ? "px-[14px]" : "px-[18px]");
  const NAME = { flexGrow: 1.1, flexShrink: 1, flexBasis: 0, minWidth: 120 } as const;
  const METER = { flexGrow: 2, flexShrink: 1, flexBasis: 0, minWidth: 140 } as const;
  const STAT = { width: 56, flexShrink: 0 } as const;
  const COST = { width: 72, flexShrink: 0 } as const;

  const kpi = (id: string, label: string, value: string, part?: string, title?: string) => (
    <View testID={`quality-kpi-${id}`} class="gap-[2px] bg-pane min-w-0 px-3 py-[10px]" style={{ flexGrow: 1, flexShrink: 1, flexBasis: narrow() ? "28%" : 110 }} tooltip={title ? tip(title) : undefined}>
      <Text class="text-[11.5px] text-ink-muted">{label}</Text>
      <View class="flex-row items-baseline gap-[6px]">
        <Text class={`font-bold text-ink ${narrow() ? "text-[16px]" : "text-[18px]"}`}>{value}</Text>
        <If when={part}>
          <Text class="text-[11.5px] text-ink-muted">{part!}</Text>
        </If>
      </View>
    </View>
  );

  const stat = (id: string, label: string, value: string, cost = false) => (
    <View class={narrow() ? "flex-row gap-1" : "items-end"} style={narrow() ? undefined : cost ? COST : STAT}>
      <If when={narrow()}>
        <Text class="text-[12px] text-ink-muted">{label}</Text>
      </If>
      <Text testID={id} class={`text-[12.5px] ${cost ? "font-semibold text-ink" : "text-ink-secondary"}`}>
        {value}
      </Text>
    </View>
  );

  const lineCell = (testID: string | undefined, label: string, value: string, style: Record<string, unknown>, cost = false) => (
    <View class={narrow() ? "flex-row gap-1" : "items-end"} style={narrow() ? undefined : style}>
      <If when={narrow()}>
        <Text class="text-[12px] text-ink-muted">{label}</Text>
      </If>
      <Text testID={testID} class={`text-[12px] ${cost ? "font-semibold text-ink" : "text-ink-secondary"}`}>
        {value}
      </Text>
    </View>
  );

  const linesTable = (bot: { id: string; lines: QualityReportRow[] }) => (
    <View testID={`quality-lines-${bot.id}`} class="mb-[10px] border-l-2 border-line" style={{ marginLeft: narrow() ? 6 : 20 }}>
      <If when={!narrow()}>
        <View class="flex-row items-center gap-2 px-[10px] py-[6px] border-b border-line-subtle">
          <Text class="text-[12px] font-semibold text-ink-muted" style={{ flexGrow: 1.4, flexShrink: 1, flexBasis: 0, minWidth: 80 }}>
            {copy().model}
          </Text>
          <Text class="text-[12px] font-semibold text-ink-muted" style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 60 }}>
            {copy().kind}
          </Text>
          {[copy().handOvers, copy().approved, copy().turnedBack, copy().complaints, copy().shapes, copy().misses].map((label, i) => (
            <View class="items-end" style={{ width: i === 2 ? 80 : 56, flexShrink: 0 }} tooltip={i === 2 ? tip(copy().turnedBackTitle) : undefined}>
              <Text class="text-[12px] font-semibold text-ink-muted">{label}</Text>
            </View>
          ))}
          <View class="items-end" style={COST}>
            <Text class="text-[12px] font-semibold text-ink-muted">{copy().perApproved}</Text>
          </View>
        </View>
      </If>
      {bot.lines.map((row, i) => (
        <View
          testID={`quality-line-${bot.id}-${i}`}
          class={narrow() ? "flex-row flex-wrap items-baseline gap-x-3 gap-y-[2px] px-[14px] py-[10px] border-t border-line-subtle" : "flex-row items-center gap-2 px-[10px] py-[6px] border-b border-line-subtle"}
        >
          <Text class={`font-mono ${narrow() ? "text-[13px] font-semibold text-ink" : "text-[12px] text-ink-secondary"}`} style={narrow() ? undefined : { flexGrow: 1.4, flexShrink: 1, flexBasis: 0, minWidth: 80 }}>
            {row.model ?? copy().none}
          </Text>
          <Text class={`text-[12px] ${narrow() ? "text-ink-muted" : "text-ink-secondary"}`} style={narrow() ? undefined : { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 60 }}>
            {row.plan_kind ?? copy().none}
          </Text>
          <If when={narrow()}>
            <View style={{ flexBasis: "100%", height: 0 }} accessible={false} />
          </If>
          {lineCell(`quality-line-handovers-${bot.id}-${i}`, copy().handOvers, String(row.hand_overs), { width: 56, flexShrink: 0 })}
          {lineCell(`quality-line-approved-${bot.id}-${i}`, copy().approved, String(row.approved), { width: 56, flexShrink: 0 })}
          {lineCell(`quality-line-turned-${bot.id}-${i}`, copy().turnedBack, `${row.review_rejected} · ${row.user_rejected} · ${row.checks_failed}`, { width: 80, flexShrink: 0 })}
          {lineCell(undefined, copy().complaints, String(row.complaints), { width: 56, flexShrink: 0 })}
          {lineCell(undefined, copy().shapes, String(row.failure_shapes), { width: 56, flexShrink: 0 })}
          {lineCell(undefined, copy().misses, String(row.review_misses), { width: 56, flexShrink: 0 })}
          {lineCell(`quality-line-cost-${bot.id}-${i}`, copy().perApproved, usd(row.cost_per_approved), COST, true)}
        </View>
      ))}
    </View>
  );

  return (
    <If when={rows().length > 0}>
      <View testID="quality-report" role="region" accessibilityLabel={copy().title} class={SURFACE}>
        <View class={`gap-1 pt-[14px] pb-2 ${pad()}`}>
          <Text role="header" class="text-[14px] font-semibold text-ink">
            {copy().title}
          </Text>
          <Text class="text-[12px] leading-[17px] text-ink-muted">{copy().hint}</Text>
        </View>

        <View
          testID="quality-kpis"
          class="flex-row flex-wrap gap-px mt-[6px] mb-3 border border-line-subtle bg-line-subtle rounded-(--radius-sm) overflow-hidden"
          style={{ marginLeft: narrow() ? 14 : 18, marginRight: narrow() ? 14 : 18 }}
        >
          {kpi("handovers", copy().handOvers, String(total().handOvers))}
          {kpi("rate", copy().approvalRate, rate(total()), `${total().approved} / ${total().handOvers}`)}
          {kpi("turned-back", copy().turnedBack, String(total().turnedBack), undefined, copy().turnedBackTitle)}
          {kpi("complaints", copy().complaints, String(total().complaints))}
          {kpi("per-approved", copy().perApproved, perApproved(total()))}
        </View>

        <View role="list" accessibilityLabel={copy().bot} class={`pb-[10px] ${pad()}`}>
          <If when={!narrow()}>
            <View class="flex-row items-center gap-3 min-h-[30px] border-b border-line-subtle" accessible={false}>
              <Text class="text-[11.5px] text-ink-muted" style={NAME}>
                {copy().bot}
              </Text>
              <View class="flex-row gap-3" style={METER}>
                <View class="flex-row items-center gap-[5px]">
                  <View class="w-[8px] h-[8px] rounded-[2px]" style={{ backgroundColor: token("ok") }} />
                  <Text class="text-[11.5px] text-ink-muted">{copy().approved}</Text>
                </View>
                <View class="flex-row items-center gap-[5px]">
                  <View class="w-[8px] h-[8px] rounded-[2px]" style={{ backgroundColor: token("warn") }} />
                  <Text class="text-[11.5px] text-ink-muted">{copy().turnedBack}</Text>
                </View>
              </View>
              {[copy().handOvers, copy().turnedBack, copy().complaints].map((label) => (
                <View class="items-end" style={STAT}>
                  <Text class="text-[11.5px] text-ink-muted">{label}</Text>
                </View>
              ))}
              <View class="items-end" style={COST}>
                <Text class="text-[11.5px] text-ink-muted">{copy().perApproved}</Text>
              </View>
            </View>
          </If>
          <Each of={shownBots()} key={(bot) => bot.id}>
            {(bot, index) => (
              <View testID={`quality-bot-${bot().id}`} class={index() > 0 ? "border-t border-line-subtle" : ""}>
                <View class={narrow() ? "gap-[6px] pt-2 pb-[10px]" : "flex-row items-center gap-3 min-h-[44px]"}>
                  <View class={narrow() ? "flex-row items-center justify-between gap-[14px]" : ""} style={narrow() ? undefined : NAME}>
                    <View
                      testID={`quality-toggle-${bot().id}`}
                      role="button"
                      accessibilityLabel={`${bot().name ?? copy().deleted} · ${open()[bot().id] ? copy().hideLines : copy().showLines}`}
                      accessibilityState={{ expanded: !!open()[bot().id] }}
                      onPress={() => open.set({ ...open(), [bot().id]: !open()[bot().id] })}
                      class={`cursor-pointer select-none group flex-row items-center gap-2 min-w-0 shrink ${narrow() ? "min-h-[32px]" : "min-h-[40px]"}`}
                    >
                      <SpendIcon name="chevron" size={12} class={open()[bot().id] ? "tint-ink-muted" : "-rotate-90 tint-ink-muted"} />
                      <SpendBotFace id={bot().id} name={bot().name} bot={props.botOf?.(bot().id) ?? null} size={24} />
                      <View class={`min-w-0 shrink ${narrow() ? "flex-row items-baseline gap-2" : ""}`}>
                        <Text class="text-[12.5px] font-semibold text-ink group-hover:text-brand line-clamp-1">{bot().name ?? copy().deleted}</Text>
                        <Text class="text-[11px] text-ink-muted">{copy().lines(bot().lines.length)}</Text>
                      </View>
                    </View>
                    <If when={narrow()}>
                      <Text testID={`quality-rate-${bot().id}`} class="text-[12.5px] font-semibold text-ink">
                        {rate(bot().sum)}
                      </Text>
                    </If>
                  </View>
                  <View
                    class="flex-row items-center gap-2 min-w-0"
                    style={narrow() ? undefined : METER}
                    tooltip={tip(`${copy().approved} ${bot().sum.approved} · ${copy().turnedBack} ${bot().sum.turnedBack} · ${copy().handOvers} ${bot().sum.handOvers}`)}
                  >
                    <View class="flex-1 flex-row gap-[2px] h-[8px] bg-line-subtle rounded-full overflow-hidden" accessible={false}>
                      <View class="h-full" style={{ width: `${parts(bot().sum).approved}%`, backgroundColor: token("ok") }} />
                      <View class="h-full" style={{ width: `${parts(bot().sum).turnedBack}%`, backgroundColor: token("warn") }} />
                    </View>
                    <If when={!narrow()}>
                      <Text testID={`quality-rate-${bot().id}`} class="w-[36px] text-right text-[12.5px] font-semibold text-ink">
                        {rate(bot().sum)}
                      </Text>
                    </If>
                  </View>
                  <View class={narrow() ? "flex-row flex-wrap gap-x-[14px] gap-y-[2px]" : "flex-row items-center gap-3"}>
                    {stat(`quality-handovers-${bot().id}`, copy().handOvers, String(bot().sum.handOvers))}
                    {stat(`quality-turned-${bot().id}`, copy().turnedBack, String(bot().sum.turnedBack))}
                    {stat(`quality-complaints-${bot().id}`, copy().complaints, String(bot().sum.complaints))}
                    {stat(`quality-cost-${bot().id}`, copy().perApproved, perApproved(bot().sum), true)}
                  </View>
                </View>
                <If when={open()[bot().id]}>{linesTable(bot())}</If>
              </View>
            )}
          </Each>
        </View>
        <If when={bots().length > FIRST_BOTS}>
          <View class="items-center px-3 pt-[6px] pb-2 border-t border-line-subtle">
            <View
              testID="quality-more"
              role="button"
              accessibilityState={{ expanded: showAll() }}
              onPress={() => showAll.set(!showAll())}
              class="cursor-pointer select-none group min-h-[28px] justify-center px-[6px]"
            >
              <Text class="text-[12px] font-medium text-brand group-hover:underline">{showAll() ? copy().showFewer : copy().showAll(bots().length)}</Text>
            </View>
          </View>
        </If>
      </View>
    </If>
  );
}
