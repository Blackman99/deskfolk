/**
 * Every agent's usage laid out for a whole tab (ADR 0080): a band per agent with its day here,
 * a card per account across the width, each window a bar (the desktop's tab) or a dial (the
 * phone's page); the agents with only this app's records of today in one row of chips at the end
 * (`UsageBoard.svelte`). The messenger's grid is rows of flex here: agents fill a row by the
 * columns they span, an agent's cards fill rows of its span.
 */
import { computed, signal, Text, View } from "nsh";
import type { UsageAgent, UsageWindow } from "@real-bot/protocol";
import { copy } from "../../runtime";
import {
  usageAccountNote,
  usageAccountShortName,
  usageCreditsText,
  usageSplit,
  usageTokenText,
  usageWindowsSorted,
} from "../../m/usage/usage.ts";
import { AgentLogo } from "../settings/AgentLogo";
import { tip } from "../tip";
import { UsageBar } from "./UsageBar";
import { UsageGauge } from "./UsageGauge";
import { settled } from "../workbench/drag-settle";

/** The narrowest an account card gets; as many columns as fit, an agent's accounts side by side. */
const CARD_MIN = 360;
const GAP = 12;

/** Columns of cards a board `width` wide holds. */
export function boardColumns(width: number): number {
  return Math.max(1, Math.floor((width + GAP) / (CARD_MIN + GAP)));
}

/** How many columns an agent takes: its accounts side by side, up to the board's. */
export function agentSpan(agent: UsageAgent, columns: number): number {
  return Math.min(columns, Math.max(1, agent.accounts.length));
}

/** Items in rows of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

/** Agents flowed into rows as the grid places them: in order, a new row when the next does not fit. */
export function agentRows(agents: UsageAgent[], columns: number): UsageAgent[][] {
  const rows: UsageAgent[][] = [];
  let used = 0;
  for (const agent of agents) {
    const span = agentSpan(agent, columns);
    if (rows.length === 0 || used + span > columns) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1]!.push(agent);
    used += span;
  }
  return rows;
}

/** Dials a row holds: all of a card's up to three, two a row from four (Antigravity's 2 × 2). */
export const dialColumns = (count: number) => (count > 3 ? 2 : Math.max(1, count));

const key = (agent: UsageAgent) => `${agent.runner}:${agent.custom_id ?? ""}`;
const windowKey = (window: UsageWindow) => `${window.minutes ?? ""}:${window.model ?? ""}`;

export function UsageBoard(props: {
  agents: UsageAgent[];
  locale: string;
  now: number;
  /** How each window is drawn: a bar on the desktop's tab, a dial on the phone's page. */
  meter?: "bar" | "dial";
}) {
  const width = signal(0);
  // Kept while they say the same: the bands are made again when either changes, and the width moves
  // by the pixel while a divider is dragged.
  const columns = settled(() => boardColumns(width()));
  const split = computed(() => usageSplit(props.agents));
  const name = (agent: UsageAgent) => (agent.runner === "claude_code" ? "Claude" : agent.label);
  const today = (agent: UsageAgent) => copy().usage.today(String(agent.today.turns), usageTokenText(agent.today.tokens));
  const meter = () => props.meter ?? "dial";

  const card = (agent: UsageAgent, account: UsageAgent["accounts"][number]) => {
    const note = usageAccountNote(account, copy());
    const who = usageAccountShortName(agent, account, copy());
    const windows = usageWindowsSorted(account.windows);
    return (
      <View
        testID={`usage-account-${account.config_dir ?? ""}`}
        class="flex-1 basis-0 min-w-0 gap-[16px] pt-[14px] px-[16px] pb-[18px] border border-line rounded-(--radius-lg) bg-pane"
      >
        <View class="flex-row items-center gap-[8px] min-w-0">
          <View tooltip={account.error ? tip(account.error) : undefined} class="flex-row items-center gap-[8px] min-w-0 shrink">
            {who.plan ? (
              <Text testID="usage-account-plan" class="shrink-0 px-[8px] py-[1px] rounded-full bg-ink/10 text-[12px] font-semibold text-ink">
                {who.plan}
              </Text>
            ) : null}
            {who.who ? <Text testID="usage-account-who" class="min-w-0 shrink text-[13px] text-ink-muted line-clamp-1">{who.who}</Text> : null}
          </View>
          {account.credits ? (
            <Text testID="usage-credits" class="ml-auto text-[12px] text-ink-muted">
              {copy().usage.credits(usageCreditsText(account.credits, props.locale))}
            </Text>
          ) : null}
        </View>
        {note ? (
          <Text testID="usage-note" class="text-[13px] text-ink-muted">{note}</Text>
        ) : meter() === "bar" ? (
          <View class="gap-[14px]">
            {windows.map((window) => (
              <UsageBar window={window} locale={props.locale} now={props.now} />
            ))}
          </View>
        ) : (
          <View testID="usage-gauges" class="gap-[18px]">
            {chunk(windows, dialColumns(account.windows.length)).map((row) => (
              <View class="flex-row justify-center gap-[6px]">
                {row.map((window) => (
                  <View class="flex-1 min-w-[76px] max-w-[160px]">
                    <UsageGauge window={window} locale={props.locale} now={props.now} />
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}
      </View>
    );
  };

  const band = (agent: UsageAgent) => {
    const span = agentSpan(agent, columns());
    return (
      <View testID={`usage-agent-${agent.runner}`} class="min-w-0 gap-[12px]" style={{ flexGrow: span, flexBasis: 0 }}>
        <View class="flex-row items-center gap-[10px] min-w-0">
          <AgentLogo runner={agent.runner} size={22} />
          <Text testID="usage-board-agent-name" class="text-[15px] font-semibold text-ink">{name(agent)}</Text>
          <Text testID="usage-agent-today" class="shrink min-w-0 text-[12px] text-ink-muted line-clamp-1">{today(agent)}</Text>
        </View>
        {chunk(agent.accounts, span).map((accounts) => (
          <View class="flex-1 flex-row gap-[12px]">
            {accounts.map((account) => card(agent, account))}
            {Array.from({ length: span - accounts.length }, () => (
              <View class="flex-1 basis-0" />
            ))}
          </View>
        ))}
      </View>
    );
  };

  return (
    <View testID="usage-board" class="gap-[28px] min-w-0" onLayout={(e) => width.set(e.bounds.size.width)}>
      <If when={props.agents.length === 0}>
        <Text testID="usage-board-empty" class="text-[13px] leading-[20px] text-ink-muted">{copy().usage.empty}</Text>
      </If>
      <Each of={agentRows(split().plans, columns())} key={(row) => row.map(key).join("|")}>
        {(row) => <View class="flex-row gap-[12px] items-stretch min-w-0">{() => row().map((agent) => band(agent))}</View>}
      </Each>
      <If when={split().todayOnly.length > 0}>
        <View testID="usage-today-only" class="gap-[10px] pt-[20px] border-t border-line">
          <View class="flex-row flex-wrap items-baseline gap-x-[10px] gap-y-[4px]">
            <Text class="text-[13px] font-semibold text-ink-secondary">{copy().usage.todayOnly}</Text>
            <Text class="text-[12px] text-ink-muted">{copy().usage.todayOnlyHint}</Text>
          </View>
          <View class="flex-row flex-wrap gap-[8px]">
            <Each of={split().todayOnly} key={key}>
              {(agent) => (
                <View
                  testID={`usage-chip-${agent().runner}`}
                  class="flex-row items-center gap-[8px] min-w-0 py-[6px] pl-[8px] pr-[12px] border border-line rounded-full bg-pane"
                >
                  <AgentLogo runner={agent().runner} size={18} />
                  <Text class="text-[13px] text-ink">{agent().label}</Text>
                  <Text testID="usage-agent-today" class="text-[12px] text-ink-muted line-clamp-1">{today(agent())}</Text>
                </View>
              )}
            </Each>
          </View>
        </View>
      </If>
    </View>
  );
}
