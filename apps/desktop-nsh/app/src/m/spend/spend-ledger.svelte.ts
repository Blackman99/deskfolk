// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: 73b1c70a0895f0a2
import { derived, effect, state } from "../../lib/reactive";
import { untrack } from "../../lib/reactive";
import type { SpendDetail, SpendGroup, SpendLine, SpendSummary } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";
import type { SpendCopy } from "./spend-copy.ts";
import {
  DEFAULT_SPEND_VIEW,
  SPEND_PAGE_SIZE,
  SPEND_RELOAD_DEBOUNCE_MS,
  calendarDate,
  dayQueryOf,
  kindsOfCategory,
  loadSpendView,
  saveSpendView,
  spendFilterOf,
  spendWindow,
  summaryQueryOf,
  type SpendDimension,
  type SpendDrill,
  type SpendRangeIssue,
  type SpendRangePreset,
  type SpendViewState,
  type SpendWindow,
} from "./spend-query.ts";

/** What the ledger reads from the view's props. Each is read where it was read before, so effects track the same signals. */
export interface SpendLedgerInput {
  api: () => MessengerApi | null;
  revision: () => number;
  timeZone: () => string;
  storage: () => Pick<Storage, "getItem" | "setItem"> | null;
  now: () => () => Date;
  copy: () => SpendCopy;
}

export type SpendChip = { key: string; label: string; clear: () => void };

/** The spend view's load/reload state machine, filters and drill-down. */
export class SpendLedger {
  readonly #input: SpendLedgerInput;

  #view$s = state<SpendViewState>(DEFAULT_SPEND_VIEW);
	get view(): SpendViewState { return this.#view$s.get(); }
	set view(value: SpendViewState) { this.#view$s.set(value); }
  #ready$s = state(false);
	get ready() { return this.#ready$s.get(); }
	set ready(value) { this.#ready$s.set(value); }
  #drill$s = state<SpendDrill>({});
	get drill(): SpendDrill { return this.#drill$s.get(); }
	set drill(value: SpendDrill) { this.#drill$s.set(value); }
  #expanded$s = state<Record<string, boolean>>({});
	get expanded(): Record<string, boolean> { return this.#expanded$s.get(); }
	set expanded(value: Record<string, boolean>) { this.#expanded$s.set(value); }
  /**
   * Every line a summary from this daemon has listed. A category chip asks for a purpose only once
   * one has (`kindsOfCategory`), and still does after a kind drill narrows the summary on screen.
   */
  listedLines = new Set<SpendLine>();
  listedBy: MessengerApi | null = null;

  #summary$s = state<SpendSummary | null>(null);
	get summary(): SpendSummary | null { return this.#summary$s.get(); }
	set summary(value: SpendSummary | null) { this.#summary$s.set(value); }
  #days$s = state<SpendGroup[]>([]);
	get days(): SpendGroup[] { return this.#days$s.get(); }
	set days(value: SpendGroup[]) { this.#days$s.set(value); }
  #details$s = state<SpendDetail[]>([]);
	get details(): SpendDetail[] { return this.#details$s.get(); }
	set details(value: SpendDetail[]) { this.#details$s.set(value); }
  #nextCursor$s = state<string | null>(null);
	get nextCursor(): string | null { return this.#nextCursor$s.get(); }
	set nextCursor(value: string | null) { this.#nextCursor$s.set(value); }
  #loading$s = state(false);
	get loading() { return this.#loading$s.get(); }
	set loading(value) { this.#loading$s.set(value); }
  #loadingMore$s = state(false);
	get loadingMore() { return this.#loadingMore$s.get(); }
	set loadingMore(value) { this.#loadingMore$s.set(value); }
  #failed$s = state(false);
	get failed() { return this.#failed$s.get(); }
	set failed(value) { this.#failed$s.set(value); }
  requestSeq = 0;
  /** The reload that owns the page on screen. A later load-more from an older generation is dropped. */
  pageOwner = 0;
  /** Dimension the rows currently on screen were grouped by. */
  #shownDimension$s = state<SpendDimension>(DEFAULT_SPEND_VIEW.dimension);
	get shownDimension(): SpendDimension { return this.#shownDimension$s.get(); }
	set shownDimension(value: SpendDimension) { this.#shownDimension$s.set(value); }
  #groupsActionable$s = state(false);
	get groupsActionable() { return this.#groupsActionable$s.get(); }
	set groupsActionable(value) { this.#groupsActionable$s.set(value); }
  disposed = false;
  /** Bumped at each local midnight so a long-lived "today" is not yesterday's window. */
  #clock$s = state(0);
	get clock() { return this.#clock$s.get(); }
	set clock(value) { this.#clock$s.set(value); }

  #rangeResult$s = derived(() => {
    void this.clock;
    return spendWindow(this.view, this.#input.now()(), this.#input.timeZone());
  });
	get rangeResult() { return this.#rangeResult$s.get(); }
  #windowFrom$s = derived(() => (this.rangeResult.ok ? this.rangeResult.window.from : undefined));
	get windowFrom() { return this.#windowFrom$s.get(); }
  #windowTo$s = derived(() => (this.rangeResult.ok ? this.rangeResult.window.to : undefined));
	get windowTo() { return this.#windowTo$s.get(); }
  #rangeIssue$s = derived<SpendRangeIssue | null>(() => (this.rangeResult.ok ? null : this.rangeResult.issue));
	get rangeIssue(): SpendRangeIssue | null { return this.#rangeIssue$s.get(); }
  #askedWindow$s = derived<SpendWindow>(() => ({ from: this.windowFrom, to: this.windowTo }));
	get askedWindow(): SpendWindow { return this.#askedWindow$s.get(); }

  #chips$s = derived(() => {
    const out: SpendChip[] = [];
    if ("modelId" in this.drill) {
      const label = this.drill.modelLabel ?? (this.drill.model == null ? this.#input.copy().unrecordedModel : this.drill.model);
      out.push({ key: "model", label, clear: () => this.clearModel() });
    }
    if (this.drill.sessionId) {
      out.push({ key: "session", label: this.drill.sessionLabel ?? this.drill.sessionId, clear: () => this.clearSession() });
    }
    if ("botId" in this.drill) {
      const label = this.drill.botLabel ?? (this.drill.botId == null ? this.#input.copy().unassignedBot : this.drill.botId);
      out.push({ key: "bot", label, clear: () => this.clearBot() });
    }
    if (this.drill.kind && this.drill.kind.length > 0) {
      const label = this.drill.kind.map((kind) => this.#input.copy().kind[kind]).join(" · ");
      out.push({ key: "kind", label, clear: () => this.clearKind() });
    }
    return out;
  });
	get chips() { return this.#chips$s.get(); }

  constructor(input: SpendLedgerInput) {
    this.#input = input;

    effect(() => {
      const target = this.#input.storage();
      untrack(() => {
        this.view = loadSpendView(target);
        this.ready = true;
      });
    });

    effect(() => {
      if (!this.ready) return;
      const serialized = JSON.stringify(this.view);
      const target = this.#input.storage();
      untrack(() => saveSpendView(target, JSON.parse(serialized)));
    });

    effect(() => {
      return () => {
        this.disposed = true;
        this.invalidate();
      };
    });

    effect(() => {
      if (!this.ready) return;
      const zone = this.#input.timeZone();
      const getNow = this.#input.now();
      let day = calendarDate(getNow(), zone);
      const handle = setInterval(() => {
        const next = calendarDate(getNow(), zone);
        if (next !== day) {
          day = next;
          this.clock += 1;
        }
      }, 1_000);
      return () => clearInterval(handle);
    });

    effect(() => {
      if (!this.ready) return;
      const result = this.rangeResult;
      const askedDimension = this.view.dimension;
      void this.#input.api();
      void this.#input.revision();
      void this.#input.timeZone();
      void this.drill.modelId;
      void this.drill.model;
      void this.drill.providerId;
      void this.drill.sessionId;
      void this.drill.botId;
      void this.drill.kind?.join(",");
      return untrack(() => {
        this.invalidate();
        this.dropPage();
        this.groupsActionable = false;
        this.failed = false;
        if (!result.ok) {
          this.loading = false;
          return;
        }
        this.loading = true;
        const handle = setTimeout(() => this.reload(result.window), SPEND_RELOAD_DEBOUNCE_MS);
        return () => clearTimeout(handle);
      });
    });
  }

  invalidate(): number {
    return ++this.requestSeq;
  }

  /** The page on screen belonged to the generation that just ended. More must not offer it. */
  dropPage(): void {
    this.nextCursor = null;
    this.loadingMore = false;
    this.pageOwner = 0;
  }

  reload(asked: SpendWindow): void {
    const token = this.requestSeq;
    const current = this.#input.api();
    const askedDimension = this.view.dimension;
    if (!current || this.disposed) {
      if (token !== this.requestSeq) return;
      this.summary = null;
      this.days = [];
      this.details = [];
      this.dropPage();
      this.groupsActionable = false;
      this.failed = false;
      this.loading = false;
      return;
    }
    this.loading = true;
    this.failed = false;
    const filter = spendFilterOf(asked, this.drill);
    void Promise.all([
      current.spendSummary(summaryQueryOf(asked, this.drill, askedDimension, this.#input.timeZone())),
      current.spendSummary(dayQueryOf(asked, this.drill, this.#input.timeZone())),
      current.spendPage({ ...filter, limit: SPEND_PAGE_SIZE }),
    ])
      .then(([sum, trend, page]) => {
        if (token !== this.requestSeq || this.disposed) return;
        if (current !== this.listedBy) {
          this.listedBy = current;
          this.listedLines = new Set();
        }
        for (const row of sum.categories) for (const line of row.kinds) this.listedLines.add(line.kind);
        this.summary = sum;
        this.days = trend.groups;
        this.details = page.items;
        this.nextCursor = page.next;
        this.pageOwner = token;
        this.shownDimension = askedDimension;
        this.groupsActionable = true;
        this.loading = false;
      })
      .catch(() => {
        if (token !== this.requestSeq || this.disposed) return;
        this.failed = true;
        this.loading = false;
      });
  }

  refresh(): void {
    if (this.loading || !this.rangeResult.ok || !this.#input.api()) return;
    this.invalidate();
    this.dropPage();
    this.reload(this.rangeResult.window);
  }

  setRange(range: SpendRangePreset): void {
    this.view.range = range;
    if (range === "custom" && !this.view.customFrom) {
      const today = calendarDate(this.#input.now()(), this.#input.timeZone());
      this.view.customFrom = today;
      this.view.customTo = today;
    }
  }

  groupLabel(group: SpendGroup, dimension: SpendDimension = this.shownDimension): string {
    const copy = this.#input.copy();
    if (dimension === "model") {
      if (group.model == null && group.id == null) return copy.unrecordedModel;
      const provider = group.provider_name ?? group.provider_id;
      return provider ? `${provider} · ${group.model ?? copy.dash}` : (group.model ?? group.name ?? copy.dash);
    }
    if (dimension === "bot" && group.id == null) return copy.unassignedBot;
    return group.name ?? group.id ?? copy.dash;
  }

  clearModel(): void {
    const { modelId: _m, model: _n, providerId: _p, ...rest } = this.drill;
    void _m;
    void _n;
    void _p;
    this.drill = rest;
  }

  clearSession(): void {
    const { sessionId: _s, ...rest } = this.drill;
    void _s;
    this.drill = rest;
  }

  clearBot(): void {
    const { botId: _b, ...rest } = this.drill;
    void _b;
    this.drill = rest;
  }

  clearKind(): void {
    const { kind: _k, ...rest } = this.drill;
    void _k;
    this.drill = rest;
  }

  drillGroup(group: SpendGroup): void {
    if (!this.groupsActionable || this.loading || this.view.dimension !== this.shownDimension) return;
    const label = this.groupLabel(group, this.shownDimension);
    if (this.view.dimension === "model") {
      this.drill = { ...this.drill, modelId: group.id, model: group.model, providerId: group.provider_id, modelLabel: label };
      return;
    }
    if (this.view.dimension === "session" && group.id) {
      this.drill = { ...this.drill, sessionId: group.id, sessionLabel: label };
      return;
    }
    if (this.view.dimension === "bot") this.drill = { ...this.drill, botId: group.id, botLabel: label };
  }

  drillCategory(category: SpendGroup["categories"][number]["category"]): void {
    this.drill = { ...this.drill, kind: kindsOfCategory(category, this.listedLines) };
  }

  drillKind(kind: SpendLine): void {
    this.drill = { ...this.drill, kind: [kind] };
  }

  toggleCategory(category: string): void {
    this.expanded = { ...this.expanded, [category]: !this.expanded[category] };
  }

  async loadMore(): Promise<void> {
    const current = this.#input.api();
    const cursor = this.nextCursor;
    const token = this.requestSeq;
    const owner = this.pageOwner;
    const filter = { ...spendFilterOf(this.askedWindow, this.drill), limit: SPEND_PAGE_SIZE, cursor: cursor ?? undefined };
    if (!current || !cursor || token !== owner || this.loadingMore || this.disposed) return;
    this.loadingMore = true;
    try {
      const page = await current.spendPage(filter);
      if (token !== this.requestSeq || token !== this.pageOwner || this.disposed) return;
      this.details = [...this.details, ...page.items];
      this.nextCursor = page.next;
    } catch {
      if (token !== this.requestSeq || token !== this.pageOwner || this.disposed) return;
      this.failed = true;
    } finally {
      if (token === this.requestSeq && token === this.pageOwner && !this.disposed) this.loadingMore = false;
    }
  }
}
