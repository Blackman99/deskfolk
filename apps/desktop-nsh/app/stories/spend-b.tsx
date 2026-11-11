/**
 * The rest of the spend view: the whole ledger on a fake API (a week of October 2026, in UTC) with
 * its distribution table (model, session, Bot), the call details under day headings with a second
 * page, and the quality report; and the page form on the fixture's own runtime.
 */
import { signal, Text, View } from "nsh";
import type { Bot, QualityReportRow, SpendCategory, SpendCategorySummary, SpendDetail, SpendGroup, SpendLine, SpendSummary, SpendTotals } from "@real-bot/protocol";
import { SPEND_CATEGORY_OF } from "@real-bot/protocol";
import { runtime } from "../src/runtime";
import type { MessengerApi } from "../src/m/messenger-api.ts";
import { Button } from "../src/ui/Button";
import { narrowWindow } from "../src/ui/Modal";
import { SpendOverlay } from "../src/ui/spend/SpendOverlay";
import { SpendView } from "../src/ui/spend/SpendView";

const NOW = new Date("2026-10-10T08:00:00.000Z");
const USD = 10_000_000_000;

const totals = (partial: Partial<SpendTotals> = {}): SpendTotals => ({
  calls: 0,
  input_tokens: null,
  cached_tokens: null,
  output_tokens: null,
  reasoning_tokens: null,
  total_tokens: null,
  reported_usd_ticks: null,
  estimated_usd_ticks: null,
  reported_calls: 0,
  estimated_calls: 0,
  missing_calls: 0,
  missing_usage_calls: 0,
  ...partial,
});

const line = (kind: SpendLine, partial: Partial<SpendTotals>) => ({ ...totals({ calls: 1, ...partial }), kind });
const category = (name: SpendCategory, kinds: ReturnType<typeof line>[]): SpendCategorySummary => {
  const sum = (key: "calls" | "total_tokens" | "reported_usd_ticks" | "estimated_usd_ticks") => kinds.reduce((n, k) => n + (k[key] ?? 0), 0);
  return { ...totals({ calls: sum("calls"), total_tokens: sum("total_tokens"), reported_usd_ticks: sum("reported_usd_ticks") || null, estimated_usd_ticks: sum("estimated_usd_ticks") || null }), category: name, kinds };
};

const CATEGORIES: SpendCategorySummary[] = [
  category("turn", [line("turn", { calls: 31, total_tokens: 1_020_000, reported_usd_ticks: 4.2 * USD })]),
  category("judgement", [line("judgement", { calls: 9, total_tokens: 118_000, reported_usd_ticks: 0.31 * USD })]),
  category("decision", [line("route_pick", { calls: 12, total_tokens: 64_000, estimated_usd_ticks: 0.12 * USD })]),
];
for (const row of CATEGORIES) for (const kind of row.kinds) if (SPEND_CATEGORY_OF[kind.kind] !== row.category) throw new Error(`story: ${kind.kind}`);

const TOTALS = totals({
  calls: 52,
  input_tokens: 1_000_000,
  cached_tokens: 640_000,
  output_tokens: 202_000,
  reasoning_tokens: 52_000,
  total_tokens: 1_202_000,
  reported_usd_ticks: 4.51 * USD,
  estimated_usd_ticks: 0.12 * USD,
  reported_calls: 40,
  estimated_calls: 12,
});

const group = (id: string | null, name: string | null, partial: Partial<SpendGroup> = {}): SpendGroup => ({
  id,
  name,
  deleted: false,
  provider_id: null,
  provider_name: null,
  model: null,
  categories: [],
  ...totals({ calls: 1, total_tokens: 100 }),
  ...partial,
});

const MODELS = ["opus", "sonnet", "haiku", "gpt-5", "gemini", "grok", "kimi"].map((model, i) =>
  group(`model-${i}`, model, {
    provider_name: i < 3 ? "Anthropic" : "Other",
    model,
    calls: 20 - i * 2,
    input_tokens: 400_000 - i * 40_000,
    output_tokens: 80_000 - i * 8_000,
    total_tokens: 480_000 - i * 48_000,
    reported_usd_ticks: i < 3 ? (3 - i) * USD : null,
    estimated_usd_ticks: i === 3 ? 0.12 * USD : null,
  }),
);
const SESSIONS = [group("sess-1", "Weekly notes", { calls: 30, total_tokens: 900_000, input_tokens: 700_000, output_tokens: 200_000, reported_usd_ticks: 3.5 * USD }), group("sess-gone", "Old notes", { deleted: true, calls: 4, total_tokens: 80_000, reported_usd_ticks: 0.4 * USD })];
const BOTS = [
  group("bot-writer", "Writer", { calls: 40, total_tokens: 1_000_000, reported_usd_ticks: 4 * USD }),
  group("bot-gone", "Retired", { deleted: true, calls: 8, total_tokens: 150_000, reported_usd_ticks: 0.4 * USD }),
  group(null, null, { calls: 4, total_tokens: 50_000, estimated_usd_ticks: 0.12 * USD }),
];

const DAYS: Array<[string, number]> = [["2026-10-08", 300_000], ["2026-10-09", 500_000], ["2026-10-10", 402_000]];
const dayGroup = (id: string, tokens: number): SpendGroup => ({
  ...group(id, id, { calls: 3, total_tokens: tokens, reported_usd_ticks: tokens * 3_000_000 }),
  categories: [{ ...totals({ calls: 3, total_tokens: tokens, reported_usd_ticks: tokens * 3_000_000 }), category: "turn", kinds: [] }] as SpendGroup["categories"],
});

const summary = (groupBy: string | undefined): SpendSummary => ({
  totals: TOTALS,
  groups: groupBy === "day" ? DAYS.map(([id, tokens]) => dayGroup(id, tokens)) : groupBy === "session" ? SESSIONS : groupBy === "bot" ? BOTS : MODELS,
  categories: CATEGORIES,
});

const detail = (id: string, at: string, partial: Partial<SpendDetail> = {}): SpendDetail =>
  ({
    id,
    session_id: "sess-1",
    session_name: "Weekly notes",
    bot_id: "bot-writer",
    bot_name: "Writer",
    turn_id: "turn-1",
    judgement_id: null,
    kind: "turn",
    chain_id: null,
    provider_id: null,
    provider_name: "Anthropic",
    model: "opus",
    thinking_level: null,
    input_tokens: 1200,
    output_tokens: 300,
    total_tokens: 1500,
    cached_tokens: 400,
    reasoning_tokens: null,
    cost_usd_ticks: 0.05 * USD,
    estimated_cost_usd_ticks: null,
    missing_reason: null,
    created_at: at,
    trigger_message_id: `msg-${id}`,
    session_deleted: false,
    bot_deleted: false,
    ...partial,
  }) as SpendDetail;

const PAGE_ONE: SpendDetail[] = [
  detail("row-1", "2026-10-10T07:30:00.000Z"),
  detail("row-2", "2026-10-10T06:10:00.000Z", { kind: "route_pick", cost_usd_ticks: null, estimated_cost_usd_ticks: 0.02 * USD, trigger_message_id: null, model: null, bot_id: null, bot_name: null }),
  detail("row-3", "2026-10-09T22:00:00.000Z", { session_id: "sess-gone", session_name: "Old notes", session_deleted: true }),
];
const PAGE_TWO: SpendDetail[] = [detail("row-4", "2026-10-08T09:00:00.000Z", { model: "sonnet" })];

const QUALITY = (over: Partial<QualityReportRow>): QualityReportRow => ({
  bot_id: "bot-writer",
  bot_name: "Writer",
  model: "opus",
  plan_kind: "report",
  hand_overs: 4,
  approved: 1,
  review_rejected: 2,
  user_rejected: 1,
  checks_failed: 0,
  complaints: 1,
  failure_shapes: 0,
  review_misses: 0,
  cost_usd: 3.2,
  cost_per_approved: 3.2,
  ...over,
});
const QUALITY_ROWS: QualityReportRow[] = [
  QUALITY({}),
  QUALITY({ model: "sonnet", plan_kind: "video", hand_overs: 2, approved: 2, review_rejected: 0, user_rejected: 0, complaints: 0, cost_usd: 0.4, cost_per_approved: 0.2 }),
  QUALITY({ bot_id: "bot-gone", bot_name: null, hand_overs: 0, approved: 0, review_rejected: 0, user_rejected: 0, complaints: 2, cost_usd: null, cost_per_approved: null }),
  ...[1, 2, 3, 4, 5].map((n) => QUALITY({ bot_id: `bot-extra-${n}`, bot_name: `Helper ${n}`, hand_overs: n, approved: n, review_rejected: 0, user_rejected: 0, complaints: 0, cost_usd: 0.01, cost_per_approved: 0.01 })),
];

const WRITER = { id: "bot-writer", name: "Writer", avatar: null } as unknown as Bot;

export default function SpendB() {
  const none = signal(false);
  const fail = signal(false);
  const overlay = signal(false);
  const revision = signal(0);
  const capUsd = signal<number | null>(null);
  const events = signal<string[]>([]);
  const asked = signal<string[]>([]);
  const memory = new Map<string, string>();

  const api = {
    kind: "local" as const,
    spendSummary: async (query: { group_by?: string }) => {
      asked.update((list) => [...list, `summary:${query.group_by ?? ""}`]);
      if (fail()) throw new Error("down");
      return none() ? { totals: totals(), groups: [], categories: [] } : summary(query.group_by);
    },
    spendPage: async (query: { cursor?: string }) => {
      asked.update((list) => [...list, query.cursor ? `page:${query.cursor}` : "page"]);
      if (fail()) throw new Error("down");
      if (none()) return { items: [], next: null };
      return query.cursor ? { items: PAGE_TWO, next: null } : { items: PAGE_ONE, next: "c2" };
    },
    qualityReport: async () => QUALITY_ROWS,
  } as unknown as MessengerApi;

  const log = (text: string) => events.update((list) => [...list, text]);

  return (
    <View class="flex-1 bg-sidebar-bg">
      <View class="flex-1 min-h-0">
        <SpendView
          api={api}
          revision={revision()}
          locale={runtime.snapshot.settings.locale === "en" ? "en" : "zh"}
          timeZone="UTC"
          storage={{ getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value) }}
          now={() => NOW}
          bots={[WRITER]}
          providers={[]}
          capUsd={capUsd()}
          onSetCap={async (usd) => {
            capUsd.set(usd);
            log(`cap:${usd}`);
            return undefined;
          }}
          onOpenSession={(id) => log(`session:${id}`)}
          onOpenTrigger={(sessionId, messageId) => log(`trigger:${sessionId}:${messageId}`)}
          onClose={narrowWindow() ? () => log("close") : undefined}
          backLabel="Back"
        />
        <If when={overlay()}>
          <SpendOverlay backLabel="Back" />
        </If>
      </View>
      <View class="flex-row flex-wrap gap-2 px-6 py-2 border-t border-line items-center">
        <Button testID="story-none" size="sm" variant="secondary" onPress={() => none.set(!none())}>
          no figures
        </Button>
        <Button testID="story-fail" size="sm" variant="secondary" onPress={() => fail.set(!fail())}>
          fail
        </Button>
        <Button testID="story-revision" size="sm" variant="secondary" onPress={() => revision.update((n) => n + 1)}>
          revision
        </Button>
        <Button testID="story-overlay" size="sm" variant="secondary" onPress={() => overlay.set(!overlay())}>
          page form
        </Button>
        <Text testID="story-state" class="text-[10px] text-ink-muted">
          {JSON.stringify({ events: events(), asked: asked(), cap: capUsd(), overlay: overlay() })}
        </Text>
      </View>
    </View>
  );
}
