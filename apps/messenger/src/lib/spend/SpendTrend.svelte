<script lang="ts">
	import type { SpendCategory, SpendGroup } from '@real-bot/protocol';
	import { formatTokens, formatUsd } from '../spend-format.ts';
	import { spendCopyFor } from './spend-copy.ts';
	import {
		SPEND_TREND_CATEGORIES,
		bucketSpendDays,
		spendTrendCategoryValue,
		spendTrendMax,
		type SpendTrendBucket,
		type SpendTrendField
	} from './spend-trend.ts';

	/** Host-agnostic daily trend. Width is the component's own box, not the window. */
	interface Props {
		days: SpendGroup[];
		metric: 'tokens' | 'money';
		locale: 'zh' | 'en';
		/** Inclusive `from` and exclusive `to`, both UTC instants. Leading and trailing days stay on the axis. */
		range?: { from?: string; to?: string };
		/** IANA zone the range is named in. Defaults to UTC. */
		timeZone?: string;
	}

	let { days, metric, locale, range, timeZone = 'UTC' }: Props = $props();

	const copy = $derived(spendCopyFor(locale));

	/** Chart words that the ledger copy does not already name. */
	const chartCopy = $derived(
		locale === 'en'
			? {
					unknown: 'Unknown',
					zero: '0',
					range: (from: string, to: string) => `${from} – ${to}`,
					plot: 'Trend plot',
					missing: 'Missing'
				}
			: {
					unknown: '未知',
					zero: '0',
					range: (from: string, to: string) => `${from} 至 ${to}`,
					plot: '趋势图',
					missing: '缺失'
				}
	);

	const buckets = $derived(bucketSpendDays(days, undefined, range, timeZone));
	const scopeKey = $derived(
		`${range?.from ?? ''}/${range?.to ?? ''}/${timeZone}|` + buckets.map((bucket) => `${bucket.id ?? ''}:${bucket.dayCount}`).join('|')
	);
	/** A span that crosses a year boundary names the year, so Jan 1 of two years cannot look like one day. */
	const spansYears = $derived.by(() => {
		const years = new Set<string>();
		for (const bucket of buckets) {
			if (bucket.from) years.add(bucket.from.slice(0, 4));
			if (bucket.to) years.add(bucket.to.slice(0, 4));
		}
		return years.size > 1;
	});

	/** Which bar each plot is showing. Money has two plots; they do not share a selection. */
	let selected = $state<Record<string, number | null>>({});
	/** The plot whose values the readout is repeating. */
	let readoutPlot = $state<string | null>(null);

	/** A new range, metric, or locale is a different chart. The old bar is not still selected. */
	$effect(() => {
		void scopeKey;
		void metric;
		void locale;
		selected = {};
		readoutPlot = null;
	});

	const tokenScale = $derived(spendTrendMax(buckets, 'total_tokens'));
	const moneyScale = $derived(Math.max(spendTrendMax(buckets, 'reported_usd_ticks'), spendTrendMax(buckets, 'estimated_usd_ticks')));

	const labelIndexes = $derived.by(() => {
		const last = buckets.length - 1;
		if (last < 0) return [];
		if (last === 0) return [0];
		const mid = Math.floor(last / 2);
		return mid === 0 || mid === last ? [0, last] : [0, mid, last];
	});

	function formatDay(id: string | null, withYear: boolean): string {
		if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(id)) return copy.dash;
		const [year, month, day] = id.split('-').map(Number);
		const date = new Date(Date.UTC(year!, month! - 1, day));
		return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
			month: 'short',
			day: 'numeric',
			...(withYear ? { year: 'numeric' as const } : {}),
			timeZone: 'UTC'
		}).format(date);
	}

	/**
	 * A chart, or a bar, that crosses a year names the year on the axis, the readout, and the bar.
	 * Both ends of one bar are named when they fall in different years.
	 */
	function bucketLabel(bucket: SpendTrendBucket): string {
		const fromYear = bucket.from?.slice(0, 4);
		const toYear = bucket.to?.slice(0, 4);
		const crosses = fromYear != null && toYear != null && fromYear !== toYear;
		const years = spansYears || crosses;
		if (bucket.dayCount > 1 && bucket.from && bucket.to && bucket.from !== bucket.to) {
			return chartCopy.range(formatDay(bucket.from, years), formatDay(bucket.to, years));
		}
		return formatDay(bucket.from ?? bucket.id, years);
	}

	function amount(field: SpendTrendField, value: number | null): string {
		if (value == null) return copy.dash;
		if (field === 'total_tokens') return formatTokens(value);
		return formatUsd(value);
	}

	function categoryLine(bucket: SpendTrendBucket, category: SpendCategory, field: SpendTrendField): string {
		const value = spendTrendCategoryValue(bucket, category, field);
		const text = amount(field, value);
		const name = copy.category[category];
		return field === 'total_tokens' ? copy.dayTokens(bucketLabel(bucket), name, text) : copy.dayAmount(bucketLabel(bucket), name, text);
	}

	function plotLabel(bucket: SpendTrendBucket, field: SpendTrendField): string {
		const head = field === 'reported_usd_ticks' ? copy.reportedStack : field === 'estimated_usd_ticks' ? copy.estimatedStack : copy.metricTokens;
		const parts = SPEND_TREND_CATEGORIES.map((category) => categoryLine(bucket, category, field));
		const total = amount(field, bucket[field]);
		return `${head} ${bucketLabel(bucket)} ${total}. ${parts.join(', ')}`;
	}

	function yMax(field: SpendTrendField): string {
		const scale = field === 'total_tokens' ? tokenScale : moneyScale;
		if (scale <= 0) return copy.dash;
		if (field === 'total_tokens') return formatTokens(scale);
		const usd = scale / 10_000_000_000;
		if (usd === 0) return '$0';
		if (Math.abs(usd) >= 1000) return `$${trimAxis(usd / 1000)}k`;
		if (Math.abs(usd) >= 100) return `$${Math.round(usd)}`;
		if (Math.abs(usd) >= 1) return `$${trimAxis(usd)}`;
		return formatUsd(scale);
	}

	function trimAxis(value: number): string {
		const text = value.toFixed(1);
		return text.endsWith('.0') ? text.slice(0, -2) : text;
	}

	function segments(bucket: SpendTrendBucket, field: SpendTrendField, scale: number): { category: SpendCategory; height: number }[] {
		return SPEND_TREND_CATEGORIES.map((category) => {
			const value = spendTrendCategoryValue(bucket, category, field);
			const height = value != null && value > 0 && scale > 0 ? (value / scale) * 100 : 0;
			return { category, height };
		});
	}

	function chosen(plotKey: string): number | null {
		return selected[plotKey] ?? null;
	}

	function select(plotKey: string, index: number): void {
		selected = { ...selected, [plotKey]: index };
		readoutPlot = plotKey;
	}

	function move(event: KeyboardEvent, plotKey: string, index: number): void {
		const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
		const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
		if (!forward && !back && event.key !== 'Home' && event.key !== 'End') return;
		event.preventDefault();
		const last = buckets.length - 1;
		const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : forward ? Math.min(last, index + 1) : Math.max(0, index - 1);
		select(plotKey, next);
		const plot = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest('[data-plot]') : null;
		plot?.querySelector<HTMLElement>(`#${plotKey}-bar-${next}`)?.focus();
	}
</script>

{#snippet plot(field: SpendTrendField, scale: number, title: string, plotKey: string, estimated = false)}
	<figure class="plot m-0 min-w-0 flex flex-col gap-2" data-plot={plotKey} aria-label={title || chartCopy.plot}>
		{#if title}
			<figcaption class="text-12 text-muted m-0">{title}</figcaption>
		{/if}
		<div class="plot-frame flex items-stretch gap-2 min-w-0">
			<div class="y-axis flex flex-col justify-between items-end shrink-0 text-11 text-muted tabular" aria-hidden="true">
				<span>{yMax(field)}</span>
				<span>{scale > 0 ? chartCopy.zero : copy.dash}</span>
			</div>
			<div class="plot-main flex-1 min-w-0 flex flex-col">
				<div
					class="bars min-w-0 flex items-end"
					role="listbox"
					aria-label={title || chartCopy.plot}
					aria-orientation="horizontal"
				>
					{#each buckets as bucket, index (plotKey + (bucket.id ?? 'none') + index)}
						{@const parts = segments(bucket, field, scale)}
						{@const active = chosen(plotKey) === index}
						<button
							type="button"
							id="{plotKey}-bar-{index}"
							class="bar"
							class:is-selected={active}
							role="option"
							aria-selected={active}
							aria-label={plotLabel(bucket, field)}
							tabindex={chosen(plotKey) === null ? (index === 0 ? 0 : -1) : active ? 0 : -1}
							onclick={() => select(plotKey, index)}
							onpointerenter={() => select(plotKey, index)}
							onfocus={() => select(plotKey, index)}
							onkeydown={(event) => move(event, plotKey, index)}
						>
							<span class="stack" class:is-estimated={estimated} aria-hidden="true">
								{#each parts as part (part.category)}
									{#if part.height > 0}
										<span class="seg is-{part.category}" style:height="{part.height}%"></span>
									{/if}
								{/each}
								{#if bucket[field] == null}
									<span class="missing" title={chartCopy.missing}></span>
								{:else if bucket[field] === 0}
									<span class="zero"></span>
								{/if}
							</span>
						</button>
					{/each}
				</div>
				<div class="axis-row flex justify-between gap-1 min-w-0">
					{#each labelIndexes as index (index)}
						<span class="axis-label tabular">{bucketLabel(buckets[index]!)}</span>
					{/each}
				</div>
			</div>
		</div>
	</figure>
{/snippet}

<section class="spend-trend flex flex-col gap-3 min-w-0 text-ink" aria-label={copy.trend} data-spend-trend>
	{#if buckets.length === 0}
		<p class="m-0 text-muted">{copy.empty}</p>
	{:else}
		<ul class="legend flex flex-wrap gap-x-5 gap-y-3 m-0 p-0 list-none text-12 text-muted">
			{#each SPEND_TREND_CATEGORIES as category (category)}
				<li class="inline-flex items-center gap-1">
					<span class="swatch is-{category}" aria-hidden="true"></span>
					{copy.category[category]}
				</li>
			{/each}
		</ul>

		{#if metric === 'tokens'}
			{@render plot('total_tokens', tokenScale, '', 'tokens')}
		{:else}
			<div class="money">
				{@render plot('reported_usd_ticks', moneyScale, copy.reportedStack, 'reported')}
				{@render plot('estimated_usd_ticks', moneyScale, copy.estimatedStack, 'estimated', true)}
			</div>
		{/if}

		{#if readoutPlot && chosen(readoutPlot) != null && buckets[chosen(readoutPlot)!]}
			{@const bucket = buckets[chosen(readoutPlot)!]}
			<div class="readout flex flex-col gap-1 p-3 text-12" aria-live="polite" data-readout={readoutPlot}>
				<p class="m-0 font-medium text-ink-secondary">{bucketLabel(bucket)}</p>
				{#if readoutPlot === 'tokens'}
					<p class="m-0 text-muted">{copy.metricTokens}</p>
					<ul class="m-0 p-0 list-none flex flex-col gap-1">
						{#each SPEND_TREND_CATEGORIES as category (category)}
							{@const value = spendTrendCategoryValue(bucket, category, 'total_tokens')}
							<li class="flex items-center justify-between gap-3 min-w-0">
								<span class="inline-flex items-center gap-1 min-w-0">
									<span class="swatch is-{category}" aria-hidden="true"></span>
									<span class="truncate">{copy.category[category]}</span>
								</span>
								<span class="tabular shrink-0" class:text-muted={value == null}>
									{value == null ? `${copy.dash} ${chartCopy.unknown}` : formatTokens(value)}
								</span>
							</li>
						{/each}
					</ul>
				{:else}
					{@const field: SpendTrendField = readoutPlot === 'estimated' ? 'estimated_usd_ticks' : 'reported_usd_ticks'}
					<div class="min-w-0">
						<p class="m-0 text-muted">{field === 'reported_usd_ticks' ? copy.reported : copy.estimated}</p>
						<ul class="m-0 p-0 list-none flex flex-col gap-1">
							{#each SPEND_TREND_CATEGORIES as category (category)}
								{@const value = spendTrendCategoryValue(bucket, category, field)}
								<li class="flex items-center justify-between gap-2 min-w-0">
									<span class="inline-flex items-center gap-1 min-w-0">
										<span class="swatch is-{category}" aria-hidden="true"></span>
										<span class="truncate">{copy.category[category]}</span>
									</span>
									<span class="tabular shrink-0" class:text-muted={value == null}>
										{value == null ? `${copy.dash} ${chartCopy.unknown}` : formatUsd(value)}
									</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</section>

<style>
	.spend-trend {
		container: spend-trend / inline-size;
		max-width: 100%;
		overflow-x: hidden;
	}

	.tabular {
		font-family: var(--font);
		font-variant-numeric: tabular-nums;
	}

	.swatch {
		width: 8px;
		height: 8px;
		border-radius: 2px;
		background: var(--accent);
		flex: none;
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

	.y-axis {
		width: max-content;
		max-width: 52px;
		height: 180px;
		line-height: 1;
	}

	.bars {
		height: 180px;
		gap: 3px;
		background-image: linear-gradient(to bottom, var(--line-subtle) 1px, transparent 1px);
		background-size: 100% 25%;
		border-bottom: 1px solid var(--line);
	}

	.bar {
		position: relative;
		display: flex;
		flex: 1 1 0;
		flex-direction: column;
		align-items: center;
		justify-content: flex-end;
		min-width: 0;
		height: 100%;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
	}

	.bar:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--accent);
	}

	.bar.is-selected {
		background: var(--accent-tint);
	}

	.stack {
		display: flex;
		flex-direction: column-reverse;
		width: 100%;
		max-width: 32px;
		height: 100%;
		border-radius: 3px 3px 0 0;
		overflow: hidden;
	}

	.seg {
		display: block;
		width: 100%;
		min-height: 1px;
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

	.stack.is-estimated .seg {
		background-image: repeating-linear-gradient(
			-45deg,
			transparent,
			transparent 2px,
			color-mix(in srgb, var(--pane) 45%, transparent) 2px,
			color-mix(in srgb, var(--pane) 45%, transparent) 3px
		);
	}

	.missing,
	.zero {
		position: absolute;
		left: 50%;
		bottom: 0;
		width: 6px;
		height: 6px;
		transform: translateX(-50%);
		border-radius: 999px;
	}

	.missing {
		background: var(--muted-light);
		box-shadow: 0 0 0 2px var(--pane);
	}

	.zero {
		width: 10px;
		height: 2px;
		border-radius: 1px;
		background: var(--ink-secondary);
	}

	.axis-label {
		min-width: 0;
		overflow: hidden;
		color: var(--muted);
		font-size: 10px;
		line-height: 14px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.axis-label:nth-child(2) {
		text-align: center;
	}

	.axis-label:last-child {
		text-align: right;
	}

	.money {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}

	.readout {
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
	}

	@container spend-trend (min-width: 560px) {
		.money {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			align-items: start;
		}

		.axis-label {
			font-size: 11px;
		}
	}

	@container spend-trend (max-width: 450px) { .bars, .y-axis { height: 150px; } .stack { max-width: 24px; } }
</style>
