import type { RouteLogRow, RouteOutcomeKind } from "./route-log.ts";

/** Outcomes in the order the log already paints them. */
export const ROUTE_OUTCOME_ORDER: readonly RouteOutcomeKind[] = [
  "live",
  "completed",
  "failed",
  "stopped",
  "redirected",
  "interrupted",
];

/** Message kinds in the order the copy tree lists them; anything else trails. */
export const ROUTE_SIGNATURE_ORDER = ["coding", "writing", "reasoning", "simple", "general"] as const;

/**
 * What the overlay is currently narrowing the list by. Empty facets are no constraint;
 * the two flags are off until turned on. AND across facets.
 */
export type RouteLogFilter = {
  query: string;
  outcomes: readonly RouteOutcomeKind[];
  botIds: readonly string[];
  models: readonly string[];
  signatures: readonly string[];
  /** Endpoint display names; only used when the overlay already shows endpoints. */
  providers: readonly string[];
  hasFeedback: boolean;
  blamedModel: boolean;
};

export type RouteLogFacetOption<T extends string = string> = {
  value: T;
  label: string;
  count: number;
};

export type RouteLogFacets = {
  outcomes: RouteLogFacetOption<RouteOutcomeKind>[];
  bots: RouteLogFacetOption[];
  models: RouteLogFacetOption[];
  signatures: RouteLogFacetOption[];
  providers: RouteLogFacetOption[];
};

export function emptyRouteLogFilter(): RouteLogFilter {
  return {
    query: "",
    outcomes: [],
    botIds: [],
    models: [],
    signatures: [],
    providers: [],
    hasFeedback: false,
    blamedModel: false,
  };
}

/** True once any facet is actually constraining the list. */
export function routeLogFilterActive(filter: RouteLogFilter): boolean {
  return (
    filter.query.trim().length > 0 ||
    filter.outcomes.length > 0 ||
    filter.botIds.length > 0 ||
    filter.models.length > 0 ||
    filter.signatures.length > 0 ||
    filter.providers.length > 0 ||
    filter.hasFeedback ||
    filter.blamedModel
  );
}

/**
 * Unique values that appear in this session's log, with how often. Counts come from the
 * unfiltered list so a second facet still shows the whole session, not the leftover of the first.
 */
export function routeLogFacets(rows: readonly RouteLogRow[]): RouteLogFacets {
  const outcomes = countBy(
    rows,
    (row) => row.outcome,
    (row) => row.outcomeLabel,
  );
  const bots = countBy(
    rows,
    (row) => row.botId,
    (row) => row.botName,
  );
  const models = countBy(
    rows,
    (row) => row.model,
    (row) => row.model,
  );
  const signatures = countBy(
    rows,
    (row) => row.signature,
    (row) => row.signatureLabel,
  );
  const providers = countBy(
    rows.filter((row) => row.providerName),
    (row) => row.providerName ?? "",
    (row) => row.providerName ?? "",
  );
  return {
    outcomes: sortByOrder(outcomes, ROUTE_OUTCOME_ORDER),
    bots: sortByLabel(bots),
    models: sortByLabel(models),
    signatures: sortByOrder(signatures, ROUTE_SIGNATURE_ORDER),
    providers: sortByLabel(providers),
  };
}

export function filterRouteLogRows(
  rows: readonly RouteLogRow[],
  filter: RouteLogFilter,
): RouteLogRow[] {
  if (!routeLogFilterActive(filter)) return [...rows];
  const query = filter.query.trim().toLowerCase();
  const outcomes = new Set(filter.outcomes);
  const botIds = new Set(filter.botIds);
  const models = new Set(filter.models);
  const signatures = new Set(filter.signatures);
  const providers = new Set(filter.providers);
  return rows.filter((row) => {
    if (outcomes.size > 0 && !outcomes.has(row.outcome)) return false;
    if (botIds.size > 0 && !botIds.has(row.botId)) return false;
    if (models.size > 0 && !models.has(row.model)) return false;
    if (signatures.size > 0 && !signatures.has(row.signature)) return false;
    if (providers.size > 0 && (row.providerName === null || !providers.has(row.providerName))) {
      return false;
    }
    if (filter.hasFeedback && row.feedback.length === 0) return false;
    if (filter.blamedModel && !row.review?.blamedModel) return false;
    if (query.length > 0 && !rowHaystack(row).includes(query)) return false;
    return true;
  });
}

export function toggleFilterValue<T extends string>(held: readonly T[], value: T): T[] {
  return held.includes(value) ? held.filter((item) => item !== value) : [...held, value];
}

/**
 * What the facet trigger reads: the facet name alone, `结果: 补全失败` for one pick, or
 * `结果 · 2` once several are on.
 */
export function facetTriggerLabel(
  selected: readonly string[],
  options: readonly RouteLogFacetOption[],
  fallback: string,
): string {
  if (selected.length === 0) return fallback;
  if (selected.length === 1) {
    const picked = selected[0]!;
    const label = options.find((option) => option.value === picked)?.label ?? picked;
    return `${fallback}: ${label}`;
  }
  return `${fallback} · ${selected.length}`;
}

export function feedbackRowCount(rows: readonly RouteLogRow[]): number {
  return rows.reduce((n, row) => n + (row.feedback.length > 0 ? 1 : 0), 0);
}

export function blamedRowCount(rows: readonly RouteLogRow[]): number {
  return rows.reduce((n, row) => n + (row.review?.blamedModel ? 1 : 0), 0);
}

function rowHaystack(row: RouteLogRow): string {
  const parts = [
    row.botName,
    row.model,
    row.providerName,
    row.thinkingLevel,
    row.thinkingLabel,
    row.signature,
    row.signatureLabel,
    row.outcome,
    row.outcomeLabel,
    row.failReason,
    row.reason,
    row.review?.faultLabel,
    row.review?.directionLabel,
    row.review?.reason,
    ...row.feedback.map((note) => note.body),
  ];
  return parts
    .filter((part): part is string => Boolean(part))
    .join("\n")
    .toLowerCase();
}

function countBy<T extends string>(
  rows: readonly RouteLogRow[],
  valueOf: (row: RouteLogRow) => T,
  labelOf: (row: RouteLogRow) => string,
): RouteLogFacetOption<T>[] {
  const byValue = new Map<T, RouteLogFacetOption<T>>();
  for (const row of rows) {
    const value = valueOf(row);
    const held = byValue.get(value);
    if (held) held.count += 1;
    else byValue.set(value, { value, label: labelOf(row), count: 1 });
  }
  return [...byValue.values()];
}

function sortByOrder<T extends string>(
  options: RouteLogFacetOption<T>[],
  order: readonly string[],
): RouteLogFacetOption<T>[] {
  const rank = new Map(order.map((value, index) => [value, index]));
  return options.slice().sort((a, b) => {
    const aRank = rank.get(a.value) ?? order.length;
    const bRank = rank.get(b.value) ?? order.length;
    if (aRank !== bRank) return aRank - bRank;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

function sortByLabel(options: RouteLogFacetOption[]): RouteLogFacetOption[] {
  return options
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}
