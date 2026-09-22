import { matchesFilter, parseNotificationCursor } from "./parse.ts";
import type {
  NotificationFilter,
  NotificationItem,
  NotificationListPage,
  NotificationSummary,
} from "./types.ts";
import { EMPTY_NOTIFICATION_SUMMARY } from "./types.ts";

export type InboxReplayEvent =
  | { seq: number; event: "notification.upsert"; item: NotificationItem }
  | { seq: number; event: "notification.removed"; id: string }
  | { seq: number; event: "notification.summary"; summary: NotificationSummary };

export type InboxLoad = {
  filter: NotificationFilter;
  generation: number;
  instanceId: string;
  watermark: number;
  upperOrdinal: number;
  page: NotificationListPage;
  live?: { event_instance_id: string; watermark_seq: number } | null;
  replay?: readonly InboxReplayEvent[];
  replayComplete?: boolean;
};

function replayInboxEvents(state: InboxState, load: InboxLoad): InboxState {
  let next = state;
  const replay = load.replay ?? [];
  for (const event of replay) {
    if (event.seq <= load.watermark) continue;
    if (event.event === "notification.upsert") next = upsertInboxItem(next, event.item);
    else if (event.event === "notification.removed") next = removeInboxItem(next, event.id);
    else next = applySummary(next, event.summary);
  }
  const live = load.live;
  const complete = load.replayComplete !== false;
  const watermark =
    complete && live && live.event_instance_id === load.instanceId
      ? Math.max(load.watermark, live.watermark_seq, next.watermark)
      : Math.max(load.watermark, next.watermark);
  return { ...next, watermark };
}

export type InboxState = {
  filter: NotificationFilter;
  generation: number;
  instanceId: string | null;
  watermark: number;
  upperOrdinal: number;
  items: NotificationItem[];
  next: string | null;
  summary: NotificationSummary;
  loading: boolean;
  loadingMore: boolean;
  error: "offline" | "unavailable" | "stale" | null;
  retentionNotice: boolean;
};

export function emptyInbox(filter: NotificationFilter = "actionable"): InboxState {
  return {
    filter,
    generation: 0,
    instanceId: null,
    watermark: 0,
    upperOrdinal: 0,
    items: [],
    next: null,
    summary: EMPTY_NOTIFICATION_SUMMARY,
    loading: false,
    loadingMore: false,
    error: null,
    retentionNotice: false,
  };
}

export function beginInboxLoad(state: InboxState, filter: NotificationFilter): InboxState {
  const generation = state.generation + 1;
  const sameFilter = state.filter === filter;
  return {
    ...emptyInbox(filter),
    generation,
    loading: true,
    summary: state.summary,
    items: sameFilter ? state.items : [],
    instanceId: sameFilter ? state.instanceId : null,
    watermark: sameFilter ? state.watermark : 0,
    upperOrdinal: sameFilter ? state.upperOrdinal : 0,
    next: sameFilter ? state.next : null,
  };
}

export function acceptFirstPage(state: InboxState, load: InboxLoad): InboxState {
  if (load.generation !== state.generation || load.filter !== state.filter) return state;
  const live = load.live;
  const liveAhead = Boolean(live && live.event_instance_id === load.instanceId && live.watermark_seq > load.watermark);
  return replayInboxEvents({
    ...state,
    instanceId: load.instanceId,
    watermark: load.watermark,
    upperOrdinal: load.upperOrdinal,
    items: load.page.items.filter((item) => matchesFilter(item, state.filter)),
    next: load.page.next,
    summary: liveAhead ? state.summary : load.page.summary,
    loading: false,
    error: null,
  }, load);
}

export function rejectInboxLoad(
  state: InboxState,
  generation: number,
  error: InboxState["error"],
): InboxState {
  if (generation !== state.generation) return state;
  return { ...state, loading: false, loadingMore: false, error, items: [], next: null };
}

export function beginMore(state: InboxState): InboxState {
  if (!state.next || state.loadingMore || state.loading) return state;
  return { ...state, loadingMore: true };
}

export function acceptMore(state: InboxState, load: InboxLoad): InboxState {
  if (load.generation !== state.generation || load.filter !== state.filter) return state;
  if (load.instanceId !== state.instanceId) return { ...state, loadingMore: false, error: "stale" };
  if (load.upperOrdinal !== state.upperOrdinal) return { ...state, loadingMore: false, error: "stale" };
  if (state.next && !parseNotificationCursor(state.next, state.filter, state.upperOrdinal) && state.next.length > 256) {
    return { ...state, loadingMore: false, error: "stale" };
  }
  const seen = new Set(state.items.map((item) => item.id));
  const added = load.page.items.filter((item) => !seen.has(item.id) && matchesFilter(item, state.filter));
  const applied = {
    ...state,
    items: [...state.items, ...added],
    next: load.page.next,
    loadingMore: false,
    error: null,
  };
  const live = load.live;
  if (live && live.event_instance_id === load.instanceId && live.watermark_seq > load.watermark) {
    return replayInboxEvents({ ...applied, summary: state.summary }, load);
  }
  return replayInboxEvents({ ...applied, summary: load.page.summary }, load);
}

export function upsertInboxItem(state: InboxState, item: NotificationItem): InboxState {
  const without = state.items.filter((row) => row.id !== item.id);
  if (!matchesFilter(item, state.filter)) return { ...state, items: without };
  const items = [...without, item].sort((a, b) => b.ordinal - a.ordinal || b.id.localeCompare(a.id));
  return { ...state, items };
}

export function removeInboxItem(state: InboxState, id: string): InboxState {
  return { ...state, items: state.items.filter((row) => row.id !== id) };
}

export function applySummary(state: InboxState, summary: NotificationSummary): InboxState {
  return { ...state, summary };
}

export function markLocalRead(state: InboxState, ids: readonly string[], readAt: string): InboxState {
  const set = new Set(ids);
  const items = state.items.map((item) => (set.has(item.id) && !item.read_at ? { ...item, read_at: readAt } : item));
  const filtered = items.filter((item) => matchesFilter(item, state.filter));
  return { ...state, items: filtered };
}

export function disconnectInbox(state: InboxState): InboxState {
  return { ...state, items: [], next: null, loading: false, loadingMore: false, error: "offline" };
}

export function shouldGroupWorkResults(item: NotificationItem): boolean {
  return item.kind === "reply" || item.kind === "routine_result" || item.kind === "failure" || item.kind === "interrupted";
}

export type InboxSection = { id: "needs-you" | "work"; items: NotificationItem[] };

export function sectionInbox(items: readonly NotificationItem[]): InboxSection[] {
  const needs = items.filter((item) => item.action_state === "open" && (item.kind === "approval" || item.kind === "ask"));
  const work = items.filter((item) => !(item.action_state === "open" && (item.kind === "approval" || item.kind === "ask")));
  const sections: InboxSection[] = [];
  if (needs.length) sections.push({ id: "needs-you", items: needs });
  if (work.length) sections.push({ id: "work", items: work });
  return sections;
}
