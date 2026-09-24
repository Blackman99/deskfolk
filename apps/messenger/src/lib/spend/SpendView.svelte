<script lang="ts">
	import { untrack } from 'svelte';
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
		type SpendMetric,
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
			if (askedDimension !== shownDimension) groupsActionable = false;
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
		if (!groupsActionable || view.dimension !== shownDimension) return;
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

	function dayTotal(day: SpendGroup, field: 'total_tokens' | 'reported_usd_ticks' | 'estimated_usd_ticks'): number {
		let sum = 0;
		for (const category of day.categories) {
			const value = category[field];
			if (value) sum += value;
		}
		return sum;
	}

	const tokenScale = $derived(Math.max(0, ...days.map((day) => dayTotal(day, 'total_tokens'))));
	const reportedScale = $derived(Math.max(0, ...days.map((day) => dayTotal(day, 'reported_usd_ticks'))));
	const estimatedScale = $derived(Math.max(0, ...days.map((day) => dayTotal(day, 'estimated_usd_ticks'))));

	type StackPart = { key: string; category: SpendGroup['categories'][number]['category']; height: number; label: string };

	function tokenParts(day: SpendGroup): StackPart[] {
		if (tokenScale <= 0) return [];
		const parts: StackPart[] = [];
		for (const category of day.categories) {
			const value = category.total_tokens ?? 0;
			if (value <= 0) continue;
			parts.push({
				key: category.category,
				category: category.category,
				height: (value / tokenScale) * 100,
				label: copy.dayTokens(day.id ?? '', copy.category[category.category], formatTokens(value))
			});
		}
		return parts;
	}

	function moneyParts(day: SpendGroup, field: 'reported_usd_ticks' | 'estimated_usd_ticks', scale: number): StackPart[] {
		if (scale <= 0) return [];
		const parts: StackPart[] = [];
		for (const category of day.categories) {
			const value = category[field] ?? 0;
			if (value <= 0) continue;
			parts.push({
				key: category.category,
				category: category.category,
				height: (value / scale) * 100,
				label: copy.dayAmount(day.id ?? '', copy.category[category.category], formatUsd(value))
			});
		}
		return parts;
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

	/**
	 * A group cannot say why an amount is missing. `missing_usage_calls` only counts rows with
	 * every token field empty, so a partial input/output is invisible there and must not be
	 * read as "the rate is unset".
	 */
	function estimateNote(row: SpendTotals): string | null {
		if (row.estimated_usd_ticks != null) return copy.estimatedHint;
		if (row.missing_calls > 0) return copy.estimateUnknown;
		return null;
	}

	function amountTitle(row: SpendDetail): string | undefined {
		if (row.estimated_cost_usd_ticks != null && row.cost_usd_ticks == null) return copy.estimatedHint;
		if (row.cost_usd_ticks == null && row.estimated_cost_usd_ticks == null) {
			if (row.input_tokens == null || row.output_tokens == null) return copy.estimateIncompleteUsage;
			return copy.estimateUnconfigured;
		}
		return undefined;
	}
</script>

<section class="spend" aria-label={copy.title} data-spend-view>
	<header class="spend-head">
		{#if onClose}
			<button type="button" class="back" aria-label={backLabel} onclick={onClose}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="15 18 9 12 15 6"></polyline>
				</svg>
				<span>{backLabel}</span>
			</button>
		{/if}
		<h1>{copy.title}</h1>
		<div class="ranges" role="group" aria-label={copy.ranges.custom}>
			{#each ranges as range (range)}
				<button
					type="button"
					class:is-on={view.range === range}
					aria-pressed={view.range === range}
					onclick={() => setRange(range)}
				>
					{copy.ranges[range]}
				</button>
			{/each}
		</div>
		{#if view.range === 'custom'}
			<label class="date">
				<span>{copy.from}</span>
				<input type="date" aria-label={copy.from} bind:value={view.customFrom} />
			</label>
			<label class="date">
				<span>{copy.to}</span>
				<input type="date" aria-label={copy.to} bind:value={view.customTo} />
			</label>
			{#if rangeIssue}
				<p class="field-error" role="alert">{rangeMessage(rangeIssue)}</p>
			{/if}
		{/if}
	</header>

	{#if chips.length > 0}
		<div class="chips" aria-label={copy.filters}>
			{#each chips as chip (chip.key)}
				<button type="button" class="chip" onclick={chip.clear}>
					<span>{chip.label}</span>
					<span class="chip-x" aria-hidden="true">×</span>
					<span class="sr">{copy.clearFilter(chip.label)}</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if failed}
		<div class="status" role="alert">
			<p>{copy.error}</p>
			<button type="button" onclick={() => reload(askedWindow)}>{copy.retry}</button>
		</div>
	{:else if loading && !summary}
		<p class="status" role="status">{copy.loading}</p>
	{:else if summary && summary.totals.calls === 0}
		<p class="status">{copy.empty}</p>
	{:else if summary}
		{@const totals = summary.totals}
		<section class="block" aria-label={copy.totals}>
			<h2>{copy.totals}</h2>
			<dl class="figures">
				<div><dt>{copy.input}</dt><dd class="num">{num(totals.input_tokens)}</dd></div>
				<div><dt>{copy.cached}</dt><dd class="num">{num(totals.cached_tokens)}</dd></div>
				<div><dt>{copy.output}</dt><dd class="num">{num(totals.output_tokens)}</dd></div>
				<div><dt>{copy.reasoning}</dt><dd class="num">{num(totals.reasoning_tokens)}</dd></div>
				<div><dt>{copy.totalTokens}</dt><dd class="num">{num(totals.total_tokens)}</dd></div>
				<div><dt>{copy.calls}</dt><dd class="num">{formatTokens(totals.calls)}</dd></div>
				<div><dt>{copy.reported}</dt><dd class="num">{money(totals.reported_usd_ticks)}</dd></div>
				<div>
					<dt>{copy.estimated}</dt>
					<dd class="num">{money(totals.estimated_usd_ticks, totals.estimated_usd_ticks != null)}</dd>
				</div>
			</dl>
			{#if totals.reported_calls > 0 || totals.estimated_calls > 0}
				<p class="note">{copy.estimateCoverage(totals.reported_calls, totals.estimated_calls)}</p>
			{/if}
			{#if estimateNote(totals)}
				<p class="note">{estimateNote(totals)}</p>
			{/if}
			{#if totals.missing_usage_calls > 0}
				<p class="note">{copy.missingUsage(totals.missing_usage_calls)}</p>
			{/if}
			{#if totals.missing_calls > 0}
				<p class="note">{copy.missingAmount(totals.missing_calls)}</p>
			{/if}
		</section>

		<section class="block" aria-label={copy.categories}>
			<h2>{copy.categories}</h2>
			<ul class="categories">
				{#each summary.categories as category (category.category)}
					<li>
						<div class="category-row">
							<button type="button" class="link" onclick={() => drillCategory(category.category)}>
								{copy.category[category.category]}
							</button>
							<span class="num">{num(category.total_tokens)}</span>
							<span class="num">{money(category.reported_usd_ticks)}</span>
							<span class="num" title={estimateNote(category) ?? undefined}>{money(category.estimated_usd_ticks, category.estimated_usd_ticks != null)}</span>
							{#if category.kinds.length > 1}
								<button
									type="button"
									class="quiet"
									aria-expanded={expanded[category.category] ? 'true' : 'false'}
									onclick={() => toggleCategory(category.category)}
								>
									{expanded[category.category] ? copy.collapse : copy.expand}
								</button>
							{/if}
						</div>
						{#if expanded[category.category]}
							<ul class="kinds">
								{#each category.kinds as kind (kind.kind)}
									<li>
										<button type="button" class="link" onclick={() => drillKind(kind.kind)}>
											{copy.kind[kind.kind]}
										</button>
										<span class="num">{num(kind.total_tokens)}</span>
										<span class="num">{money(kind.reported_usd_ticks)}</span>
										<span class="num" title={estimateNote(kind) ?? undefined}>{money(kind.estimated_usd_ticks, kind.estimated_usd_ticks != null)}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</li>
				{/each}
			</ul>
		</section>

		<section class="block" aria-label={copy.trend}>
			<div class="block-head">
				<h2>{copy.trend}</h2>
				<div class="ranges" role="group" aria-label={copy.trend}>
					<button type="button" class:is-on={view.metric === 'tokens'} aria-pressed={view.metric === 'tokens'} onclick={() => (view.metric = 'tokens')}>
						{copy.metricTokens}
					</button>
					<button type="button" class:is-on={view.metric === 'money'} aria-pressed={view.metric === 'money'} onclick={() => (view.metric = 'money')}>
						{copy.metricMoney}
					</button>
				</div>
			</div>
			{#if days.length === 0}
				<p class="note">{copy.empty}</p>
			{:else if view.metric === 'tokens'}
				<ul class="legend">
					{#each ['turn', 'judgement', 'decision', 'feedback', 'other'] as category (category)}
						<li><span class="swatch is-{category}"></span>{copy.category[category as 'turn']}</li>
					{/each}
				</ul>
				<div class="trend">
					{#each days as day (day.id)}
						<div class="bar">
							<div class="stack" role="img" aria-label={tokenParts(day).map((part) => part.label).join(', ') || day.id}>
								{#each tokenParts(day) as part (`${day.id}-${part.key}`)}
									<span class="seg is-{part.category}" style:height="{part.height}%" title={part.label}><span class="sr">{part.label}</span></span>
								{/each}
							</div>
							<span class="day-label">{(day.id ?? '').slice(5)}</span>
						</div>
					{/each}
				</div>
			{:else}
				<ul class="legend">
					{#each ['turn', 'judgement', 'decision', 'feedback', 'other'] as category (category)}
						<li><span class="swatch is-{category}"></span>{copy.category[category as 'turn']}</li>
					{/each}
				</ul>
				<div class="money-trend">
					<div class="money-col">
						<p class="note">{copy.reportedStack}</p>
						<div class="trend" aria-label={copy.reportedStack}>
							{#each days as day (day.id)}
								{@const parts = moneyParts(day, 'reported_usd_ticks', reportedScale)}
								<div class="bar">
									<div class="stack" role="img" aria-label={parts.map((part) => part.label).join(', ') || `${day.id} ${copy.reportedStack}`}>
										{#each parts as part (`${day.id}-reported-${part.key}`)}
											<span class="seg is-{part.category}" style:height="{part.height}%" title={part.label}><span class="sr">{part.label}</span></span>
										{/each}
									</div>
									<span class="day-label">{(day.id ?? '').slice(5)}</span>
								</div>
							{/each}
						</div>
					</div>
					<div class="money-col">
						<p class="note">{copy.estimatedStack}</p>
						<div class="trend" aria-label={copy.estimatedStack}>
							{#each days as day (day.id)}
								{@const parts = moneyParts(day, 'estimated_usd_ticks', estimatedScale)}
								<div class="bar">
									<div class="stack is-estimated" role="img" aria-label={parts.map((part) => part.label).join(', ') || `${day.id} ${copy.estimatedStack}`}>
										{#each parts as part (`${day.id}-estimated-${part.key}`)}
											<span class="seg is-{part.category} is-estimated" style:height="{part.height}%" title={part.label}><span class="sr">{part.label}</span></span>
										{/each}
									</div>
									<span class="day-label">{(day.id ?? '').slice(5)}</span>
								</div>
							{/each}
						</div>
					</div>
				</div>
			{/if}
		</section>

		<section class="block" aria-label={copy.dimension}>
			<div class="block-head">
				<h2>{copy.dimension}</h2>
				<div class="ranges" role="group" aria-label={copy.dimension}>
					{#each dimensions as dimension (dimension)}
						<button
							type="button"
							class:is-on={view.dimension === dimension}
							aria-pressed={view.dimension === dimension}
							onclick={() => (view.dimension = dimension)}
						>
							{copy.dimensions[dimension]}
						</button>
					{/each}
				</div>
			</div>
			<div class="table-scroll">
				<table>
					<thead>
						<tr>
							{#each columns as column (column.key)}
								<th>
									<button type="button" class="sort" aria-label={copy.sortBy(columnLabel(column))} onclick={() => sortBy(column.key)}>
										{columnLabel(column)}{sortMark(column.key)}
									</button>
								</th>
							{/each}
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each sortedGroups as group (`${group.id ?? 'null'}-${group.provider_id ?? ''}-${group.model ?? ''}`)}
							<tr class:is-deleted={group.deleted}>
								<td>
									{#if groupsActionable}
										<button type="button" class="link" onclick={() => drillGroup(group)}>
											{groupLabel(group)}
										</button>
									{:else}
										<span>{groupLabel(group)}</span>
									{/if}
									{#if group.deleted}<span class="deleted">{copy.deleted}</span>{/if}
								</td>
								<td class="num">{formatTokens(group.calls)}</td>
								<td class="num">{num(group.input_tokens)}</td>
								<td class="num">{num(group.output_tokens)}</td>
								<td class="num">{num(group.total_tokens)}</td>
								<td class="num">{money(group.reported_usd_ticks)}</td>
								<td class="num" title={estimateNote(group) ?? undefined}>{money(group.estimated_usd_ticks, group.estimated_usd_ticks != null)}</td>
								<td>
									{#if groupsActionable && shownDimension === 'session' && group.id && !group.deleted && onOpenSession}
										<button type="button" class="quiet" onclick={() => onOpenSession?.(group.id!)}>{copy.openSession}</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section class="block" aria-label={copy.details}>
			<h2>{copy.details}</h2>
			<div class="table-scroll">
				<table>
					<thead>
						<tr>
							<th>{copy.time}</th>
							<th>{copy.categories}</th>
							<th>{copy.session}</th>
							<th>{copy.bot}</th>
							<th>{copy.model}</th>
							<th>{copy.totalTokens}</th>
							<th>{copy.amount}</th>
						</tr>
					</thead>
					<tbody>
						{#each details as row (row.id)}
							<tr class:is-deleted={row.session_deleted || row.bot_deleted}>
								<td class="num">
									{#if row.trigger_message_id && !row.session_deleted && onOpenTrigger}
										<button type="button" class="link" onclick={() => onOpenTrigger?.(row.session_id, row.trigger_message_id!)}>
											{row.created_at}
										</button>
									{:else}
										{row.created_at}
									{/if}
								</td>
								<td>{copy.kind[row.kind]}</td>
								<td>
									{detailSession(row)}
									{#if row.session_deleted}<span class="deleted">{copy.deleted}</span>{/if}
								</td>
								<td>
									{detailBot(row)}
									{#if row.bot_deleted}<span class="deleted">{copy.deleted}</span>{/if}
								</td>
								<td>{detailModel(row)}</td>
								<td class="num">{num(row.total_tokens)}</td>
								<td class="num" title={amountTitle(row)}>{detailAmount(row)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if nextCursor}
				<button type="button" class="more" disabled={loadingMore} onclick={() => void loadMore()}>{copy.loadMore}</button>
			{/if}
		</section>
	{/if}
</section>

<style>
	.spend {
		container: spend / inline-size;
		display: flex;
		flex-direction: column;
		gap: 16px;
		height: 100%;
		min-width: 0;
		min-height: 0;
		overflow: auto;
		padding: 16px;
		background: var(--pane);
		color: var(--ink);
		font-family: var(--font);
	}

	.spend-head,
	.block-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
	}

	h1,
	h2 {
		margin: 0;
		font-weight: 650;
		letter-spacing: -0.01em;
	}

	h1 {
		font-size: 15px;
	}

	h2 {
		font-size: 13px;
		color: var(--ink-secondary);
	}

	.ranges {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.ranges button,
	.quiet,
	.more,
	.sort,
	.status button {
		min-height: 44px;
		padding: 0 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--btn-secondary-bg);
		color: var(--ink);
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 44px;
		padding: 0 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--btn-secondary-bg);
		color: var(--ink);
	}

	.ranges button.is-on {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.date {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--muted);
	}

	.date input {
		min-height: 44px;
		padding: 0 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
	}

	.field-error {
		flex-basis: 100%;
		margin: 0;
		color: var(--danger);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 44px;
		padding: 0 12px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--chip);
		color: var(--ink);
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.status {
		margin: 0;
		color: var(--muted);
	}

	.status button {
		margin-top: 8px;
	}

	.block {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--line-subtle);
	}

	.figures {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 8px 16px;
		margin: 0;
	}

	.figures div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	dt {
		color: var(--muted);
		font-size: 12px;
	}

	dd {
		margin: 0;
	}

	.num {
		font-variant-numeric: tabular-nums;
		font-family: var(--mono);
	}

	.note {
		margin: 0;
		color: var(--muted);
	}

	.categories,
	.kinds {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.category-row,
	.kinds li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 16px;
	}

	.kinds {
		padding-left: 16px;
	}

	.link {
		min-height: 44px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		text-align: left;
	}

	.quiet,
	.sort,
	.more {
		background: transparent;
	}

	.sort {
		border: 0;
		padding: 0 4px;
		color: var(--muted);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 12px;
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--muted);
		font-size: 12px;
	}

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.swatch {
		width: 10px;
		height: 10px;
		background: var(--accent);
	}

	.swatch.is-judgement {
		background: var(--purple);
	}

	.swatch.is-decision {
		background: var(--ok);
	}

	.swatch.is-feedback {
		background: var(--warn);
	}

	.swatch.is-other {
		background: var(--muted-light);
	}

	.money-trend {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.money-col {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.trend {
		display: flex;
		align-items: flex-end;
		gap: 4px;
		min-height: 120px;
		overflow-x: auto;
	}

	.bar {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		min-width: 28px;
		flex: 1 0 28px;
	}

	.stack {
		display: flex;
		flex-direction: column-reverse;
		justify-content: flex-start;
		width: 100%;
		height: 96px;
	}

	.seg {
		display: block;
		width: 100%;
		min-height: 2px;
		background: var(--accent);
	}

	.seg.is-judgement {
		background: var(--purple);
	}

	.seg.is-decision {
		background: var(--ok);
	}

	.seg.is-feedback {
		background: var(--warn);
	}

	.seg.is-other {
		background: var(--muted-light);
	}

	.stack.is-estimated .seg,
	.seg.is-estimated {
		background-image: repeating-linear-gradient(-45deg, transparent, transparent 2px, var(--pane) 2px, var(--pane) 4px);
	}

	.day-label {
		color: var(--muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.table-scroll {
		overflow-x: auto;
		max-width: 100%;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}

	th,
	td {
		padding: 4px 8px;
		border-bottom: 1px solid var(--line-subtle);
		text-align: left;
		white-space: nowrap;
	}

	th {
		color: var(--muted);
		font-weight: 500;
	}

	tr.is-deleted {
		color: var(--muted);
	}

	.deleted {
		margin-left: 6px;
		color: var(--muted);
		font-size: 12px;
	}

	@container spend (max-width: 640px) {
		.figures {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.back span {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
		}

		.back {
			width: 44px;
			justify-content: center;
			padding: 0;
		}
	}
</style>
