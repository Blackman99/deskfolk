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
		/** Bumped when a `spend.created` arrives. The ledger itself is not kept on the client. */
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

{#snippet icon(name: 'back' | 'refresh' | 'chevron' | 'filter' | 'close' | 'arrow')}
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		{#if name === 'back'}<path d="m14 6-6 6 6 6" />
		{:else if name === 'refresh'}<path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
		{:else if name === 'chevron'}<path d="m8 10 4 4 4-4" />
		{:else if name === 'filter'}<path d="M4 6h16M7 12h10M10 18h4" />
		{:else if name === 'close'}<path d="m7 7 10 10M7 17 17-10" />
		{:else}<path d="M5 12h14m-5-5 5 5-5 5" />{/if}
	</svg>
{/snippet}

<section class="spend" aria-label={copy.title} data-spend-view>
	<header class="spend-head">
		<div class="spend-toolbar flex items-center gap-5 min-w-0">
			{#if onClose}<button type="button" class="icon-button back" aria-label={backLabel} onclick={onClose}>{@render icon('back')}</button>{/if}
			<div class="heading min-w-0"><h1>{copy.title}</h1><p>{copy.subtitle}</p></div>
			<label class="period-control"><span class="sr">{copy.period}</span><select aria-label={copy.period} value={view.range} onchange={(event) => setRange(event.currentTarget.value as SpendRangePreset)}>{#each ranges as range}<option value={range}>{copy.ranges[range]}</option>{/each}</select>{@render icon('chevron')}</label>
			<button type="button" class="icon-button refresh" aria-label={copy.refresh} title={copy.refresh} disabled={loading || !!rangeIssue || !api} onclick={refresh}>{@render icon('refresh')}</button>
		</div>
		<div class="expandable-controls">
		{#if view.range === 'custom'}
			<div class="custom-dates flex flex-wrap gap-5">
				<label class="date"><span>{copy.from}</span><input type="date" aria-label={copy.from} aria-invalid={!!rangeIssue} bind:value={view.customFrom} /></label>
				<label class="date"><span>{copy.to}</span><input type="date" aria-label={copy.to} aria-invalid={!!rangeIssue} bind:value={view.customTo} /></label>
				{#if rangeIssue}<p class="field-error" role="alert">{rangeMessage(rangeIssue)}</p>{/if}
			</div>
		{/if}
		{#if chips.length}
			<div class="chips flex flex-wrap items-center gap-3" aria-label={copy.filters}>
				<span class="filter-icon text-muted" aria-hidden="true">{@render icon('filter')}</span>
				{#each chips as chip (chip.key)}<button type="button" class="chip" aria-label={copy.clearFilter(chip.label)} onclick={chip.clear}><span>{chip.label}</span>{@render icon('close')}</button>{/each}
				<button type="button" class="text-action clear-all" onclick={() => (drill = {})}>{copy.clearAll}</button>
			</div>
		{/if}
		</div>
		<div class="spend-navigation flex items-center justify-between gap-5">
			<div class="view-tabs flex" role="tablist" aria-label={copy.title}>
				{#each ['overview', 'details'] as name}
					<button type="button" role="tab" aria-selected={section === name} tabindex={section === name ? 0 : -1} class:is-active={section === name} onclick={() => switchSection(name as 'overview' | 'details')} onkeydown={(event) => sectionKey(event, name as 'overview' | 'details')}>{name === 'overview' ? copy.overview : copy.details}</button>
				{/each}
			</div>
			<span class="update-status text-11 text-muted" role="status">{loading && summary ? copy.refreshing : ''}</span>
		</div>
	</header>

	<div class="spend-scroll" bind:this={scrollArea} onscroll={() => (scrollPositions[section] = scrollArea?.scrollTop ?? 0)} role="tabpanel" aria-label={section === 'overview' ? copy.overview : copy.details} aria-busy={loading}>
		{#if failed}
			<div class="status-box" role="alert"><strong>{copy.error}</strong><button type="button" class="quiet" onclick={refresh} disabled={loading || !!rangeIssue}>{copy.retry}</button></div>
		{:else if !summary}
			<div class="loading-state" role="status"><span class="loading-mark" aria-hidden="true"></span>{copy.loading}</div>
		{:else if summary.totals.calls === 0}
			<div class="empty-state"><span class="empty-mark" aria-hidden="true">{@render icon('filter')}</span><h2>{copy.empty}</h2><p>{copy.emptyHint}</p>{#if chips.length}<button type="button" class="quiet" onclick={() => (drill = {})}>{copy.clearAll}</button>{/if}</div>
		{:else}
			{#if section === 'overview'}
				{@const totals = summary.totals}
				<section class="overview-summary" aria-label={copy.totals}>
					<div class="summary-main">
						<div class="usage-total"><span class="metric-label">{copy.totalTokens}</span><strong class="primary-number" title={totals.total_tokens?.toLocaleString(locale)}>{num(totals.total_tokens)}</strong><span class="calls-line">{copy.recordedCalls(totals.calls)}</span></div>
						<div class="money-summary"><div><span class="metric-label"><i class="amount-dot"></i>{copy.reported}</span><strong class="amount-number">{money(totals.reported_usd_ticks)}</strong><span class="metric-foot">{copy.coveredCalls(totals.reported_calls)}</span></div><div><span class="metric-label"><i class="amount-dot is-estimated"></i>{copy.estimated}</span><strong class="amount-number">{money(totals.estimated_usd_ticks)}</strong><span class="metric-foot">{copy.coveredCalls(totals.estimated_calls)}</span></div></div>
					</div>
					<dl class="token-breakdown figures" aria-label={copy.usageDetails}>{#each tokenMetrics(totals) as item}<div><dt>{item.label}</dt><dd title={item.value?.toLocaleString(locale)}>{num(item.value)}</dd></div>{/each}</dl>
					<details class="coverage"><summary><span>{copy.coverage}</span><span class="coverage-summary">{totals.missing_usage_calls ? copy.missingUsage(totals.missing_usage_calls) : copy.estimateCoverage(totals.reported_calls, totals.estimated_calls)}</span>{@render icon('chevron')}</summary><div class="coverage-body"><p>{copy.estimatedHint}</p><p>{copy.estimateCoverage(totals.reported_calls, totals.estimated_calls)}</p>{#if totals.missing_calls}<p>{copy.missingAmount(totals.missing_calls)} · {copy.estimateUnknown}</p>{/if}{#if totals.missing_usage_calls}<p>{copy.missingUsage(totals.missing_usage_calls)}</p>{/if}</div></details>
				</section>

				<div class="analysis-grid">
					<section class="surface trend-surface" aria-label={copy.trend}>
						<div class="section-head flex items-center justify-between flex-wrap gap-5"><h2>{copy.trend}</h2><div class="segmented flex" role="group" aria-label={copy.trend}><button type="button" aria-pressed={view.metric === 'tokens'} onclick={() => (view.metric = 'tokens')}>{copy.metricTokens}</button><button type="button" aria-pressed={view.metric === 'money'} onclick={() => (view.metric = 'money')}>{copy.metricMoney}</button></div></div>
						<div class="trend-content"><SpendTrend {days} metric={view.metric} {locale} range={askedWindow} {timeZone} /></div>
					</section>
					<section class="surface category-surface" aria-label={copy.categories}>
						<div class="section-head flex items-center justify-between gap-5"><h2>{copy.categories}</h2><span class="text-11 text-muted">{copy.totalTokens}</span></div>
						<ul class="categories">
							{#each summary.categories as category (category.category)}
								<li class="category-item">
									<div class="category-row"><button type="button" class="category-name" disabled={loading} onclick={() => drillCategory(category.category)}><i class="category-dot is-{category.category}"></i>{copy.category[category.category]}</button><span class="num">{num(category.total_tokens)}</span><span class="category-call">{copy.recordedCalls(category.calls)}</span></div>
									<div class="category-track" aria-hidden="true"><span class="is-{category.category}" style:width="{categoryWidth(category.total_tokens)}%"></span></div>
									<div class="category-amounts"><span>{copy.reported} <b>{money(category.reported_usd_ticks)}</b></span><span>{copy.estimated} <b>{money(category.estimated_usd_ticks)}</b></span>{#if category.kinds.length > 1}<button type="button" class="kind-toggle" aria-label={copy.expand} aria-expanded={!!expanded[category.category]} onclick={() => toggleCategory(category.category)}>{@render icon('chevron')}</button>{/if}</div>
									{#if expanded[category.category]}<ul class="kinds">{#each category.kinds as kind (kind.kind)}<li><button type="button" class="text-action" disabled={loading} onclick={() => drillKind(kind.kind)}>{copy.kind[kind.kind]}</button><span class="num">{num(kind.total_tokens)}</span><span class="kind-money">{copy.reported} {money(kind.reported_usd_ticks)} · {copy.estimated} {money(kind.estimated_usd_ticks)}</span></li>{/each}</ul>{/if}
								</li>
							{/each}
						</ul>
					</section>
				</div>

				<section class="surface dimension-surface" aria-label={copy.dimension}>
					<div class="section-head distribution-head flex items-center justify-between flex-wrap gap-6"><div><h2>{copy.distribution}</h2><p class="section-hint">{copy.breakdownHint}</p></div><div class="segmented dimension-tabs flex" role="group" aria-label={copy.dimension}>{#each dimensions as dimension}<button type="button" aria-pressed={view.dimension === dimension} onclick={() => (view.dimension = dimension)}>{copy.dimensions[dimension]}</button>{/each}</div></div>
					<div class="compact-sort"><label><span>{copy.sort}</span><select aria-label={copy.sort} value={view.sort} onchange={(event) => (view.sort = event.currentTarget.value as SpendSortColumn)}>{#each columns as column}<option value={column.key}>{columnLabel(column)}</option>{/each}</select></label><button type="button" class="quiet" aria-label={view.dir === 'asc' ? copy.ascending : copy.descending} onclick={() => (view.dir = view.dir === 'asc' ? 'desc' : 'asc')}>{view.dir === 'asc' ? '↑' : '↓'}</button></div>
					<table class="dimension-table">
						<thead><tr>{#each columns as column}<th aria-sort={view.sort === column.key ? (view.dir === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" class="sort" aria-label={copy.sortBy(columnLabel(column))} onclick={() => sortBy(column.key)}>{columnLabel(column)}{sortMark(column.key)}</button></th>{/each}<th><span class="sr">{copy.openSession}</span></th></tr></thead>
						<tbody>{#each sortedGroups as group (`${group.id ?? 'null'}-${group.provider_id ?? ''}-${group.model ?? ''}`)}
							<tr class:is-deleted={group.deleted}>
								<td class="group-name-cell"><button type="button" class="group-name" disabled={!groupsActionable || loading} onclick={() => drillGroup(group)}>{groupLabel(group)}</button>{#if group.deleted}<span class="deleted">{copy.deleted}</span>{/if}</td>
								<td class="num group-calls" data-label={copy.calls}>{formatTokens(group.calls)}</td>
								<td class="num group-input" data-label={copy.input}>{num(group.input_tokens)}</td><td class="num group-output" data-label={copy.output}>{num(group.output_tokens)}</td>
								<td class="num group-total" data-label={copy.totalTokens}>{num(group.total_tokens)}</td><td class="num group-reported" data-label={copy.reported}>{money(group.reported_usd_ticks)}</td><td class="num group-estimated" data-label={copy.estimated}>{money(group.estimated_usd_ticks)}</td>
								<td class="group-actions">{#if groupsActionable && shownDimension === 'session' && group.id && !group.deleted && onOpenSession}<button type="button" class="text-action" onclick={() => onOpenSession?.(group.id!)}>{copy.openSession}{@render icon('arrow')}</button>{/if}<details class="group-more"><summary aria-label={copy.inspect}>{copy.usageDetails}{@render icon('chevron')}</summary><dl>{#each tokenMetrics(group) as item}<div><dt>{item.label}</dt><dd>{num(item.value)}</dd></div>{/each}</dl></details></td>
							</tr>
						{/each}</tbody>
					</table>
				</section>
			{:else}
				<section class="surface detail-surface" aria-label={copy.details}>
					<div class="section-head flex justify-between items-center flex-wrap gap-5"><div><h2>{copy.details}</h2><p class="section-hint">{copy.detailHint}</p></div><span class="text-12 text-muted">{copy.loadedCalls(details.length)}</span></div>
					<table class="detail-table"><thead><tr><th>{copy.time}</th><th>{copy.categories}</th><th>{copy.session} / {copy.bot}</th><th>{copy.model}</th><th>{copy.totalTokens}</th><th>{copy.amount}</th><th><span class="sr">{copy.openTrigger}</span></th></tr></thead>
						<tbody>{#each details as row (row.id)}<tr class:is-deleted={row.session_deleted || row.bot_deleted}>
							<td class="detail-time"><time datetime={row.created_at} title={row.created_at}><span>{dateLabel(row.created_at)}</span><span class="text-muted">{timeLabel(row.created_at)}</span></time></td>
							<td class="detail-kind"><span class="kind-label is-{categoryOf[row.kind]}">{copy.kind[row.kind]}</span></td>
							<td class="detail-owner"><span>{detailSession(row)}{#if row.session_deleted}<span class="deleted">{copy.deleted}</span>{/if}</span><span class="owner-bot">{detailBot(row)}{#if row.bot_deleted}<span class="deleted">{copy.deleted}</span>{/if}</span></td>
							<td class="detail-model" data-label={copy.model}>{detailModel(row)}</td>
							<td class="detail-tokens num" data-label={copy.totalTokens}>{num(row.total_tokens)}</td><td class="detail-amount num" data-label={row.estimated_cost_usd_ticks != null && row.cost_usd_ticks == null ? copy.estimated : copy.reported} title={amountTitle(row)}>{detailAmount(row)}</td>
							<td class="detail-actions"><details class="call-breakdown"><summary>{copy.usageDetails}{@render icon('chevron')}</summary><dl>{#each tokenMetrics(row) as item}<div><dt>{item.label}</dt><dd>{num(item.value)}</dd></div>{/each}</dl></details>{#if row.trigger_message_id && !row.session_deleted && onOpenTrigger}<button type="button" class="text-action" onclick={() => onOpenTrigger?.(row.session_id, row.trigger_message_id!)}>{copy.openTrigger}{@render icon('arrow')}</button>{/if}</td>
						</tr>{/each}</tbody>
					</table>
					{#if nextCursor}<div class="pagination"><button type="button" class="more quiet" disabled={loadingMore || loading} onclick={() => void loadMore()}>{loadingMore ? copy.loadingMore : copy.loadMore}</button></div>{/if}
				</section>
			{/if}
		{/if}
	</div>
</section>

<style>
	.spend { container: spend / inline-size; display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; overflow: hidden; background: var(--sidebar-bg); color: var(--ink); font-family: var(--font); }
	.spend-head { flex: none; padding: 18px 24px 0; background: var(--pane); border-bottom: 1px solid var(--line); z-index: 1; position: relative; max-height: 58%; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; }
	.expandable-controls { min-height: 0; }
	.heading { flex: 1; }
	h1, h2, p, dl, dd { margin: 0; }
	h1 { font-size: 20px; line-height: 1.3; font-weight: 650; letter-spacing: -.025em; }
	.heading p { margin-top: 3px; color: var(--muted); font-size: 12px; }
	h2 { font-size: 14px; line-height: 1.5; font-weight: 650; }
	.spend-scroll { min-width: 0; min-height: 0; flex: 1; overflow: auto; overscroll-behavior: contain; padding: 24px; display: flex; flex-direction: column; gap: 20px; }
	.spend-scroll > * { flex-shrink: 0; min-width: 0; }
	.icon-button { width: 40px; height: 44px; flex: none; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--muted); }
	.icon-button:hover { background: var(--line-subtle); color: var(--ink); }
	.period-control { position: relative; flex: none; }
	.period-control select { appearance: none; padding: 0 34px 0 12px; height: 40px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--pane); color: var(--ink); font: inherit; font-size: 13px; max-width: 170px; }
	.period-control svg { position: absolute; right: 10px; top: 12px; pointer-events: none; }
	.spend-navigation { margin-top: 14px; }
	.view-tabs { gap: 24px; }
	.view-tabs button { border: 0; background: transparent; color: var(--muted); min-height: 44px; padding: 0 1px; position: relative; font-size: 13px; font-weight: 550; }
	.view-tabs button.is-active { color: var(--accent); }
	.view-tabs button.is-active::after { content: ''; position: absolute; bottom: -1px; left: 0; right: 0; height: 2px; background: var(--accent); border-radius: 2px; }
	.date { min-width: 0; flex: 1; display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); }
	.date input { min-width: 0; width: 100%; padding: 8px; min-height: 42px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--input-bg); color: var(--ink); font: inherit; }
	.custom-dates { margin-top: 12px; max-width: 560px; }
	.field-error { width: 100%; font-size: 12px; color: var(--danger); }
	.chips { padding: 8px 0 2px; }
	.chip { display: inline-flex; align-items: center; gap: 8px; max-width: min(100%, 320px); min-height: 36px; padding: 5px 9px; border: 1px solid var(--accent-border); border-radius: var(--radius-sm); background: var(--accent-tint); color: var(--accent); font-size: 12px; }
	.chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.chip svg { flex: none; width: 13px; }
	.text-action { display: inline-flex; align-items: center; justify-content: flex-start; gap: 5px; min-height: 40px; border: 0; background: transparent; padding: 0; font: inherit; font-size: 12px; color: var(--accent); text-align: left; }
	.clear-all { color: var(--muted); }
	.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
	.overview-summary { padding: 0 0 2px; }
	.summary-main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); align-items: center; gap: 24px; }
	.usage-total { display: flex; flex-direction: column; gap: 5px; padding: 0 0 0 2px; }
	.metric-label { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
	.primary-number { font-size: clamp(28px, 4cqi, 40px); letter-spacing: -.035em; line-height: 1.2; font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
	.calls-line { color: var(--muted); font-size: 12px; }
	.money-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; padding: 16px 20px; background: var(--pane); border: 1px solid var(--line); border-radius: var(--radius-md); }
	.money-summary > div { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; min-width: 0; }
	.amount-number { font-size: clamp(20px, 2.8cqi, 28px); font-weight: 550; letter-spacing: -.02em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
	.amount-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
	.amount-dot.is-estimated { background: none; border: 1.5px solid var(--muted); }
	.metric-foot { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
	.token-breakdown { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 20px; gap: 12px; }
	.token-breakdown > div { padding-left: 12px; border-left: 2px solid var(--line); }
	dt { color: var(--muted); font-size: 11px; }
	.token-breakdown dd { font-size: 15px; font-weight: 550; margin-top: 3px; font-variant-numeric: tabular-nums; }
	.coverage { margin-top: 12px; color: var(--muted); font-size: 11px; }
	summary { cursor: pointer; list-style: none; }
	summary::-webkit-details-marker { display: none; }
	.coverage > summary { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 12px; min-height: 40px; }
	.coverage > summary > svg { width: 12px; }
	.coverage[open] > summary > svg, .group-more[open] > summary svg, .call-breakdown[open] > summary svg { transform: rotate(180deg); }
	.coverage-summary { margin-left: auto; }
	.coverage-body { border-left: 2px solid var(--line); padding: 8px 12px; line-height: 1.65; }
	.coverage-body p + p { margin-top: 4px; }
	.trend-content { padding: 0 18px 18px; }
	.analysis-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
	.surface { flex-shrink: 0; background: var(--pane); border: 1px solid var(--line); border-radius: var(--radius-md); overflow: hidden; min-width: 0; }
	.section-head { padding: 16px 18px; }
	.section-hint { color: var(--muted); font-size: 12px; margin-top: 3px; }
	.segmented { gap: 2px; padding: 3px; background: var(--line-subtle); border-radius: var(--radius-sm); }
	.segmented button { border: 0; background: transparent; border-radius: 4px; color: var(--muted); min-height: 34px; padding: 4px 12px; font-size: 12px; }
	.segmented button[aria-pressed='true'] { background: var(--pane); color: var(--ink); box-shadow: var(--shadow-xs); font-weight: 550; }
	.categories, .kinds { list-style: none; margin: 0; padding: 0; }
	.categories { padding: 0 18px 10px; }
	.category-item { padding: 5px 0; }
	.category-item + .category-item { border-top: 1px solid var(--line-subtle); }
	.category-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 0 10px; }
	.category-name { display: inline-flex; align-items: center; gap: 8px; border: 0; background: transparent; padding: 0; min-height: 36px; text-align: left; font-size: 12px; color: var(--ink); overflow-wrap: anywhere; }
	.category-name:hover { color: var(--accent); }
	.category-call { color: var(--muted); font-size: 10px; white-space: nowrap; }
	.category-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--accent); }
	.category-track { height: 3px; background: var(--line-subtle); border-radius: 4px; overflow: hidden; }
	.category-track span { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
	.category-dot.is-judgement, .category-track .is-judgement { background: var(--purple); }
	.category-dot.is-decision, .category-track .is-decision { background: var(--ok); }
	.category-dot.is-feedback, .category-track .is-feedback { background: var(--warn); }
	.category-dot.is-other, .category-track .is-other { background: var(--muted); }
	.category-amounts { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin-top: 5px; color: var(--muted); font-size: 10px; }
	.category-amounts b { font-weight: 450; color: var(--ink-secondary); font-variant-numeric: tabular-nums; }
	.kind-toggle { display: flex; justify-content: center; align-items: center; width: 32px; height: 32px; border: 0; margin-left: auto; background: transparent; color: var(--muted); }
	.kind-toggle[aria-expanded='true'] svg { transform: rotate(180deg); }
	.kinds { border-left: 2px solid var(--line); padding-left: 12px; margin-top: 6px; }
	.kinds li { display: grid; grid-template-columns: 1fr auto; gap: 0 10px; align-items: center; }
	.kind-money { grid-column: 1 / -1; font-size: 10px; color: var(--muted); }
	.num { font-variant-numeric: tabular-nums; font-size: 12px; }
	.compact-sort { display: none; }
	table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
	th, td { padding: 12px 10px; text-align: right; border-bottom: 1px solid var(--line-subtle); vertical-align: top; }
	th:first-child, td:first-child { padding-left: 18px; text-align: left; }
	th:last-child, td:last-child { padding-right: 18px; }
	th { font-weight: 400; font-size: 11px; color: var(--muted); background: var(--sidebar-bg); }
	.dimension-table th:first-child { width: 27%; }
	.dimension-table th:last-child { width: 12%; }
	.dimension-table td { vertical-align: middle; }
	.sort { min-height: 32px; border: 0; background: transparent; padding: 0; font: inherit; color: inherit; text-align: inherit; }
	.sort:hover { color: var(--ink); }
	.group-name { min-height: 40px; border: 0; background: transparent; color: var(--ink); font: inherit; font-weight: 550; padding: 0; text-align: left; overflow-wrap: anywhere; }
	.group-name:hover { color: var(--accent); }
	.group-name:disabled { cursor: default; color: var(--muted); }
	.deleted { display: inline-block; padding: 1px 5px; font-size: 10px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; white-space: nowrap; margin-left: 5px; }
	.is-deleted .group-name { color: var(--muted); }
	.group-actions:empty { padding: 0; }
	.group-actions .text-action { min-height: 32px; font-size: 11px; overflow-wrap: anywhere; }
	.group-more { display: none; }
	.detail-table th:nth-child(1) { width: 12%; }
	.detail-table th:nth-child(2) { width: 12%; }
	.detail-table th:nth-child(3) { width: 20%; }
	.detail-table th:nth-child(4) { width: 22%; }
	.detail-table th:nth-child(7) { width: 17%; }
	.detail-table th, .detail-table td { text-align: left; }
	.detail-table td { overflow-wrap: anywhere; }
	.detail-time time, .detail-owner { line-height: 1.6; }
	.detail-time time > span, .detail-owner > span { display: block; }
	.owner-bot { color: var(--muted); font-size: 11px; }
	.kind-label { display: inline-flex; max-width: 100%; padding: 3px 6px; border-radius: 4px; color: var(--ink); background: var(--line-subtle); font-size: 10px; }
	.detail-actions summary { display: inline-flex; align-items: center; gap: 3px; color: var(--muted); min-height: 32px; font-size: 11px; }
	.detail-actions summary svg { width: 12px; }
	.call-breakdown dl, .group-more dl { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 12px; padding: 8px 0; }
	.call-breakdown dt, .group-more dt { font-size: 10px; }
	.call-breakdown dd, .group-more dd { font-size: 12px; }
	.detail-actions .text-action { font-size: 11px; }
	.pagination { padding: 16px; text-align: center; }
	.quiet { min-height: 42px; padding: 0 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--pane); color: var(--ink-secondary); font: inherit; font-size: 12px; }
	.quiet:hover { background: var(--line-subtle); }
	.empty-state, .loading-state, .status-box { padding: 40px 16px; color: var(--muted); font-size: 13px; text-align: center; display: flex; align-items: center; flex-direction: column; gap: 14px; }
	.empty-mark { display: inline-flex; width: 44px; height: 44px; align-items: center; justify-content: center; border-radius: var(--radius-md); background: var(--line-subtle); }
	.empty-state p { max-width: 260px; font-size: 12px; }
	.loading-mark { display: block; width: 20px; height: 20px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	button:focus-visible, summary:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
	button:disabled { opacity: .55; }
	@media (prefers-reduced-motion: reduce) { .loading-mark { animation: none; } }
	@container spend (min-width: 1000px) { .analysis-grid { grid-template-columns: minmax(0, 1.75fr) minmax(300px, 1fr); align-items: start; } .category-surface .section-head { padding-bottom: 8px; } }
	@container spend (max-width: 800px) { .dimension-table th:first-child { width: 24%; } th, td { padding: 10px 6px; } .detail-table th:nth-child(4) { width: 19%; } }
	@container spend (max-width: 620px) {
		.spend-head { padding: 12px 14px 0; }
		.spend-toolbar { gap: 8px; }
		.heading p { display: none; }
		h1 { font-size: 17px; }
		.period-control select { max-width: 138px; font-size: 12px; height: 44px; }
		.refresh, .back { width: 44px; }
		.spend-navigation { margin-top: 5px; }
		.trend-content { padding: 0 14px 14px; }
		.spend-scroll { padding: 16px 12px; gap: 16px; }
		.summary-main { grid-template-columns: 1fr; gap: 16px; }
		.usage-total { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; }
		.usage-total .metric-label { grid-column: 1 / -1; }
		.primary-number { font-size: 30px; }
		.money-summary { gap: 16px; padding: 14px; }
		.amount-number { font-size: 23px; }
		.token-breakdown { gap: 5px; margin-top: 16px; }
		.token-breakdown > div { padding-left: 8px; }
		.token-breakdown dd { font-size: 13px; }
		.coverage-summary { width: 100%; margin: 0; order: 3; }
		.coverage > summary { font-size: 11px; padding: 5px 0; }
		.analysis-grid { gap: 16px; }
		.section-head { padding: 14px; }
		.section-hint { font-size: 11px; }
		.segmented button { min-height: 40px; padding: 5px 12px; }
		.category-name { min-height: 44px; }
		.category-name .category-dot { width: 5px; height: 5px; }
		.category-amounts { font-size: 10px; }
		.category-call { font-size: 10px; }
		.kind-toggle { width: 44px; height: 44px; }
		.categories { padding: 0 14px 10px; }
		.chip { min-height: 44px; max-width: calc(100% - 8px); }
		.filter-icon { display: none; }
		.clear-all { min-height: 44px; }
		.compact-sort { display: flex; align-items: center; gap: 8px; padding: 0 14px 10px; }
		.compact-sort label { flex: 1; display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 11px; }
		.compact-sort select { min-width: 0; flex: 1; padding: 0 10px; height: 44px; background: var(--pane); border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink); font: inherit; font-size: 12px; }
		.compact-sort .quiet { height: 44px; width: 44px; padding: 0; }
		.dimension-tabs { width: 100%; }
		.dimension-tabs button { flex: 1; min-height: 44px; }
		.dimension-table, .detail-table, tbody { display: block; width: 100%; }
		thead { display: none; }
		.dimension-table tr { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; padding: 14px; border-top: 1px solid var(--line); }
		.dimension-table td { display: block; width: auto; border: 0; text-align: left; padding: 0; }
		.dimension-table .group-name-cell { grid-column: 1 / -1; }
		.group-name { font-size: 13px; min-height: 44px; }
		.dimension-table .group-input, .dimension-table .group-output { display: none; }
		td[data-label]::before { content: attr(data-label); display: block; color: var(--muted); font-size: 10px; margin-bottom: 3px; font-weight: 400; }
		.group-total { grid-row: 2; grid-column: 1; }
		.group-calls { grid-row: 2; grid-column: 2; }
		.group-estimated, .group-reported { font-size: 14px; }
		.dimension-table .group-actions { grid-column: 1 / -1; padding-top: 2px; }
		.group-more { display: block; }
		.group-more summary { display: flex; align-items: center; gap: 5px; min-height: 44px; font-size: 11px; color: var(--muted); }
		.group-more summary svg { width: 12px; }
		.group-actions .text-action { min-height: 44px; }
		.detail-table tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; padding: 16px 14px; border-top: 1px solid var(--line); }
		.detail-table td { padding: 0; border: 0; min-width: 0; }
		.detail-time time { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 11px; }
		.detail-kind { justify-self: end; }
		.detail-owner { grid-column: 1 / -1; font-size: 14px; font-weight: 550; }
		.detail-model { grid-column: 1 / -1; font-size: 12px; color: var(--ink-secondary); }
		.detail-tokens, .detail-amount { font-size: 15px; }
		.detail-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; }
		.detail-actions .text-action, .detail-actions summary { min-height: 44px; }
		.call-breakdown { flex: 1 0 50%; }
		.kind-label { font-size: 10px; padding: 3px 6px; }
		.custom-dates { gap: 8px; }
		.date { flex-direction: column; align-items: flex-start; gap: 4px; }
		.date input { width: 100%; box-sizing: border-box; }
	}
	@container spend (max-width: 340px) { .spend-head { padding: 10px 10px 0; } .spend-toolbar { gap: 3px; } .period-control select { max-width: 122px; padding-left: 9px; } .refresh, .back { width: 44px; } .money-summary { gap: 8px; padding: 12px; } .amount-number { font-size: 20px; } .token-breakdown { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } .update-status { display: none; } .view-tabs { gap: 18px; } }
</style>
