import {
  SPEND_CATEGORY_OF,
  type Spend,
  type SpendCategory,
  type SpendCategorySummary,
  type SpendDetail,
  type SpendFilter,
  type SpendGroup,
  type SpendKind,
  type SpendKindSummary,
  type SpendPage,
  type SpendSummary,
  type SpendSummaryQuery,
  type SpendTotals,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { estimateCostUsdTicks } from "../spend-pricing";
import { catalogEntries } from "./providers";
import { presentBotIds } from "./sessions";
import { type StoreContext } from "./shared";

const KINDS: readonly SpendKind[] = [
  "turn",
  "judgement",
  "route_pick",
  "route_review",
  "route_learn",
  "composer_suggest",
];
const CATEGORIES: readonly SpendCategory[] = ["turn", "judgement", "decision", "feedback", "other"];
const GROUP_BY = new Set<NonNullable<SpendSummaryQuery["group_by"]>>(["model", "session", "bot", "kind", "day"]);

/** What a caller hands the ledger. Kind is required; the store does not infer it from which id is set. */
export type SpendInput = {
  kind: SpendKind;
  sessionId: string;
  /** Frozen display title. Omitted means the store reads the session as it is now. */
  sessionName?: string | null;
  botId: string | null;
  botName?: string | null;
  turnId?: string | null;
  judgementId?: string | null;
  chainId?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  costUsdTicks?: number | null;
  estimatedCostUsdTicks?: number | null;
  missingReason?: Spend["missing_reason"];
};

type SpendRow = Spend;

type DetailRow = SpendRow & {
  trigger_message_id: string | null;
  session_alive: number | null;
  bot_alive: number | null;
};

type SumRow = {
  calls: number;
  input_tokens: number | null;
  cached_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  reported_usd_ticks: number | null;
  estimated_usd_ticks: number | null;
  reported_calls: number;
  estimated_calls: number;
  missing_calls: number;
  missing_usage_calls: number;
};

export function insertSpend(ctx: StoreContext, input: SpendInput): Spend {
  if (!KINDS.includes(input.kind)) {
    throw new HttpError(422, "invalid_args", "spend kind is required");
  }
  const sessionId = input.sessionId;
  const botId = input.botId ?? null;
  const providerId = emptyToNull(input.providerId);
  const model = emptyToNull(input.model);
  const cost = input.costUsdTicks ?? null;
  // A reported amount is the amount. An override cannot sit beside it and be summed as an estimate.
  const estimated = cost !== null
    ? null
    : input.estimatedCostUsdTicks !== undefined
    ? input.estimatedCostUsdTicks
    : estimateCostUsdTicks(
      {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedTokens: input.cachedTokens,
        costUsdTicks: cost,
      },
      pricingFor(ctx, providerId, model),
    );
  const now = isoNow();
  const row: Spend = {
    id: ulid(),
    session_id: sessionId,
    session_name: input.sessionName !== undefined ? input.sessionName : sessionTitle(ctx, sessionId),
    bot_id: botId,
    bot_name: input.botName !== undefined ? input.botName : (botId ? botName(ctx, botId) : null),
    turn_id: input.turnId ?? null,
    judgement_id: input.judgementId ?? null,
    kind: input.kind,
    chain_id: input.chainId ?? null,
    provider_id: providerId,
    provider_name: input.providerName !== undefined ? input.providerName : providerName(ctx, providerId),
    model,
    thinking_level: emptyToNull(input.thinkingLevel),
    input_tokens: input.inputTokens ?? null,
    output_tokens: input.outputTokens ?? null,
    total_tokens: input.totalTokens ?? null,
    cached_tokens: input.cachedTokens ?? null,
    reasoning_tokens: input.reasoningTokens ?? null,
    cost_usd_ticks: cost,
    estimated_cost_usd_ticks: estimated,
    missing_reason: input.missingReason ?? null,
    created_at: now,
  };
  ctx.db.run(
    `INSERT INTO spend (
       id, session_id, session_name, bot_id, bot_name, turn_id, judgement_id, kind, chain_id,
       provider_id, provider_name, model, thinking_level,
       input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens,
       cost_usd_ticks, estimated_cost_usd_ticks, missing_reason, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.session_id,
      row.session_name,
      row.bot_id,
      row.bot_name,
      row.turn_id,
      row.judgement_id,
      row.kind,
      row.chain_id,
      row.provider_id,
      row.provider_name,
      row.model,
      row.thinking_level,
      row.input_tokens,
      row.output_tokens,
      row.total_tokens,
      row.cached_tokens,
      row.reasoning_tokens,
      row.cost_usd_ticks,
      row.estimated_cost_usd_ticks,
      row.missing_reason,
      row.created_at,
    ],
  );
  return row;
}

/** Every matching row, oldest first. Prefer `spendPage` once the ledger is large. */
export function listSpend(ctx: StoreContext, filter: SpendFilter): Spend[] {
  const { where, args } = spendWhere(filter);
  const sql = `SELECT ${SPEND_COLUMNS} FROM spend${where} ORDER BY created_at ASC, id ASC`;
  return ctx.db.query<SpendRow, SqlValue[]>(sql).all(...args);
}

/** One already-summed slice. Null sums stay null; SQLite `SUM` of an empty set is null. */
type AggregateRow = SumRow & {
  group_id: string | null;
  group_name: string | null;
  deleted: number | null;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  kind: SpendKind;
};

export function spendSummary(ctx: StoreContext, query: SpendSummaryQuery): SpendSummary {
  const groupBy = query.group_by;
  if (groupBy !== undefined && !GROUP_BY.has(groupBy)) {
    throw new HttpError(422, "invalid_args", "group_by must be model, session, bot, kind, or day");
  }
  const zone = query.tz ?? "UTC";
  if (query.tz !== undefined || groupBy === "day") assertTimeZone(zone);
  const { where, args } = spendWhere(query);
  const totals = sumQuery(ctx, where).get(...args) ?? emptyTotals();
  const categories = categoriesFrom(kindSums(ctx, where, args));
  const groups = groupBy ? groupsOf(ctx, where, args, groupBy, zone) : [];
  return { totals: totalsOf(totals), groups, categories };
}

export function spendPage(
  ctx: StoreContext,
  filter: SpendFilter & { limit?: number; cursor?: string | null },
): SpendPage {
  const limit = filter.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new HttpError(422, "invalid_args", "limit must be an integer between 1 and 200");
  }
  const { where, args } = spendWhere(filter);
  const cursor = decodeCursor(filter.cursor);
  const cursorSql = cursor ? `${where ? " AND" : " WHERE"} (spend.created_at < ? OR (spend.created_at = ? AND spend.id < ?))` : "";
  const cursorArgs: SqlValue[] = cursor ? [cursor.created_at, cursor.created_at, cursor.id] : [];
  const rows = ctx.db.query<DetailRow, SqlValue[]>(
    `SELECT ${SPEND_COLUMNS},
            turns.trigger_message_id AS trigger_message_id,
            CASE
              WHEN sessions.id IS NULL THEN NULL
              WHEN sessions.kind = 'direct' AND EXISTS (
                SELECT 1 FROM session_participants
                JOIN bots ON bots.id = session_participants.member AND bots.deleted_at IS NOT NULL
                WHERE session_participants.session_id = sessions.id
                  AND session_participants.left_at IS NULL
                  AND session_participants.member != 'user'
              ) THEN NULL
              ELSE sessions.id
            END AS session_alive,
            CASE WHEN bots.deleted_at IS NULL THEN bots.id ELSE NULL END AS bot_alive
     FROM spend
     LEFT JOIN turns ON turns.id = spend.turn_id
     LEFT JOIN sessions ON sessions.id = spend.session_id
     LEFT JOIN bots ON bots.id = spend.bot_id
     ${where}${cursorSql}
     ORDER BY spend.created_at DESC, spend.id DESC
     LIMIT ?`,
  ).all(...args, ...cursorArgs, limit + 1);
  const page = rows.slice(0, limit);
  const extra = rows.length > limit ? rows[limit]! : null;
  return {
    items: page.map(toDetail),
    next: extra ? encodeCursor(page[page.length - 1]!) : null,
  };
}

const SPEND_COLUMNS = `spend.id, spend.session_id, spend.session_name, spend.bot_id, spend.bot_name,
  spend.turn_id, spend.judgement_id, spend.kind, spend.chain_id, spend.provider_id, spend.provider_name,
  spend.model, spend.thinking_level, spend.input_tokens, spend.output_tokens, spend.total_tokens,
  spend.cached_tokens, spend.reasoning_tokens, spend.cost_usd_ticks, spend.estimated_cost_usd_ticks,
  spend.missing_reason, spend.created_at`;

type SqlValue = string | number | null;

function spendWhere(filter: SpendFilter): { where: string; args: SqlValue[] } {
  const clauses: string[] = [];
  const args: SqlValue[] = [];
  if (filter.from !== undefined) {
    clauses.push("spend.created_at >= ?");
    args.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push("spend.created_at < ?");
    args.push(filter.to);
  }
  if (filter.kind && filter.kind.length > 0) {
    clauses.push(`spend.kind IN (${filter.kind.map(() => "?").join(", ")})`);
    args.push(...filter.kind);
  }
  if (filter.bot_id !== undefined) {
    if (filter.bot_id === null) clauses.push("spend.bot_id IS NULL");
    else {
      clauses.push("spend.bot_id = ?");
      args.push(filter.bot_id);
    }
  }
  if (filter.session_id !== undefined) {
    clauses.push("spend.session_id = ?");
    args.push(filter.session_id);
  }
  if (filter.model !== undefined) {
    if (filter.model === null) clauses.push("spend.model IS NULL");
    else {
      clauses.push("spend.model = ?");
      args.push(filter.model);
    }
  }
  if (filter.provider_id !== undefined) {
    clauses.push("spend.provider_id = ?");
    args.push(filter.provider_id);
  }
  if (filter.turn_id !== undefined) {
    clauses.push("spend.turn_id = ?");
    args.push(filter.turn_id);
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", args };
}

/** The name frozen on the earliest row of a group. A later rename does not rewrite it. */
const FROZEN_NAME = (column: string) =>
  `MIN(CASE WHEN ${column} IS NULL THEN NULL ELSE spend.created_at || ' ' || ${column} END)`;

const SUMS = `COUNT(*) AS calls,
  SUM(spend.input_tokens) AS input_tokens,
  SUM(spend.cached_tokens) AS cached_tokens,
  SUM(spend.output_tokens) AS output_tokens,
  SUM(spend.reasoning_tokens) AS reasoning_tokens,
  SUM(spend.total_tokens) AS total_tokens,
  SUM(spend.cost_usd_ticks) AS reported_usd_ticks,
  SUM(spend.estimated_cost_usd_ticks) AS estimated_usd_ticks,
  SUM(CASE WHEN spend.cost_usd_ticks IS NOT NULL THEN 1 ELSE 0 END) AS reported_calls,
  SUM(CASE WHEN spend.cost_usd_ticks IS NULL AND spend.estimated_cost_usd_ticks IS NOT NULL THEN 1 ELSE 0 END) AS estimated_calls,
  SUM(CASE WHEN spend.cost_usd_ticks IS NULL AND spend.estimated_cost_usd_ticks IS NULL THEN 1 ELSE 0 END) AS missing_calls,
  SUM(CASE WHEN spend.input_tokens IS NULL AND spend.cached_tokens IS NULL AND spend.output_tokens IS NULL
            AND spend.reasoning_tokens IS NULL AND spend.total_tokens IS NULL THEN 1 ELSE 0 END) AS missing_usage_calls`;

function sumQuery(ctx: StoreContext, where: string) {
  return ctx.db.query<SumRow, SqlValue[]>(`SELECT ${SUMS} FROM spend${where}`);
}

function kindSums(ctx: StoreContext, where: string, args: SqlValue[]): Map<SpendKind, SumRow> {
  const rows = ctx.db.query<SumRow & { kind: SpendKind }, SqlValue[]>(
    `SELECT spend.kind AS kind, ${SUMS} FROM spend${where} GROUP BY spend.kind`,
  ).all(...args);
  return new Map(rows.map((row) => [row.kind, totalsOf(row)]));
}

function groupsOf(
  ctx: StoreContext,
  where: string,
  args: SqlValue[],
  groupBy: NonNullable<SpendSummaryQuery["group_by"]>,
  zone: string,
): SpendGroup[] {
  if (groupBy === "day") return dayGroups(ctx, where, args, zone);
  const { select, group, join } = groupSql(groupBy);
  const rows = ctx.db.query<AggregateRow, SqlValue[]>(
    `SELECT ${select}, spend.kind AS kind, ${SUMS}
     FROM spend${join}
     ${where}
     GROUP BY ${group}, spend.kind`,
  ).all(...args);
  const buckets = new Map<string, { label: Omit<SpendGroup, keyof SpendTotals | "categories">; kinds: Map<SpendKind, SumRow> }>();
  for (const row of rows) {
    const label = labelOf(row, groupBy);
    const key = `${label.id ?? ""}\u0000${label.provider_id ?? ""}\u0000${label.model ?? ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { label, kinds: new Map() };
      buckets.set(key, bucket);
    }
    bucket.kinds.set(row.kind, totalsOf(row));
  }
  return [...buckets.values()]
    .map((bucket) => ({ ...bucket.label, ...combine([...bucket.kinds.values()]), categories: categoriesFrom(bucket.kinds) }))
    .sort(compareGroups);
}

/**
 * Group identity and the display columns SQLite can resolve. Day is not one of these: its cut
 * is an IANA calendar day the daemon computes, then SQLite sums inside each half-open bound.
 * A null model is one group even when a provider id is present. A deleted Bot keeps the name
 * frozen on the row.
 */
function groupSql(groupBy: Exclude<NonNullable<SpendSummaryQuery["group_by"]>, "day">): { select: string; group: string; join: string } {
  if (groupBy === "model") {
    return {
      select: `CASE WHEN spend.model IS NULL THEN NULL ELSE spend.provider_id END AS group_id,
        spend.model AS group_name, 0 AS deleted,
        CASE WHEN spend.model IS NULL THEN NULL ELSE MAX(spend.provider_id) END AS provider_id,
        CASE WHEN spend.model IS NULL THEN NULL ELSE MAX(COALESCE(providers.name, spend.provider_name)) END AS provider_name,
        spend.model AS model`,
      // A missing model is one group no matter which provider the row names. Two providers that
      // share a model name stay apart.
      group: `CASE WHEN spend.model IS NULL THEN 0 ELSE 1 END, CASE WHEN spend.model IS NULL THEN NULL ELSE spend.provider_id END, spend.model`,
      join: ` LEFT JOIN providers ON providers.id = spend.provider_id`,
    };
  }
  if (groupBy === "session") {
    return {
      select: `spend.session_id AS group_id,
        CASE
          WHEN sessions.id IS NULL THEN ${FROZEN_NAME("spend.session_name")}
          WHEN sessions.kind = 'group' THEN sessions.name
          WHEN EXISTS (
            SELECT 1 FROM session_participants
            JOIN bots ON bots.id = session_participants.member AND bots.deleted_at IS NOT NULL
            WHERE session_participants.session_id = sessions.id
              AND session_participants.left_at IS NULL
              AND session_participants.member != 'user'
          ) THEN ${FROZEN_NAME("spend.session_name")}
          ELSE COALESCE(
            (SELECT GROUP_CONCAT(bots.name, ' ↔ ')
             FROM (
               SELECT bots.name
               FROM session_participants
               JOIN bots ON bots.id = session_participants.member AND bots.deleted_at IS NULL
               WHERE session_participants.session_id = sessions.id
                 AND session_participants.left_at IS NULL
                 AND session_participants.member != 'user'
               ORDER BY session_participants.joined_at ASC, bots.name ASC
             ) AS bots),
            NULL)
        END AS group_name,
        CASE
          WHEN sessions.id IS NULL THEN 1
          WHEN sessions.kind = 'direct' AND EXISTS (
            SELECT 1 FROM session_participants
            JOIN bots ON bots.id = session_participants.member AND bots.deleted_at IS NOT NULL
            WHERE session_participants.session_id = sessions.id
              AND session_participants.left_at IS NULL
              AND session_participants.member != 'user'
          ) THEN 1
          ELSE 0
        END AS deleted,
        NULL AS provider_id, NULL AS provider_name, NULL AS model`,
      group: `spend.session_id`,
      join: ` LEFT JOIN sessions ON sessions.id = spend.session_id`,
    };
  }
  if (groupBy === "bot") {
    return {
      select: `spend.bot_id AS group_id,
        CASE
          WHEN spend.bot_id IS NULL THEN NULL
          WHEN bots.id IS NULL OR bots.deleted_at IS NOT NULL THEN ${FROZEN_NAME("spend.bot_name")}
          ELSE bots.name
        END AS group_name,
        CASE WHEN spend.bot_id IS NOT NULL AND (bots.id IS NULL OR bots.deleted_at IS NOT NULL) THEN 1 ELSE 0 END AS deleted,
        NULL AS provider_id, NULL AS provider_name, NULL AS model`,
      group: `spend.bot_id`,
      join: ` LEFT JOIN bots ON bots.id = spend.bot_id`,
    };
  }
  return {
    select: `spend.kind AS group_id, spend.kind AS group_name, 0 AS deleted,
      NULL AS provider_id, NULL AS provider_name, NULL AS model`,
    group: `spend.kind`,
    join: "",
  };
}

/**
 * Day buckets. SQLite shifts `created_at` by a modifier the daemon computed from the IANA zone
 * and sums that; it never names the zone. Each DST change is its own modifier. The ledger rows
 * themselves are not loaded.
 */
function dayGroups(ctx: StoreContext, where: string, args: SqlValue[], zone: string): SpendGroup[] {
  const bounds = ctx.db.query<{ first_at: string | null; last_at: string | null }, SqlValue[]>(
    `SELECT MIN(spend.created_at) AS first_at, MAX(spend.created_at) AS last_at FROM spend${where}`,
  ).get(...args);
  if (!bounds?.first_at || !bounds.last_at) return [];
  const spans = offsetSpans(bounds.first_at, bounds.last_at, zone);
  const buckets = new Map<string, Map<SpendKind, SumRow>>();
  for (const span of spans) {
    const link = where ? " AND" : " WHERE";
    const rows = ctx.db.query<AggregateRow, SqlValue[]>(
      `SELECT strftime('%Y-%m-%d', spend.created_at, ?) AS group_id,
              strftime('%Y-%m-%d', spend.created_at, ?) AS group_name,
              0 AS deleted, NULL AS provider_id, NULL AS provider_name, NULL AS model,
              spend.kind AS kind, ${SUMS}
       FROM spend${where}${link} spend.created_at >= ? AND spend.created_at < ?
       GROUP BY strftime('%Y-%m-%d', spend.created_at, ?), spend.kind`,
    ).all(span.modifier, span.modifier, ...args, span.from, span.to, span.modifier);
    for (const row of rows) {
      if (row.group_id) addKind(buckets, row.group_id, row.kind, totalsOf(row));
    }
  }
  return [...buckets.entries()]
    .map(([day, kinds]) => ({
      id: day,
      name: day,
      deleted: false,
      provider_id: null,
      provider_name: null,
      model: null,
      ...combine([...kinds.values()]),
      categories: categoriesFrom(kinds),
    }))
    .sort(compareGroups);
}

type OffsetSpan = { from: string; to: string; modifier: string };

/**
 * Ranges of one fixed UTC offset. The formatter is cached per zone. Every offset change between
 * the first and last row is a cut, including a summer offset that matches neither endpoint.
 */
function offsetSpans(firstIso: string, lastIso: string, zone: string): OffsetSpan[] {
  const first = Date.parse(firstIso);
  const last = Date.parse(lastIso);
  if (Number.isNaN(first) || Number.isNaN(last) || last < first) return [];
  const cuts = offsetCuts(zone, first, last);
  const spans: OffsetSpan[] = [];
  let from = firstIso;
  let offset = offsetAt(zone, first);
  for (const cut of cuts) {
    spans.push({ from, to: new Date(cut).toISOString(), modifier: secondsModifier(offset) });
    from = new Date(cut).toISOString();
    offset = offsetAt(zone, cut);
  }
  spans.push({ from, to: exclusiveAfter(lastIso), modifier: secondsModifier(offset) });
  return spans;
}

/** Instants where the zone's UTC offset changes, each the first millisecond of the new offset. */
function offsetCuts(zone: string, first: number, last: number): number[] {
  const cuts: number[] = [];
  let cursor = first;
  let previous = offsetAt(zone, cursor);
  const step = 6 * 60 * 60 * 1000;
  while (cursor < last) {
    const probe = Math.min(cursor + step, last);
    if (offsetAt(zone, probe) === previous) {
      cursor = probe;
      continue;
    }
    // IANA transitions occur on whole seconds; search that grid without formatting each millisecond.
    let lo = Math.floor(cursor / 1000) * 1000;
    let hi = Math.ceil(probe / 1000) * 1000;
    while (hi - lo > 1000) {
      const mid = Math.floor((lo + hi) / 2000) * 1000;
      if (offsetAt(zone, mid) === previous) lo = mid;
      else hi = mid;
    }
    const cut = hi;
    if (cut > last) break;
    cuts.push(cut);
    previous = offsetAt(zone, cut);
    cursor = cut;
  }
  return cuts;
}

function exclusiveAfter(iso: string): string {
  const instant = Date.parse(iso);
  return new Date((Number.isNaN(instant) ? Date.now() : instant) + 1).toISOString();
}

function secondsModifier(seconds: number): string {
  return `${seconds >= 0 ? "+" : ""}${seconds} seconds`;
}

function offsetAt(zone: string, instant: number): number {
  // Whole seconds. A leftover millisecond otherwise rounds the offset down by one.
  const second = Math.floor(instant / 1000) * 1000;
  const parts = offsetFormat(zone).formatToParts(second);
  const pick = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour") % 24, pick("minute"), pick("second"));
  return Math.round((asUtc - second) / 1000);
}

function addKind(into: Map<string, Map<SpendKind, SumRow>>, day: string, kind: SpendKind, totals: SumRow): void {
  let kinds = into.get(day);
  if (!kinds) {
    kinds = new Map();
    into.set(day, kinds);
  }
  const current = kinds.get(kind);
  kinds.set(kind, current ? combine([current, totals]) : totals);
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

function offsetFormat(zone: string): Intl.DateTimeFormat {
  const known = offsetFormats.get(zone);
  if (known) return known;
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  offsetFormats.set(zone, format);
  return format;
}

function categoriesFrom(byKind: Map<SpendKind, SumRow>): SpendCategorySummary[] {
  return CATEGORIES.map((category) => {
    const kinds = KINDS.filter((kind) => SPEND_CATEGORY_OF[kind] === category).map((kind) => ({
      kind,
      ...(byKind.get(kind) ?? emptyTotals()),
    }));
    return { category, kinds, ...combine(kinds) };
  });
}

function labelOf(
  row: AggregateRow,
  groupBy: NonNullable<SpendSummaryQuery["group_by"]>,
): Omit<SpendGroup, keyof SpendTotals | "categories"> {
  if (groupBy === "model") {
    return {
      id: row.model === null ? null : modelGroupId(row.provider_id, row.model),
      name: row.model,
      deleted: false,
      provider_id: row.provider_id,
      provider_name: row.provider_name,
      model: row.model,
    };
  }
  const deleted = row.deleted === 1;
  return {
    id: row.group_id,
    // A deleted session or Bot keeps `MIN(created_at || ' ' || name)`. The timestamp is the sort key.
    name: deleted && (groupBy === "session" || groupBy === "bot") ? frozenName(row.group_name) : row.group_name,
    deleted,
    provider_id: null,
    provider_name: null,
    model: null,
  };
}

function frozenName(value: string | null): string | null {
  if (value === null) return null;
  const split = value.indexOf(" ");
  return split >= 0 ? value.slice(split + 1) : value;
}

function compareGroups(a: SpendGroup, b: SpendGroup): number {
  const an = a.name ?? "";
  const bn = b.name ?? "";
  if (an !== bn) return an < bn ? -1 : 1;
  const ai = a.id ?? "";
  const bi = b.id ?? "";
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

function toDetail(row: DetailRow): SpendDetail {
  const { session_alive: sessionAlive, bot_alive: botAlive, trigger_message_id: trigger, ...spend } = row;
  return {
    ...spend,
    trigger_message_id: trigger,
    session_deleted: sessionAlive === null,
    bot_deleted: spend.bot_id !== null && botAlive === null,
  };
}

function encodeCursor(row: { created_at: string; id: string }): string {
  return `${row.created_at}|${row.id}`;
}

function decodeCursor(cursor: string | null | undefined): { created_at: string; id: string } | null {
  if (!cursor) return null;
  const split = cursor.lastIndexOf("|");
  const createdAt = split > 0 ? cursor.slice(0, split) : "";
  const id = split > 0 ? cursor.slice(split + 1) : "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
    throw new HttpError(422, "invalid_args", "spend cursor is not a page token");
  }
  return { created_at: createdAt, id };
}

function totalsOf(row: SumRow): SpendTotals {
  return {
    calls: row.calls ?? 0,
    input_tokens: row.input_tokens,
    cached_tokens: row.cached_tokens,
    output_tokens: row.output_tokens,
    reasoning_tokens: row.reasoning_tokens,
    total_tokens: row.total_tokens,
    reported_usd_ticks: row.reported_usd_ticks,
    estimated_usd_ticks: row.estimated_usd_ticks,
    reported_calls: row.reported_calls ?? 0,
    estimated_calls: row.estimated_calls ?? 0,
    missing_calls: row.missing_calls ?? 0,
    missing_usage_calls: row.missing_usage_calls ?? 0,
  };
}

function emptyTotals(): SpendTotals {
  return {
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
  };
}

function combine(rows: readonly SpendTotals[]): SpendTotals {
  if (rows.length === 0 || rows.every((row) => row.calls === 0)) return emptyTotals();
  const sum = (pick: (row: SpendTotals) => number | null): number | null => {
    let total = 0;
    let seen = false;
    for (const row of rows) {
      const value = pick(row);
      if (value === null) continue;
      total += value;
      seen = true;
    }
    return seen ? total : null;
  };
  return {
    calls: rows.reduce((total, row) => total + row.calls, 0),
    input_tokens: sum((row) => row.input_tokens),
    cached_tokens: sum((row) => row.cached_tokens),
    output_tokens: sum((row) => row.output_tokens),
    reasoning_tokens: sum((row) => row.reasoning_tokens),
    total_tokens: sum((row) => row.total_tokens),
    reported_usd_ticks: sum((row) => row.reported_usd_ticks),
    estimated_usd_ticks: sum((row) => row.estimated_usd_ticks),
    reported_calls: rows.reduce((total, row) => total + row.reported_calls, 0),
    estimated_calls: rows.reduce((total, row) => total + row.estimated_calls, 0),
    missing_calls: rows.reduce((total, row) => total + row.missing_calls, 0),
    missing_usage_calls: rows.reduce((total, row) => total + row.missing_usage_calls, 0),
  };
}

function pricingFor(ctx: StoreContext, providerId: string | null, model: string | null) {
  if (!providerId || !model) return null;
  const entry = catalogEntries(ctx).find((item) => item.providerId === providerId && item.name === model);
  return entry?.pricing ?? null;
}

function providerName(ctx: StoreContext, providerId: string | null): string | null {
  if (!providerId) return null;
  const row = ctx.db.query<{ name: string }, [string]>(`SELECT name FROM providers WHERE id = ?`).get(providerId);
  return row?.name ?? null;
}

function botName(ctx: StoreContext, botId: string): string | null {
  const row = ctx.db.query<{ name: string }, [string]>(`SELECT name FROM bots WHERE id = ?`).get(botId);
  return row?.name ?? null;
}

/** Group name, the other side of a you↔Bot direct, or `A ↔ B`. */
function sessionTitle(ctx: StoreContext, sessionId: string): string | null {
  const session = ctx.db
    .query<{ kind: string; name: string | null }, [string]>(`SELECT kind, name FROM sessions WHERE id = ?`)
    .get(sessionId);
  if (!session) return null;
  if (session.kind === "group") return session.name;
  const names = presentBotIds(ctx, sessionId)
    .map((id) => botName(ctx, id))
    .filter((name): name is string => Boolean(name));
  return names.length <= 1 ? (names[0] ?? null) : names.join(" ↔ ");
}

/** Stable opaque id for one provider plus model. A null model is its own group and is not hashed. */
export function modelGroupId(providerId: string | null, model: string | null): string {
  return `m:${providerId ?? ""}:${model ?? ""}`;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function assertTimeZone(zone: string): void {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
  } catch {
    throw new HttpError(422, "invalid_args", "tz must be an IANA time zone");
  }
}

/** `YYYY-MM-DD` of an ISO instant in `timeZone`. The cut is made here, not by SQLite. */
export function calendarDate(iso: string, timeZone: string): string {
  assertTimeZone(timeZone);
  const instant = Date.parse(iso);
  const local = instant + offsetAt(timeZone, instant) * 1000;
  return new Date(local).toISOString().slice(0, 10);
}

export type { SpendKindSummary };
