<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SPEND_CATEGORY_OF } from '@real-bot/protocol';
	import SpendTrend from './SpendTrend.svelte';
	import type { SpendDetail, SpendGroup, SpendKind, SpendSummary, SpendTotals } from '@real-bot/protocol';
	import type { MessengerApi } from '../messenger-api.ts';
	import { formatTokens, formatUsd } from '../spend-format.ts';
	import { spendCopyFor, type SpendCopy } from './spend-copy.ts';
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
		type SpendSortColumn,
		type SpendViewState,
		type SpendWindow
	} from './spend-query.ts';

	/** The spend ledger fills its host. Width comes from the container, not the window. */
	interface Props {
		api: MessengerApi | null;
		/** Bumped when a `spend.created` or `spend.repriced` arrives. The ledger itself is not kept on the client. */
		revision?: number;
		locale?: 'zh' | 'en';
		/** The machine's zone. Day buckets and "today" are cut here. */
		timeZone?: string;
		/** Where the view remembers its range and dimension. Tests pass their own. */
		storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
		/** Clock for "today" and the custom-range default. Tests pin a day with this. */
		now?: () => Date;
		/** Open the conversation this row belongs to. */
		onOpenSession?: (sessionId: string) => void;
		/** Open the message that woke a turn. */
		onOpenTrigger?: (sessionId: string, messageId: string) => void;
		/** The narrow page's way out. A desktop pane leaves this unset and has no back button. */
		onClose?: () => void;
		backLabel?: string;
	}

	let {
		api,
		revision = 0,
		locale = 'zh',
		timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
		storage = typeof localStorage === 'undefined' ? null : localStorage,
		now = () => new Date(),
		onOpenSession,
		onOpenTrigger,
		onClose,
		backLabel = ''
	}: Props = $props();

	const copy: SpendCopy = $derived(spendCopyFor(locale));
	const categoryOf = SPEND_CATEGORY_OF;
	let section = $state<'overview' | 'details'>('overview');
	let scrollArea: HTMLDivElement | undefined = $state();
	const scrollPositions = { overview: 0, details: 0 };

	function switchSection(next: 'overview' | 'details'): void {
		if (next === section) return;
		if (scrollArea) scrollPositions[section] = scrollArea.scrollTop;
		const top = scrollPositions[next];
		section = next;
		void tick().then(() => { if (scrollArea) scrollArea.scrollTop = top; });
	}

	function sectionKey(event: KeyboardEvent, current: 'overview' | 'details'): void {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'details' : current === 'overview' ? 'details' : 'overview';
		switchSection(next);
		const tabs = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
		tabs?.[next === 'overview' ? 0 : 1]?.focus();
	}
	let view = $state<SpendViewState>(DEFAULT_SPEND_VIEW);
	let ready = $state(false);
	let drill = $state<SpendDrill>({});
	let expanded = $state<Record<string, boolean>>({});

	let summary = $state<SpendSummary | null>(null);
	let days = $state<SpendGroup[]>([]);
	let details = $state<SpendDetail[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(false);
	let loadingMore = $state(false);
	let failed = $state(false);
	let requestSeq = 0;
	/** The reload that owns the page on screen. A later load-more from an older generation is dropped. */
	let pageOwner = 0;
	/** Dimension the rows currently on screen were grouped by. */
	let shownDimension = $state<SpendDimension>(DEFAULT_SPEND_VIEW.dimension);
	let groupsActionable = $state(false);
	let disposed = false;
	/** Bumped at each local midnight so a long-lived "today" is not yesterday's window. */
	let clock = $state(0);

	const ranges: SpendRangePreset[] = ['today', 'last7', 'last30', 'all', 'custom'];
	const dimensions: SpendDimension[] = ['model', 'session', 'bot'];

	$effect(() => {
		const target = storage;
		untrack(() => {
			view = loadSpendView(target);
			ready = true;
		});
	});

	$effect(() => {
		if (!ready) return;
		const serialized = JSON.stringify(view);
		const target = storage;
		untrack(() => saveSpendView(target, JSON.parse(serialized)));
	});

	const rangeResult = $derived.by(() => {
		void clock;
		return spendWindow(view, now(), timeZone);
	});
	const windowFrom = $derived(rangeResult.ok ? rangeResult.window.from : undefined);
	const windowTo = $derived(rangeResult.ok ? rangeResult.window.to : undefined);
	const rangeIssue: SpendRangeIssue | null = $derived(rangeResult.ok ? null : rangeResult.issue);
	const askedWindow = $derived<SpendWindow>({ from: windowFrom, to: windowTo });

	function invalidate(): number {
		return ++requestSeq;
	}

	/** The page on screen belonged to the generation that just ended. More must not offer it. */
	function dropPage(): void {
		nextCursor = null;
		loadingMore = false;
		pageOwner = 0;
	}

	function reload(asked: SpendWindow): void {
		const token = requestSeq;
		const current = api;
		const askedDimension = view.dimension;
		if (!current || disposed) {
			if (token !== requestSeq) return;
			summary = null;
			days = [];
			details = [];
			dropPage();
			groupsActionable = false;
			failed = false;
			loading = false;
			return;
		}
		loading = true;
		failed = false;
		const filter = spendFilterOf(asked, drill);
		void Promise.all([
			current.spendSummary(summaryQueryOf(asked, drill, askedDimension, timeZone)),
			current.spendSummary(dayQueryOf(asked, drill, timeZone)),
			current.spendPage({ ...filter, limit: SPEND_PAGE_SIZE })
		])
			.then(([sum, trend, page]) => {
				if (token !== requestSeq || disposed) return;
				summary = sum;
				days = trend.groups;
				details = page.items;
				nextCursor = page.next;
				pageOwner = token;
				shownDimension = askedDimension;
				groupsActionable = true;
				loading = false;
			})
			.catch(() => {
				if (token !== requestSeq || disposed) return;
				failed = true;
				loading = false;
			});
	}

	$effect(() => {
		return () => {
			disposed = true;
			invalidate();
		};
	});

	$effect(() => {
		if (!ready) return;
		const zone = timeZone;
		const getNow = now;
		let day = calendarDate(getNow(), zone);
		const handle = setInterval(() => {
			const next = calendarDate(getNow(), zone);
			if (next !== day) {
				day = next;
				clock += 1;
			}
		}, 1_000);
		return () => clearInterval(handle);
	});

	$effect(() => {
		if (!ready) return;
		const result = rangeResult;
		const askedDimension = view.dimension;
		void api;
		void revision;
		void timeZone;
		void drill.modelId;
		void drill.model;
		void drill.providerId;
		void drill.sessionId;
		void drill.botId;
		void drill.kind?.join(',');
		return untrack(() => {
			invalidate();
			dropPage();
			groupsActionable = false;
			failed = false;
			if (!result.ok) {
				loading = false;
				return;
			}
			loading = true;
			const handle = setTimeout(() => reload(result.window), SPEND_RELOAD_DEBOUNCE_MS);
			return () => clearTimeout(handle);
		});
	});

	function refresh(): void {
		if (loading || !rangeResult.ok || !api) return;
		invalidate();
		dropPage();
		reload(rangeResult.window);
	}

	function setRange(range: SpendRangePreset): void {
		view.range = range;
		if (range === 'custom' && !view.customFrom) {
			const today = calendarDate(now(), timeZone);
			view.customFrom = today;
			view.customTo = today;
		}
	}

	function rangeMessage(issue: SpendRangeIssue): string {
		if (issue === 'blank') return copy.rangeBlank;
		if (issue === 'reversed') return copy.rangeReversed;
		return copy.rangeInvalid;
	}

	function num(value: number | null): string {
		return value == null ? copy.dash : formatTokens(value);
	}

	function money(ticks: number | null, estimated = false): string {
		if (ticks == null) return copy.dash;
		const text = formatUsd(ticks);
		return estimated ? `${text} ${copy.estimated}` : text;
	}

	function columnValue(group: SpendGroup, column: SpendSortColumn): number | null {
		switch (column) {
			case 'calls':
				return group.calls;
			case 'input':
				return group.input_tokens;
			case 'output':
				return group.output_tokens;
			case 'total':
				return group.total_tokens;
			case 'reported':
				return group.reported_usd_ticks;
			case 'estimated':
				return group.estimated_usd_ticks;
			default:
				return null;
		}
	}

	function groupLabel(group: SpendGroup, dimension: SpendDimension = shownDimension): string {
		if (dimension === 'model') {
			if (group.model == null && group.id == null) return copy.unrecordedModel;
			const provider = group.provider_name ?? group.provider_id;
			return provider ? `${provider} · ${group.model ?? copy.dash}` : (group.model ?? group.name ?? copy.dash);
		}
		if (dimension === 'bot' && group.id == null) return copy.unassignedBot;
		return group.name ?? group.id ?? copy.dash;
	}

	const sortedGroups = $derived.by(() => {
		const rows = [...(summary?.groups ?? [])];
		const dir = view.dir === 'asc' ? 1 : -1;
		rows.sort((a, b) => {
			if (view.sort === 'name') return groupLabel(a).localeCompare(groupLabel(b)) * dir;
			const av = columnValue(a, view.sort);
			const bv = columnValue(b, view.sort);
			if (av == null && bv == null) return 0;
			if (av == null) return 1;
			if (bv == null) return -1;
			return (av - bv) * dir;
		});
		return rows;
	});

	function sortBy(column: SpendSortColumn): void {
		if (view.sort === column) view.dir = view.dir === 'asc' ? 'desc' : 'asc';
		else {
			view.sort = column;
			view.dir = column === 'name' ? 'asc' : 'desc';
		}
	}

	function sortMark(column: SpendSortColumn): string {
		if (view.sort !== column) return '';
		return view.dir === 'asc' ? ' ↑' : ' ↓';
	}

	type Chip = { key: string; label: string; clear: () => void };

	function clearModel(): void {
		const { modelId: _m, model: _n, providerId: _p, ...rest } = drill;
		void _m;
		void _n;
		void _p;
		drill = rest;
	}

	function clearSession(): void {
		const { sessionId: _s, ...rest } = drill;
		void _s;
		drill = rest;
	}

	function clearBot(): void {
		const { botId: _b, ...rest } = drill;
		void _b;
		drill = rest;
	}

	function clearKind(): void {
		const { kind: _k, ...rest } = drill;
		void _k;
		drill = rest;
	}

	const chips = $derived.by(() => {
		const out: Chip[] = [];
		if ('modelId' in drill) {
			const label = drill.modelLabel ?? (drill.model == null ? copy.unrecordedModel : drill.model);
			out.push({ key: 'model', label, clear: clearModel });
		}
		if (drill.sessionId) {
			out.push({ key: 'session', label: drill.sessionLabel ?? drill.sessionId, clear: clearSession });
		}
		if ('botId' in drill) {
			const label = drill.botLabel ?? (drill.botId == null ? copy.unassignedBot : drill.botId);
			out.push({ key: 'bot', label, clear: clearBot });
		}
		if (drill.kind && drill.kind.length > 0) {
			const label = drill.kind.map((kind) => copy.kind[kind]).join(' · ');
			out.push({ key: 'kind', label, clear: clearKind });
		}
		return out;
	});

	function drillGroup(group: SpendGroup): void {
		if (!groupsActionable || loading || view.dimension !== shownDimension) return;
		const label = groupLabel(group, shownDimension);
		if (view.dimension === 'model') {
			drill = { ...drill, modelId: group.id, model: group.model, providerId: group.provider_id, modelLabel: label };
			return;
		}
		if (view.dimension === 'session' && group.id) {
			drill = { ...drill, sessionId: group.id, sessionLabel: label };
			return;
		}
		if (view.dimension === 'bot') drill = { ...drill, botId: group.id, botLabel: label };
	}

	function drillCategory(category: SpendGroup['categories'][number]['category']): void {
		drill = { ...drill, kind: kindsOfCategory(category) };
	}

	function drillKind(kind: SpendKind): void {
		drill = { ...drill, kind: [kind] };
	}

	function toggleCategory(category: string): void {
		expanded = { ...expanded, [category]: !expanded[category] };
	}

	async function loadMore(): Promise<void> {
		const current = api;
		const cursor = nextCursor;
		const token = requestSeq;
		const owner = pageOwner;
		const filter = { ...spendFilterOf(askedWindow, drill), limit: SPEND_PAGE_SIZE, cursor: cursor ?? undefined };
		if (!current || !cursor || token !== owner || loadingMore || disposed) return;
		loadingMore = true;
		try {
			const page = await current.spendPage(filter);
			if (token !== requestSeq || token !== pageOwner || disposed) return;
			details = [...details, ...page.items];
			nextCursor = page.next;
		} catch {
			if (token !== requestSeq || token !== pageOwner || disposed) return;
			failed = true;
		} finally {
			if (token === requestSeq && token === pageOwner && !disposed) loadingMore = false;
		}
	}

	function detailSession(row: SpendDetail): string {
		return row.session_name ?? row.session_id;
	}

	function detailBot(row: SpendDetail): string {
		if (row.bot_id == null) return copy.unassignedBot;
		return row.bot_name ?? row.bot_id;
	}

	function detailModel(row: SpendDetail): string {
		if (row.model == null) return copy.unrecordedModel;
		return row.provider_name ? `${row.provider_name} · ${row.model}` : row.model;
	}

	function detailAmount(row: SpendDetail): string {
		if (row.cost_usd_ticks != null) return formatUsd(row.cost_usd_ticks);
		if (row.estimated_cost_usd_ticks != null) return `${formatUsd(row.estimated_cost_usd_ticks)} ${copy.estimated}`;
		return copy.dash;
	}

	const columns: { key: SpendSortColumn; label: keyof Pick<SpendCopy, 'calls' | 'input' | 'output' | 'totalTokens' | 'reported' | 'estimated'> | 'name' }[] = [
		{ key: 'name', label: 'name' },
		{ key: 'calls', label: 'calls' },
		{ key: 'input', label: 'input' },
		{ key: 'output', label: 'output' },
		{ key: 'total', label: 'totalTokens' },
		{ key: 'reported', label: 'reported' },
		{ key: 'estimated', label: 'estimated' }
	];

	function columnLabel(column: (typeof columns)[number]): string {
		if (column.label === 'name') return copy.dimensions[shownDimension];
		return copy[column.label];
	}

	function amountTitle(row: SpendDetail): string | undefined {
		if (row.estimated_cost_usd_ticks != null && row.cost_usd_ticks == null) return copy.estimatedHint;
		if (row.cost_usd_ticks == null && row.estimated_cost_usd_ticks == null) {
			if (row.input_tokens == null || row.output_tokens == null) return copy.estimateIncompleteUsage;
			return copy.estimateUnconfigured;
		}
		return undefined;
	}

	function tokenMetrics(row: Pick<SpendTotals, 'input_tokens' | 'cached_tokens' | 'output_tokens' | 'reasoning_tokens'>) {
		return [
			{ label: copy.input, value: row.input_tokens },
			{ label: copy.cached, value: row.cached_tokens },
			{ label: copy.output, value: row.output_tokens },
			{ label: copy.reasoning, value: row.reasoning_tokens },
		];
	}

	function categoryWidth(value: number | null): number {
		const maximum = Math.max(0, ...(summary?.categories.map((row) => row.total_tokens ?? 0) ?? []));
		return value != null && maximum > 0 ? (value / maximum) * 100 : 0;
	}

	function dateLabel(value: string): string {
		return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
	}

	function timeLabel(value: string): string {
		return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
	}
</script>

{#snippet icon(name: 'back' | 'refresh' | 'chevron' | 'filter' | 'close' | 'arrow' | 'coins' | 'spark' | 'calendar' | 'info')}
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		{#if name === 'back'}<path d="m14 6-6 6 6 6" />
		{:else if name === 'refresh'}<path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
		{:else if name === 'chevron'}<path d="m8 10 4 4 4-4" />
		{:else if name === 'filter'}<path d="M4 6h16M7 12h10M10 18h4" />
		{:else if name === 'close'}<path d="m7 7 10 10M7 17 17-10" />
		{:else if name === 'coins'}<circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18" /><path d="m7 6 2 4" />
		{:else if name === 'spark'}<path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3Z" />
		{:else if name === 'calendar'}<rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
		{:else if name === 'info'}<circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
		{:else}<path d="M5 12h14m-5-5 5 5-5 5" />{/if}
	</svg>
{/snippet}

<section class="spend" aria-label={copy.title} data-spend-view>
	<header class="spend-head">
		<div class="spend-toolbar">
			<div class="spend-title-area">
				{#if onClose}
					<button type="button" class="icon-button back" aria-label={backLabel} onclick={onClose}>
						{@render icon('back')}
					</button>
				{/if}
				<div class="heading">
					<h1>{copy.title}</h1>
					<p>{copy.subtitle}</p>
				</div>
			</div>

			<div class="spend-header-actions">
				<label class="period-control">
					<span class="sr">{copy.period}</span>
					<span class="period-icon text-muted" aria-hidden="true">{@render icon('calendar')}</span>
					<select
						aria-label={copy.period}
						value={view.range}
						onchange={(event) => setRange(event.currentTarget.value as SpendRangePreset)}
					>
						{#each ranges as range}
							<option value={range}>{copy.ranges[range]}</option>
						{/each}
					</select>
					<span class="period-chevron text-muted" aria-hidden="true">{@render icon('chevron')}</span>
				</label>

				<button
					type="button"
					class="icon-button refresh"
					class:is-spinning={loading}
					aria-label={copy.refresh}
					title={copy.refresh}
					disabled={loading || !!rangeIssue || !api}
					onclick={refresh}
				>
					{@render icon('refresh')}
				</button>
			</div>
		</div>

		<div class="expandable-controls">
			{#if view.range === 'custom'}
				<div class="custom-dates">
					<div class="custom-date-inputs">
						<label class="date">
							<span class="date-label">{copy.from}</span>
							<input type="date" aria-label={copy.from} aria-invalid={!!rangeIssue} bind:value={view.customFrom} />
						</label>
						<span class="date-sep text-muted" aria-hidden="true">→</span>
						<label class="date">
							<span class="date-label">{copy.to}</span>
							<input type="date" aria-label={copy.to} aria-invalid={!!rangeIssue} bind:value={view.customTo} />
						</label>
					</div>
					{#if rangeIssue}
						<p class="field-error" role="alert">{rangeMessage(rangeIssue)}</p>
					{/if}
				</div>
			{/if}

			{#if chips.length}
				<div class="chips" aria-label={copy.filters}>
					<span class="filter-icon text-muted" aria-hidden="true">{@render icon('filter')}</span>
					{#each chips as chip (chip.key)}
						<button type="button" class="chip" aria-label={copy.clearFilter(chip.label)} onclick={chip.clear}>
							<span class="chip-label">{chip.label}</span>
							<span class="chip-close" aria-hidden="true">{@render icon('close')}</span>
						</button>
					{/each}
					<button type="button" class="text-action clear-all" onclick={() => (drill = {})}>
						{copy.clearAll}
					</button>
				</div>
			{/if}
		</div>

		<div class="spend-navigation">
			<div class="view-tabs" role="tablist" aria-label={copy.title}>
				{#each ['overview', 'details'] as name}
					<button
						type="button"
						role="tab"
						aria-selected={section === name}
						tabindex={section === name ? 0 : -1}
						class="tab-btn"
						class:is-active={section === name}
						onclick={() => switchSection(name as 'overview' | 'details')}
						onkeydown={(event) => sectionKey(event, name as 'overview' | 'details')}
					>
						{name === 'overview' ? copy.overview : copy.details}
					</button>
				{/each}
			</div>
			<span class="update-status" role="status">{loading && summary ? copy.refreshing : ''}</span>
		</div>
	</header>

	<div
		class="spend-scroll"
		bind:this={scrollArea}
		onscroll={() => (scrollPositions[section] = scrollArea?.scrollTop ?? 0)}
		role="tabpanel"
		aria-label={section === 'overview' ? copy.overview : copy.details}
		aria-busy={loading}
	>
		{#if failed}
			<div class="status-box" role="alert">
				<div class="status-icon-wrap is-error">
					{@render icon('info')}
				</div>
				<strong>{copy.error}</strong>
				<button type="button" class="quiet" onclick={refresh} disabled={loading || !!rangeIssue}>{copy.retry}</button>
			</div>
		{:else if !summary}
			<div class="loading-state" role="status">
				<span class="loading-mark" aria-hidden="true"></span>
				<span class="loading-label">{copy.loading}</span>
			</div>
		{:else if summary.totals.calls === 0}
			<div class="empty-state">
				<span class="empty-mark" aria-hidden="true">{@render icon('filter')}</span>
				<h2>{copy.empty}</h2>
				<p>{copy.emptyHint}</p>
				{#if chips.length}
					<button type="button" class="quiet" onclick={() => (drill = {})}>{copy.clearAll}</button>
				{/if}
			</div>
		{:else}
			{#if section === 'overview'}
				{@const totals = summary.totals}
				<section class="overview-summary" aria-label={copy.totals}>
					<div class="summary-cards">
						<!-- Total Tokens Hero Card -->
						<div class="summary-card usage-card">
							<div class="card-top">
								<span class="metric-label">
									<i class="metric-dot is-tokens"></i>
									{copy.totalTokens}
								</span>
								<span class="calls-line">{copy.recordedCalls(totals.calls)}</span>
							</div>
							<div class="card-hero-num">
								<strong class="primary-number" title={totals.total_tokens?.toLocaleString(locale)}>
									{num(totals.total_tokens)}
								</strong>
							</div>
							<dl class="token-breakdown figures" aria-label={copy.usageDetails}>
								{#each tokenMetrics(totals) as item}
									<div class="token-metric-pill">
										<dt>{item.label}</dt>
										<dd title={item.value?.toLocaleString(locale)}>{num(item.value)}</dd>
									</div>
								{/each}
							</dl>
						</div>

						<!-- Cost & Amounts Hero Card -->
						<div class="summary-card cost-card">
							<div class="card-top">
								<span class="metric-label">
									<i class="metric-dot is-cost"></i>
									{copy.amount}
								</span>
							</div>
							<div class="money-summary">
								<div class="money-col is-reported">
									<span class="metric-label">
										<i class="amount-dot"></i>
										{copy.reported}
									</span>
									<strong class="amount-number">{money(totals.reported_usd_ticks)}</strong>
									<span class="metric-foot">{copy.coveredCalls(totals.reported_calls)}</span>
								</div>
								<div class="money-col is-estimated">
									<span class="metric-label">
										<i class="amount-dot is-estimated"></i>
										{copy.estimated}
									</span>
									<strong class="amount-number">{money(totals.estimated_usd_ticks)}</strong>
									<span class="metric-foot">{copy.coveredCalls(totals.estimated_calls)}</span>
								</div>
							</div>
						</div>
					</div>

					<details class="coverage">
						<summary>
							<span class="coverage-title">
								<span class="coverage-icon" aria-hidden="true">{@render icon('info')}</span>
								{copy.coverage}
							</span>
							<span class="coverage-summary">
								{totals.missing_usage_calls ? copy.missingUsage(totals.missing_usage_calls) : copy.estimateCoverage(totals.reported_calls, totals.estimated_calls)}
							</span>
							<span class="coverage-chevron" aria-hidden="true">{@render icon('chevron')}</span>
						</summary>
						<div class="coverage-body">
							<p>{copy.estimatedHint}</p>
							<p>{copy.estimateCoverage(totals.reported_calls, totals.estimated_calls)}</p>
							{#if totals.missing_calls}
								<p>{copy.missingAmount(totals.missing_calls)} · {copy.estimateUnknown}</p>
							{/if}
							{#if totals.missing_usage_calls}
								<p>{copy.missingUsage(totals.missing_usage_calls)}</p>
							{/if}
						</div>
					</details>
				</section>

				<div class="analysis-grid">
					<section class="surface trend-surface" aria-label={copy.trend}>
						<div class="section-head">
							<div class="section-head-title">
								<h2>{copy.trend}</h2>
							</div>
							<div class="segmented" role="group" aria-label={copy.trend}>
								<button
									type="button"
									aria-pressed={view.metric === 'tokens'}
									onclick={() => (view.metric = 'tokens')}
								>
									{copy.metricTokens}
								</button>
								<button
									type="button"
									aria-pressed={view.metric === 'money'}
									onclick={() => (view.metric = 'money')}
								>
									{copy.metricMoney}
								</button>
							</div>
						</div>
						<div class="trend-content">
							<SpendTrend {days} metric={view.metric} {locale} range={askedWindow} {timeZone} />
						</div>
					</section>

					<section class="surface category-surface" aria-label={copy.categories}>
						<div class="section-head">
							<div class="section-head-title">
								<h2>{copy.categories}</h2>
							</div>
							<span class="text-muted text-11">{copy.totalTokens}</span>
						</div>
						<ul class="categories">
							{#each summary.categories as category (category.category)}
								<li class="category-item">
									<div class="category-row">
										<button
											type="button"
											class="category-name"
											disabled={loading}
											onclick={() => drillCategory(category.category)}
										>
											<i class="category-dot is-{category.category}"></i>
											<span class="category-title-text">{copy.category[category.category]}</span>
										</button>
										<span class="num category-tokens">{num(category.total_tokens)}</span>
										<span class="category-call">{copy.recordedCalls(category.calls)}</span>
									</div>
									<div class="category-track" aria-hidden="true">
										<span class="is-{category.category}" style:width="{categoryWidth(category.total_tokens)}%"></span>
									</div>
									<div class="category-amounts">
										<span>{copy.reported} <b>{money(category.reported_usd_ticks)}</b></span>
										<span>{copy.estimated} <b>{money(category.estimated_usd_ticks)}</b></span>
										{#if category.kinds.length > 1}
											<button
												type="button"
												class="kind-toggle"
												aria-label={copy.expand}
												aria-expanded={!!expanded[category.category]}
												onclick={() => toggleCategory(category.category)}
											>
												{@render icon('chevron')}
											</button>
										{/if}
									</div>
									{#if expanded[category.category]}
										<ul class="kinds">
											{#each category.kinds as kind (kind.kind)}
												<li class="kind-item">
													<button
														type="button"
														class="text-action kind-name"
														disabled={loading}
														onclick={() => drillKind(kind.kind)}
													>
														{copy.kind[kind.kind]}
													</button>
													<span class="num">{num(kind.total_tokens)}</span>
													<span class="kind-money">{copy.reported} {money(kind.reported_usd_ticks)} · {copy.estimated} {money(kind.estimated_usd_ticks)}</span>
												</li>
											{/each}
										</ul>
									{/if}
								</li>
							{/each}
						</ul>
					</section>
				</div>

				<section class="surface dimension-surface" aria-label={copy.dimension}>
					<div class="section-head distribution-head">
						<div class="section-head-title">
							<h2>{copy.distribution}</h2>
							<p class="section-hint">{copy.breakdownHint}</p>
						</div>
						<div class="segmented dimension-tabs" role="group" aria-label={copy.dimension}>
							{#each dimensions as dimension}
								<button
									type="button"
									aria-pressed={view.dimension === dimension}
									onclick={() => (view.dimension = dimension)}
								>
									{copy.dimensions[dimension]}
								</button>
							{/each}
						</div>
					</div>

					<div class="compact-sort">
						<label>
							<span>{copy.sort}</span>
							<select
								aria-label={copy.sort}
								value={view.sort}
								onchange={(event) => (view.sort = event.currentTarget.value as SpendSortColumn)}
							>
								{#each columns as column}
									<option value={column.key}>{columnLabel(column)}</option>
								{/each}
							</select>
						</label>
						<button
							type="button"
							class="quiet sort-dir-btn"
							aria-label={view.dir === 'asc' ? copy.ascending : copy.descending}
							onclick={() => (view.dir = view.dir === 'asc' ? 'desc' : 'asc')}
						>
							{view.dir === 'asc' ? '↑' : '↓'}
						</button>
					</div>

					<div class="table-container">
						<table class="dimension-table">
							<thead>
								<tr>
									{#each columns as column}
										<th aria-sort={view.sort === column.key ? (view.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
											<button
												type="button"
												class="sort"
												aria-label={copy.sortBy(columnLabel(column))}
												onclick={() => sortBy(column.key)}
											>
												{columnLabel(column)}{sortMark(column.key)}
											</button>
										</th>
									{/each}
									<th><span class="sr">{copy.openSession}</span></th>
								</tr>
							</thead>
							<tbody>
								{#each sortedGroups as group (`${group.id ?? 'null'}-${group.provider_id ?? ''}-${group.model ?? ''}`)}
									<tr class:is-deleted={group.deleted}>
										<td class="group-name-cell">
											<div class="group-name-wrapper">
												<button
													type="button"
													class="group-name"
													disabled={!groupsActionable || loading}
													onclick={() => drillGroup(group)}
												>
													{groupLabel(group)}
												</button>
												{#if group.deleted}
													<span class="deleted">{copy.deleted}</span>
												{/if}
											</div>
										</td>
										<td class="num group-calls" data-label={copy.calls}>{formatTokens(group.calls)}</td>
										<td class="num group-input" data-label={copy.input}>{num(group.input_tokens)}</td>
										<td class="num group-output" data-label={copy.output}>{num(group.output_tokens)}</td>
										<td class="num group-total" data-label={copy.totalTokens}>{num(group.total_tokens)}</td>
										<td class="num group-reported" data-label={copy.reported}>{money(group.reported_usd_ticks)}</td>
										<td class="num group-estimated" data-label={copy.estimated}>{money(group.estimated_usd_ticks)}</td>
										<td class="group-actions">
											{#if groupsActionable && shownDimension === 'session' && group.id && !group.deleted && onOpenSession}
												<button type="button" class="text-action open-session-btn" onclick={() => onOpenSession?.(group.id!)}>
													<span>{copy.openSession}</span>
													{@render icon('arrow')}
												</button>
											{/if}
											<details class="group-more">
												<summary aria-label={copy.inspect}>
													<span>{copy.usageDetails}</span>
													{@render icon('chevron')}
												</summary>
												<dl>
													{#each tokenMetrics(group) as item}
														<div>
															<dt>{item.label}</dt>
															<dd>{num(item.value)}</dd>
														</div>
													{/each}
												</dl>
											</details>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</section>
			{:else}
				<section class="surface detail-surface" aria-label={copy.details}>
					<div class="section-head detail-head">
						<div class="section-head-title">
							<h2>{copy.details}</h2>
							<p class="section-hint">{copy.detailHint}</p>
						</div>
						<span class="loaded-count-badge">{copy.loadedCalls(details.length)}</span>
					</div>

					<div class="table-container">
						<table class="detail-table">
							<thead>
								<tr>
									<th>{copy.time}</th>
									<th>{copy.categories}</th>
									<th>{copy.session} / {copy.bot}</th>
									<th>{copy.model}</th>
									<th>{copy.totalTokens}</th>
									<th>{copy.amount}</th>
									<th><span class="sr">{copy.openTrigger}</span></th>
								</tr>
							</thead>
							<tbody>
								{#each details as row (row.id)}
									<tr class:is-deleted={row.session_deleted || row.bot_deleted}>
										<td class="detail-time">
											<time datetime={row.created_at} title={row.created_at}>
												<span class="detail-date">{dateLabel(row.created_at)}</span>
												<span class="detail-clock text-muted">{timeLabel(row.created_at)}</span>
											</time>
										</td>
										<td class="detail-kind">
											<span class="kind-label is-{categoryOf[row.kind]}">{copy.kind[row.kind]}</span>
										</td>
										<td class="detail-owner">
											<div class="owner-session">
												<span>{detailSession(row)}</span>
												{#if row.session_deleted}
													<span class="deleted">{copy.deleted}</span>
												{/if}
											</div>
											<div class="owner-bot">
												<span>{detailBot(row)}</span>
												{#if row.bot_deleted}
													<span class="deleted">{copy.deleted}</span>
												{/if}
											</div>
										</td>
										<td class="detail-model" data-label={copy.model}>
											<span class="model-badge">{detailModel(row)}</span>
										</td>
										<td class="detail-tokens num" data-label={copy.totalTokens}>{num(row.total_tokens)}</td>
										<td
											class="detail-amount num"
											data-label={row.estimated_cost_usd_ticks != null && row.cost_usd_ticks == null ? copy.estimated : copy.reported}
											title={amountTitle(row)}
										>
											{detailAmount(row)}
										</td>
										<td class="detail-actions">
											{#if row.trigger_message_id && !row.session_deleted && onOpenTrigger}
												<button type="button" class="text-action open-trigger-btn" onclick={() => onOpenTrigger?.(row.session_id, row.trigger_message_id!)}>
													<span>{copy.openTrigger}</span>
													{@render icon('arrow')}
												</button>
											{/if}
											<details class="call-breakdown">
												<summary>
													<span>{copy.usageDetails}</span>
													{@render icon('chevron')}
												</summary>
												<dl>
													{#each tokenMetrics(row) as item}
														<div>
															<dt>{item.label}</dt>
															<dd>{num(item.value)}</dd>
														</div>
													{/each}
												</dl>
											</details>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>

					{#if nextCursor}
						<div class="pagination">
							<button type="button" class="more quiet" disabled={loadingMore || loading} onclick={() => void loadMore()}>{loadingMore ? copy.loadingMore : copy.loadMore}</button>
						</div>
					{/if}
				</section>
			{/if}
		{/if}
	</div>
</section>

<style>
	.spend {
		container: spend / inline-size;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
		background: var(--sidebar-bg);
		color: var(--ink);
		font-family: var(--font);
	}

	.spend-head {
		flex: none;
		padding: 16px 24px 0;
		background: var(--pane);
		border-bottom: 1px solid var(--line);
		z-index: 2;
		position: relative;
		max-height: 58%;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: thin;
	}

	.spend-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		min-width: 0;
	}

	.spend-title-area {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
		flex: 1;
	}

	.spend-header-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: none;
	}

	.heading {
		flex: 1;
		min-width: 0;
	}

	h1, h2, p, dl, dd, dt {
		margin: 0;
	}

	h1 {
		font-size: 19px;
		line-height: 1.3;
		font-weight: 650;
		letter-spacing: -0.025em;
		color: var(--ink);
	}

	.heading p {
		margin-top: 2px;
		color: var(--muted);
		font-size: 12px;
		letter-spacing: -0.01em;
	}

	h2 {
		font-size: 14px;
		line-height: 1.4;
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--ink);
	}

	.icon-button {
		width: 38px;
		height: 38px;
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--muted);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.icon-button:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--ink);
		border-color: var(--line-hover);
	}

	.icon-button.refresh.is-spinning svg {
		animation: spin 0.8s linear infinite;
	}

	.period-control {
		position: relative;
		display: inline-flex;
		align-items: center;
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		transition: border-color 0.15s ease;
	}

	.period-control:hover {
		border-color: var(--line-hover);
	}

	.period-control select {
		appearance: none;
		-webkit-appearance: none;
		padding: 0 32px 0 32px;
		height: 38px;
		border: 0;
		border-radius: inherit;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}

	.period-icon {
		position: absolute;
		left: 10px;
		pointer-events: none;
		display: flex;
		align-items: center;
	}

	.period-chevron {
		position: absolute;
		right: 10px;
		pointer-events: none;
		display: flex;
		align-items: center;
	}

	.expandable-controls {
		min-height: 0;
	}

	.custom-dates {
		margin-top: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.custom-date-inputs {
		display: flex;
		align-items: center;
		gap: 12px;
		max-width: 520px;
	}

	.date {
		min-width: 0;
		flex: 1;
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--muted);
	}

	.date-label {
		flex: none;
		font-weight: 500;
	}

	.date input {
		min-width: 0;
		width: 100%;
		padding: 6px 10px;
		height: 38px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: inherit;
		font-size: 12px;
		transition: border-color 0.15s ease;
	}

	.date input:focus {
		border-color: var(--accent);
		outline: none;
	}

	.date-sep {
		font-size: 13px;
		flex: none;
	}

	.field-error {
		font-size: 12px;
		color: var(--danger);
		font-weight: 500;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 10px 0 4px;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: min(100%, 320px);
		min-height: 32px;
		padding: 4px 10px;
		border: 1px solid var(--accent-border);
		border-radius: 9999px;
		background: var(--accent-tint);
		color: var(--accent);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.chip:hover {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
	}

	.chip-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chip-close {
		display: flex;
		align-items: center;
		opacity: 0.8;
	}

	.text-action {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		border: 0;
		background: transparent;
		padding: 0 4px;
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		color: var(--accent);
		cursor: pointer;
		text-align: left;
		transition: opacity 0.15s ease;
	}

	.text-action:hover:not(:disabled) {
		opacity: 0.8;
		text-decoration: underline;
	}

	.clear-all {
		color: var(--muted);
	}

	.clear-all:hover {
		color: var(--ink);
	}

	.spend-navigation {
		margin-top: 14px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		border-top: 1px solid var(--line-subtle);
		padding-top: 4px;
	}

	.view-tabs {
		display: inline-flex;
		gap: 4px;
		padding: 3px;
		background: var(--line-subtle);
		border-radius: var(--radius-sm);
	}

	.tab-btn {
		border: 0;
		background: transparent;
		color: var(--muted);
		min-height: 32px;
		padding: 4px 16px;
		border-radius: 4px;
		font-size: 12.5px;
		font-weight: 550;
		cursor: pointer;
		transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.tab-btn:hover:not(.is-active) {
		color: var(--ink);
	}

	.tab-btn.is-active {
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-xs);
		font-weight: 600;
	}

	.update-status {
		font-size: 11px;
		color: var(--muted);
	}

	.spend-scroll {
		min-width: 0;
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
		padding: 20px 24px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.spend-scroll > * {
		flex-shrink: 0;
		min-width: 0;
	}

	/* Overview Summary & Hero KPI Cards */
	.overview-summary {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.summary-cards {
		display: grid;
		grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
		gap: 16px;
	}

	.summary-card {
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 18px 20px;
		box-shadow: var(--shadow-xs);
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}

	.card-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.metric-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--muted);
		font-size: 12px;
		font-weight: 550;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.metric-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		display: inline-block;
	}

	.metric-dot.is-tokens {
		background: var(--accent);
	}

	.metric-dot.is-cost {
		background: var(--ok);
	}

	.card-hero-num {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	.primary-number {
		font-size: clamp(30px, 4.2cqi, 40px);
		letter-spacing: -0.035em;
		line-height: 1.15;
		font-weight: 700;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}

	.calls-line {
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
	}

	.token-breakdown {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 8px;
		margin: 0;
	}

	.token-metric-pill {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 8px 10px;
		background: var(--line-subtle);
		border-radius: var(--radius-sm);
	}

	.token-metric-pill dt {
		color: var(--muted);
		font-size: 11px;
		font-weight: 500;
	}

	.token-metric-pill dd {
		margin: 0;
		font-size: 14px;
		font-weight: 650;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}

	.money-summary {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
		height: 100%;
		align-items: center;
	}

	.money-col {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		min-width: 0;
		padding: 10px 14px;
		border-radius: var(--radius-sm);
		background: var(--line-subtle);
	}

	.amount-number {
		font-size: clamp(20px, 2.6cqi, 26px);
		font-weight: 650;
		letter-spacing: -0.025em;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}

	.amount-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		display: inline-block;
	}

	.amount-dot.is-estimated {
		background: none;
		border: 1.5px solid var(--muted);
	}

	.metric-foot {
		font-size: 11px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	/* Coverage Disclosure */
	.coverage {
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		color: var(--muted);
		font-size: 12px;
		overflow: hidden;
		transition: background 0.15s ease;
	}

	summary {
		cursor: pointer;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	.coverage > summary {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		min-height: 40px;
		font-size: 12px;
		font-weight: 500;
	}

	.coverage-title {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--ink-secondary);
	}

	.coverage-icon {
		display: flex;
		align-items: center;
		color: var(--muted);
	}

	.coverage-summary {
		margin-left: auto;
		color: var(--muted);
		font-size: 11px;
	}

	.coverage-chevron {
		display: flex;
		align-items: center;
		color: var(--muted);
		transition: transform 0.2s ease;
	}

	.coverage[open] .coverage-chevron,
	.group-more[open] > summary svg,
	.call-breakdown[open] > summary svg {
		transform: rotate(180deg);
	}

	.coverage-body {
		border-top: 1px solid var(--line-subtle);
		padding: 10px 14px;
		line-height: 1.6;
		background: var(--line-subtle);
		color: var(--ink-secondary);
		font-size: 12px;
	}

	.coverage-body p + p {
		margin-top: 4px;
	}

	/* Analysis Grid: Trend & Categories */
	.analysis-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
	}

	.surface {
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		overflow: hidden;
		box-shadow: var(--shadow-xs);
		min-width: 0;
	}

	.section-head {
		padding: 16px 20px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 12px;
		border-bottom: 1px solid var(--line-subtle);
	}

	.section-head-title {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.section-hint {
		color: var(--muted);
		font-size: 12px;
	}

	.segmented {
		display: inline-flex;
		gap: 2px;
		padding: 3px;
		background: var(--line-subtle);
		border-radius: var(--radius-sm);
	}

	.segmented button {
		border: 0;
		background: transparent;
		border-radius: 4px;
		color: var(--muted);
		min-height: 28px;
		padding: 3px 12px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.segmented button:hover:not([aria-pressed='true']) {
		color: var(--ink);
	}

	.segmented button[aria-pressed='true'] {
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-xs);
		font-weight: 600;
	}

	.trend-content {
		padding: 16px 20px 20px;
	}

	/* Categories List */
	.categories, .kinds {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.categories {
		padding: 12px 20px 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.category-item {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.category-item + .category-item {
		padding-top: 10px;
		border-top: 1px solid var(--line-subtle);
	}

	.category-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 0 12px;
	}

	.category-name {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		border: 0;
		background: transparent;
		padding: 0;
		min-height: 28px;
		text-align: left;
		font-size: 13px;
		font-weight: 550;
		color: var(--ink);
		cursor: pointer;
		overflow-wrap: anywhere;
		transition: color 0.15s ease;
	}

	.category-name:hover:not(:disabled) {
		color: var(--accent);
	}

	.category-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: none;
		background: var(--accent);
	}

	.category-track {
		height: 5px;
		background: var(--line-subtle);
		border-radius: 9999px;
		overflow: hidden;
	}

	.category-track span {
		display: block;
		height: 100%;
		background: var(--accent);
		border-radius: inherit;
		transition: width 0.3s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.category-dot.is-judgement, .category-track .is-judgement { background: var(--purple); }
	.category-dot.is-decision, .category-track .is-decision { background: var(--ok); }
	.category-dot.is-feedback, .category-track .is-feedback { background: var(--warn); }
	.category-dot.is-other, .category-track .is-other { background: var(--muted); }

	.category-call {
		color: var(--muted);
		font-size: 11px;
		white-space: nowrap;
	}

	.category-tokens {
		font-weight: 600;
		font-size: 13px;
	}

	.category-amounts {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px 14px;
		color: var(--muted);
		font-size: 11px;
	}

	.category-amounts b {
		font-weight: 600;
		color: var(--ink-secondary);
		font-variant-numeric: tabular-nums;
	}

	.kind-toggle {
		display: inline-flex;
		justify-content: center;
		align-items: center;
		width: 24px;
		height: 24px;
		border: 1px solid var(--line);
		border-radius: 4px;
		margin-left: auto;
		background: var(--pane);
		color: var(--muted);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.kind-toggle:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.kind-toggle[aria-expanded='true'] svg {
		transform: rotate(180deg);
	}

	.kinds {
		border-left: 2px solid var(--line);
		padding-left: 12px;
		margin-top: 6px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.kind-item {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 2px 10px;
		align-items: center;
	}

	.kind-name {
		font-size: 12px;
	}

	.kind-money {
		grid-column: 1 / -1;
		font-size: 10.5px;
		color: var(--muted);
	}

	.num {
		font-variant-numeric: tabular-nums;
		font-size: 12.5px;
	}

	/* Tables (Desktop) */
	.table-container {
		width: 100%;
		overflow-x: auto;
		scrollbar-width: thin;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
		font-size: 12.5px;
	}

	th, td {
		padding: 12px 14px;
		text-align: right;
		border-bottom: 1px solid var(--line-subtle);
		vertical-align: middle;
	}

	th:first-child, td:first-child {
		padding-left: 20px;
		text-align: left;
	}

	th:last-child, td:last-child {
		padding-right: 20px;
	}

	th {
		font-weight: 550;
		font-size: 11.5px;
		color: var(--muted);
		background: var(--sidebar-bg);
		border-bottom: 1px solid var(--line);
		user-select: none;
	}

	tbody tr {
		transition: background 0.1s ease;
	}

	tbody tr:hover {
		background: var(--row-hover);
	}

	.dimension-table th:first-child { width: 28%; }
	.dimension-table th:last-child { width: 14%; }

	.sort {
		min-height: 28px;
		border: 0;
		background: transparent;
		padding: 0;
		font: inherit;
		color: inherit;
		text-align: inherit;
		cursor: pointer;
		font-weight: 550;
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.sort:hover {
		color: var(--ink);
	}

	.group-name-wrapper {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
	}

	.group-name {
		min-height: 32px;
		border: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-weight: 600;
		padding: 0;
		text-align: left;
		cursor: pointer;
		overflow-wrap: anywhere;
		transition: color 0.15s ease;
	}

	.group-name:hover:not(:disabled) {
		color: var(--accent);
	}

	.group-name:disabled {
		cursor: default;
		color: var(--muted);
	}

	.deleted {
		display: inline-block;
		padding: 1px 6px;
		font-size: 10px;
		font-weight: 500;
		color: var(--muted);
		border: 1px solid var(--line);
		border-radius: 4px;
		white-space: nowrap;
	}

	.is-deleted .group-name {
		color: var(--muted);
	}

	.group-actions {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
	}

	.group-actions:empty {
		padding: 0;
	}

	.open-session-btn {
		font-size: 11.5px;
	}

	.group-more {
		display: none;
	}

	/* Detail Table */
	.detail-table th:nth-child(1) { width: 14%; }
	.detail-table th:nth-child(2) { width: 11%; }
	.detail-table th:nth-child(3) { width: 20%; }
	.detail-table th:nth-child(4) { width: 20%; }
	.detail-table th:nth-child(5) { width: 11%; }
	.detail-table th:nth-child(6) { width: 11%; }
	.detail-table th:nth-child(7) { width: 13%; }
	.detail-table th, .detail-table td { text-align: left; }
	.detail-table td.num { text-align: right; }
	.detail-table td { overflow-wrap: anywhere; }

	.detail-time time {
		display: flex;
		flex-direction: column;
		gap: 2px;
		line-height: 1.3;
	}

	.detail-date {
		font-size: 12px;
		font-weight: 550;
		color: var(--ink);
	}

	.detail-clock {
		font-size: 11px;
	}

	.kind-label {
		display: inline-flex;
		align-items: center;
		padding: 3px 8px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 550;
		background: var(--line-subtle);
		color: var(--ink-secondary);
		border: 1px solid var(--line);
	}

	.kind-label.is-turn { background: var(--accent-tint); color: var(--accent); border-color: var(--accent-border); }
	.kind-label.is-judgement { background: var(--purple-bg); color: var(--purple); border-color: var(--purple-line); }
	.kind-label.is-decision { background: var(--ok-bg); color: var(--ok-text); border-color: var(--ok-line); }
	.kind-label.is-feedback { background: var(--warn-bg); color: var(--warn-text); border-color: var(--warn-line); }

	.detail-owner {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.owner-session {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 550;
		color: var(--ink);
	}

	.owner-bot {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--muted);
		font-size: 11px;
	}

	.model-badge {
		display: inline-block;
		font-size: 12px;
		color: var(--ink-secondary);
		background: var(--line-subtle);
		padding: 2px 7px;
		border-radius: 4px;
	}

	.detail-amount {
		font-weight: 600;
	}

	.detail-actions {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.detail-actions summary, .group-more summary {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--muted);
		min-height: 28px;
		font-size: 11px;
		cursor: pointer;
		transition: color 0.15s ease;
	}

	.detail-actions summary:hover, .group-more summary:hover {
		color: var(--ink);
	}

	.detail-actions summary svg, .group-more summary svg {
		width: 12px;
		height: 12px;
	}

	.call-breakdown dl, .group-more dl {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px 10px;
		padding: 6px 0;
		background: var(--line-subtle);
		border-radius: 4px;
		padding: 8px 10px;
		margin: 4px 0 0;
	}

	.call-breakdown dt, .group-more dt {
		font-size: 10px;
		color: var(--muted);
	}

	.call-breakdown dd, .group-more dd {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.open-trigger-btn {
		font-size: 11.5px;
	}

	.loaded-count-badge {
		font-size: 11.5px;
		color: var(--muted);
		background: var(--line-subtle);
		padding: 3px 8px;
		border-radius: 4px;
	}

	.pagination {
		padding: 16px 20px;
		text-align: center;
		border-top: 1px solid var(--line-subtle);
	}

	.quiet {
		min-height: 38px;
		padding: 0 16px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink);
		font: inherit;
		font-size: 12.5px;
		font-weight: 500;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		transition: all 0.15s ease;
	}

	.quiet:hover:not(:disabled) {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.more {
		width: 100%;
		max-width: 280px;
	}

	.inline-spinner {
		display: inline-block;
		width: 14px;
		height: 14px;
		border: 2px solid var(--line);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	.empty-state, .loading-state, .status-box {
		padding: 48px 20px;
		color: var(--muted);
		font-size: 13px;
		text-align: center;
		display: flex;
		align-items: center;
		flex-direction: column;
		gap: 14px;
	}

	.empty-mark {
		display: inline-flex;
		width: 48px;
		height: 48px;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		color: var(--muted);
	}

	.empty-state h2 {
		font-size: 15px;
	}

	.empty-state p {
		max-width: 280px;
		font-size: 12.5px;
		line-height: 1.5;
	}

	.loading-mark {
		display: block;
		width: 22px;
		height: 22px;
		border: 2.5px solid var(--line);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	.status-icon-wrap {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.status-icon-wrap.is-error {
		background: var(--danger-bg);
		color: var(--danger);
	}

	.retry-btn {
		margin-top: 4px;
	}

	.compact-sort {
		display: none;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	button:focus-visible, summary:focus-visible, select:focus-visible, input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-mark, .inline-spinner, .icon-button.refresh.is-spinning svg {
			animation: none;
		}
	}

	/* Responsive Container Breakpoints */
	@container spend (min-width: 1000px) {
		.analysis-grid {
			grid-template-columns: minmax(0, 1.75fr) minmax(320px, 1fr);
			align-items: start;
		}
	}

	@container spend (max-width: 800px) {
		.summary-cards {
			grid-template-columns: 1fr;
		}
		.dimension-table th:first-child { width: 25%; }
		th, td { padding: 10px 8px; }
	}

	/* Mobile / Narrow Container Breakpoint (≤620px) */
	@container spend (max-width: 620px) {
		.spend-head {
			padding: max(12px, env(safe-area-inset-top, 0px)) max(14px, env(safe-area-inset-right, 0px)) 0 max(14px, env(safe-area-inset-left, 0px));
		}

		.spend-toolbar {
			gap: 10px;
		}

		.heading p {
			display: none;
		}

		h1 {
			font-size: 17px;
		}

		.period-control {
			border-radius: var(--radius-sm);
		}

		.period-control select {
			max-width: 130px;
			font-size: 12px;
			height: 44px;
			padding-left: 28px;
			padding-right: 26px;
		}

		.period-icon {
			left: 8px;
		}

		.period-chevron {
			right: 8px;
		}

		.icon-button {
			width: 44px;
			height: 44px;
		}

		.spend-navigation {
			margin-top: 10px;
			padding-top: 0;
			border-top: 0;
		}

		.view-tabs {
			width: 100%;
			display: flex;
		}

		.tab-btn {
			flex: 1;
			min-height: 40px;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 13px;
		}

		.spend-scroll {
			padding: 14px max(12px, env(safe-area-inset-left, 0px)) max(24px, calc(16px + env(safe-area-inset-bottom, 0px))) max(12px, env(safe-area-inset-right, 0px));
			gap: 16px;
		}

		.summary-cards {
			grid-template-columns: 1fr;
			gap: 12px;
		}

		.summary-card {
			padding: 14px 16px;
			border-radius: var(--radius-sm);
		}

		.primary-number {
			font-size: 28px;
		}

		.money-summary {
			grid-template-columns: 1fr 1fr;
			gap: 10px;
		}

		.money-col {
			padding: 8px 10px;
		}

		.amount-number {
			font-size: 20px;
		}

		.token-breakdown {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 6px;
		}

		.coverage > summary {
			padding: 8px 10px;
		}

		.coverage-summary {
			width: 100%;
			order: 3;
			margin-top: 2px;
		}

		.analysis-grid {
			gap: 16px;
		}

		.section-head {
			padding: 12px 14px;
		}

		.trend-content {
			padding: 12px 14px 16px;
		}

		.categories {
			padding: 10px 14px 14px;
		}

		.category-name {
			min-height: 44px;
		}

		.kind-toggle {
			width: 44px;
			height: 44px;
		}

		.chip {
			min-height: 44px;
			padding: 6px 12px;
		}

		.compact-sort {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 0 14px 12px;
		}

		.compact-sort label {
			flex: 1;
			display: flex;
			align-items: center;
			gap: 8px;
			color: var(--muted);
			font-size: 12px;
			font-weight: 500;
		}

		.compact-sort select {
			min-width: 0;
			flex: 1;
			padding: 0 10px;
			height: 44px;
			background: var(--pane);
			border: 1px solid var(--line);
			border-radius: var(--radius-sm);
			color: var(--ink);
			font: inherit;
			font-size: 12.5px;
		}

		.compact-sort .sort-dir-btn {
			height: 44px;
			width: 44px;
			padding: 0;
		}

		.dimension-tabs {
			width: 100%;
			display: flex;
		}

		.dimension-tabs button {
			flex: 1;
			min-height: 40px;
			font-size: 13px;
		}

		/* Mobile Table-to-Card transformation */
		.dimension-table, .detail-table, tbody {
			display: block;
			width: 100%;
		}

		thead {
			display: none;
		}

		.dimension-table tr {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 8px 14px;
			padding: 14px;
			border-top: 1px solid var(--line);
		}

		.dimension-table td {
			display: block;
			width: auto;
			border: 0;
			text-align: left;
			padding: 0;
		}

		.dimension-table .group-name-cell {
			grid-column: 1 / -1;
		}

		.group-name {
			font-size: 14px;
			min-height: 44px;
			display: flex;
			align-items: center;
		}

		.dimension-table .group-input, .dimension-table .group-output {
			display: none;
		}

		td[data-label]::before {
			content: attr(data-label);
			display: block;
			color: var(--muted);
			font-size: 10.5px;
			margin-bottom: 2px;
			font-weight: 500;
		}

		.group-total {
			grid-row: 2;
			grid-column: 1;
		}

		.group-calls {
			grid-row: 2;
			grid-column: 2;
		}

		.group-estimated, .group-reported {
			font-size: 14px;
			font-weight: 600;
		}

		.dimension-table .group-actions {
			grid-column: 1 / -1;
			padding-top: 4px;
			align-items: stretch;
		}

		.group-more {
			display: block;
		}

		.group-more summary {
			display: flex;
			align-items: center;
			justify-content: space-between;
			min-height: 44px;
			font-size: 12px;
		}

		.open-session-btn {
			min-height: 44px;
			width: 100%;
			justify-content: space-between;
			border: 1px solid var(--line);
			border-radius: var(--radius-sm);
			padding: 0 12px;
			background: var(--line-subtle);
		}

		/* Detail Table Mobile Card */
		.detail-table tr {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			gap: 10px 14px;
			padding: 16px 14px;
			border-top: 1px solid var(--line);
		}

		.detail-table td {
			padding: 0;
			border: 0;
			min-width: 0;
		}

		.detail-time time {
			flex-direction: row;
			flex-wrap: wrap;
			align-items: center;
			gap: 6px;
		}

		.detail-kind {
			justify-self: end;
		}

		.detail-owner {
			grid-column: 1 / -1;
			font-size: 14px;
		}

		.detail-model {
			grid-column: 1 / -1;
		}

		.detail-tokens, .detail-amount {
			font-size: 15px;
		}

		.detail-actions {
			grid-column: 1 / -1;
			display: flex;
			flex-direction: column;
			gap: 8px;
			width: 100%;
		}

		.open-trigger-btn {
			min-height: 44px;
			width: 100%;
			justify-content: space-between;
			border: 1px solid var(--line);
			border-radius: var(--radius-sm);
			padding: 0 12px;
			background: var(--line-subtle);
		}

		.call-breakdown {
			width: 100%;
		}

		.call-breakdown summary {
			min-height: 44px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			font-size: 12px;
		}

		.custom-date-inputs {
			flex-direction: column;
			align-items: stretch;
			gap: 8px;
		}

		.date-sep {
			display: none;
		}

		.date {
			flex-direction: column;
			align-items: flex-start;
			gap: 4px;
		}

		.date input {
			width: 100%;
			box-sizing: border-box;
			height: 44px;
		}
	}

	@container spend (max-width: 360px) {
		.spend-head {
			padding-left: 10px;
			padding-right: 10px;
		}

		.spend-toolbar {
			gap: 6px;
		}

		.period-control select {
			max-width: 110px;
			font-size: 11.5px;
		}

		.money-summary {
			grid-template-columns: 1fr;
			gap: 8px;
		}

		.update-status {
			display: none;
		}
	}
</style>
