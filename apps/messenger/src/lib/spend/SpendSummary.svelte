<script lang="ts">
	import type { Snippet } from 'svelte';
	import SpendIcon from './SpendIcon.svelte';
	import type { SpendTotals } from '@real-bot/protocol';
	import type { SpendCopy } from './spend-copy.ts';

	interface Props {
		copy: SpendCopy;
		locale: 'zh' | 'en';
		totals: SpendTotals;
		num: (value: number | null) => string;
		money: (ticks: number | null, estimated?: boolean) => string;
		/** One more tile at the end of the row: the day's cap. */
		extra?: Snippet;
	}

	let { copy, locale, totals, num, money, extra }: Props = $props();

	/**
	 * The money leads. A side nothing was priced on takes no room: the coverage line under it says
	 * how many calls each side covers. Both sides show side by side, never added.
	 */
	const sides = $derived(
		[
			{ key: 'reported', label: copy.reported, ticks: totals.reported_usd_ticks, calls: totals.reported_calls },
			{ key: 'estimated', label: copy.estimated, ticks: totals.estimated_usd_ticks, calls: totals.estimated_calls }
		].filter((side) => side.ticks != null)
	);

	/** One side covering every call says nothing the call count does not. */
	function footOf(side: (typeof sides)[number]): string | null {
		return sides.length > 1 || side.calls !== totals.calls ? copy.coveredCalls(side.calls) : null;
	}

	/** Cached is inside input and reasoning inside output: the bar splits each in two, never adds them on. */
	const mix = $derived.by(() => {
		const input = totals.input_tokens ?? 0;
		const output = totals.output_tokens ?? 0;
		const cached = Math.min(input, totals.cached_tokens ?? 0);
		const reasoning = Math.min(output, totals.reasoning_tokens ?? 0);
		const whole = input + output;
		if (whole <= 0) return [];
		return [
			{ key: 'cached', label: copy.cached, value: cached },
			{ key: 'fresh', label: copy.freshInput, value: input - cached },
			{ key: 'output', label: copy.plainOutput, value: output - reasoning },
			{ key: 'reasoning', label: copy.reasoning, value: reasoning }
		]
			.filter((part) => part.value > 0)
			.map((part) => ({ ...part, share: (part.value / whole) * 100 }));
	});

	const cacheHit = $derived(
		totals.input_tokens && totals.cached_tokens ? Math.min(1, totals.cached_tokens / totals.input_tokens) : null
	);

	function percent(share: number): string {
		return share >= 10 || share === 0 ? `${Math.round(share)}%` : share >= 0.1 ? `${share.toFixed(1)}%` : '<0.1%';
	}
</script>

<section class="overview-summary" aria-label={copy.totals}>
	<div class="kpi-grid">
		<div class="surface kpi kpi-money" class:is-pair={sides.length > 1}>
			{#if sides.length}
				<div class="money-summary" class:is-pair={sides.length > 1}>
					{#each sides as side (side.key)}
						{@const foot = footOf(side)}
						<div class="money-col is-{side.key}">
							<span class="metric-label">
								<i class="amount-dot" class:is-estimated={side.key === 'estimated'}></i>
								{side.label}
							</span>
							<strong class="amount-number">{money(side.ticks)}</strong>
							{#if foot}
								<span class="metric-foot">{foot}</span>
							{/if}
						</div>
					{/each}
				</div>
			{:else}
				<div class="money-summary">
					<div class="money-col">
						<span class="metric-label">{copy.totalTokens}</span>
						<strong class="amount-number" title={totals.total_tokens?.toLocaleString(locale)}>{num(totals.total_tokens)}</strong>
						<span class="metric-foot">{copy.estimateUnavailable}</span>
					</div>
				</div>
			{/if}
		</div>

		<dl class="surface kpi">
			<dt class="metric-label">{copy.calls}</dt>
			<dd class="kpi-value num">{totals.calls.toLocaleString(locale)}</dd>
		</dl>
		{#if sides.length}
			<dl class="surface kpi">
				<dt class="metric-label">{copy.totalTokens}</dt>
				<dd class="kpi-value num" title={totals.total_tokens?.toLocaleString(locale)}>{num(totals.total_tokens)}</dd>
			</dl>
		{/if}
		{#if cacheHit != null}
			<dl class="surface kpi">
				<dt class="metric-label">{copy.cacheHit}</dt>
				<dd class="kpi-value num">{percent(cacheHit * 100)}</dd>
				<dd class="metric-foot num">{copy.cacheHitOf(num(totals.cached_tokens), num(totals.input_tokens))}</dd>
			</dl>
		{/if}
		{@render extra?.()}
	</div>

	<div class="surface usage-card">
		<!-- Cached tokens are part of input and reasoning part of output: they are shown inside them, not beside. -->
		<dl class="token-breakdown" aria-label={copy.usageDetails}>
			<div>
				<dt>{copy.input}</dt>
				<dd class="num" title={totals.input_tokens?.toLocaleString(locale)}>{num(totals.input_tokens)}</dd>
				{#if totals.cached_tokens}
					<dd class="token-part num">{copy.cachedWithin(num(totals.cached_tokens))}</dd>
				{/if}
			</div>
			<div>
				<dt>{copy.output}</dt>
				<dd class="num" title={totals.output_tokens?.toLocaleString(locale)}>{num(totals.output_tokens)}</dd>
				{#if totals.reasoning_tokens}
					<dd class="token-part num">{copy.reasoningWithin(num(totals.reasoning_tokens))}</dd>
				{/if}
			</div>
		</dl>

		{#if mix.length}
			<div class="token-mix" role="img" aria-label="{copy.tokenMix}: {mix.map((part) => `${part.label} ${num(part.value)} ${percent(part.share)}`).join(', ')}">
				<div class="mix-bar" aria-hidden="true">
					{#each mix as part (part.key)}
						<span class="is-{part.key}" style:width="{part.share}%" title="{part.label} {num(part.value)} · {percent(part.share)}"></span>
					{/each}
				</div>
				<ul class="mix-legend" aria-hidden="true">
					{#each mix as part (part.key)}
						<li>
							<i class="swatch is-{part.key}"></i>
							<span class="mix-name">{part.label}</span>
							<span class="mix-value num">{num(part.value)}</span>
							<span class="mix-share num">{percent(part.share)}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<details class="coverage">
			<summary>
				<span class="coverage-icon" aria-hidden="true"><SpendIcon name="info" /></span>
				<span class="coverage-text">
					<span class="coverage-title">{copy.coverage}</span>
					<span class="coverage-summary">
						{totals.missing_usage_calls ? copy.missingUsage(totals.missing_usage_calls) : copy.estimateCoverage(totals.reported_calls, totals.estimated_calls)}
					</span>
				</span>
				<span class="coverage-chevron" aria-hidden="true"><SpendIcon name="chevron" /></span>
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
	</div>
</section>

<style>
	p, dl, dd, dt, ul {
		margin: 0;
	}

	.overview-summary {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	/* The headline figures as tiles, wrapping as a row fills: money and the cap take about twice a figure's room. */
	.kpi-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
	}

	.kpi {
		flex: 1 1 140px;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: 4px;
		padding: 14px 16px;
		min-height: 92px;
		min-width: 0;
	}

	.kpi-money {
		flex: 2 1 240px;
	}

	.kpi-grid > :global(.cap-card) {
		flex: 1.6 1 240px;
		min-width: 0;
	}

	/* A figure stays on one line; a long one is cut, its full value in the title. */
	.kpi-value {
		font-size: 22px;
		line-height: 1.2;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.money-summary {
		display: flex;
		flex-wrap: wrap;
		gap: 12px 36px;
		min-width: 0;
	}

	.money-col {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		min-width: 0;
	}

	.metric-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--muted);
		font-size: 12px;
		font-weight: 550;
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

	.amount-number {
		font-size: 34px;
		line-height: 1.15;
		font-weight: 700;
		letter-spacing: -0.03em;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}

	.is-pair .amount-number {
		font-size: 26px;
	}

	.metric-foot {
		font-size: 12px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.usage-card {
		display: flex;
		flex-direction: column;
	}

	.token-breakdown {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 36px;
		padding: 12px 20px 0;
		font-size: 13px;
	}

	.token-breakdown div {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 2px 8px;
		min-width: 0;
	}

	.token-breakdown dt {
		color: var(--muted);
	}

	.token-breakdown dd {
		font-weight: 600;
		color: var(--ink);
	}

	.token-breakdown .token-part {
		font-size: 12px;
		font-weight: 450;
		color: var(--muted);
	}

	.token-mix {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 20px 14px;
	}

	/* Input in the accent, output in purple; the inner part of each is its paler shade. */
	.mix-bar {
		display: flex;
		gap: 2px;
		height: 12px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--line-subtle);
	}

	.mix-bar span {
		display: block;
		height: 100%;
		min-width: 3px;
	}

	.mix-legend {
		list-style: none;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px 22px;
		font-size: 12px;
	}

	.mix-legend li {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.mix-name {
		color: var(--muted);
	}

	.mix-value {
		font-weight: 600;
		color: var(--ink);
	}

	.mix-share {
		color: var(--muted);
	}

	.swatch {
		width: 8px;
		height: 8px;
		border-radius: 2px;
		flex: none;
	}

	.is-fresh {
		background: var(--accent);
	}

	.is-cached {
		background: color-mix(in srgb, var(--accent) 45%, var(--pane));
	}

	.is-output {
		background: var(--purple);
	}

	.is-reasoning {
		background: color-mix(in srgb, var(--purple) 45%, var(--pane));
	}
	/* Coverage: a quiet last line of the totals, opened in place. */
	.coverage {
		border-top: 1px solid var(--line-subtle);
		color: var(--muted);
		font-size: 12px;
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
		align-items: flex-start;
		gap: 8px;
		padding: 10px 20px;
		line-height: 18px;
	}

	.coverage > summary:hover {
		color: var(--ink-secondary);
	}

	.coverage-icon, .coverage-chevron {
		display: flex;
		align-items: center;
		height: 18px;
		flex: none;
	}

	.coverage-icon :global(svg), .coverage-chevron :global(svg) {
		width: 14px;
		height: 14px;
	}

	.coverage-text {
		flex: 1;
		min-width: 0;
	}

	.coverage-title {
		color: var(--ink-secondary);
		font-weight: 500;
	}

	.coverage-title::after {
		content: '·';
		margin: 0 6px;
		color: var(--muted-light);
	}

	.coverage-chevron {
		transition: transform 0.2s ease;
	}

	.coverage[open] .coverage-chevron {
		transform: rotate(180deg);
	}

	.coverage-body {
		padding: 0 20px 12px 42px;
		line-height: 1.6;
		color: var(--ink-secondary);
	}

	.coverage-body p + p {
		margin-top: 2px;
	}

	@container spend (max-width: 620px) {
		.kpi-grid {
			gap: 10px;
		}

		.kpi-money, .kpi-grid > :global(.cap-card) {
			flex-basis: 100%;
		}

		.overview-summary {
			gap: 12px;
		}

		.kpi {
			flex-basis: 40%;
			padding: 12px 14px;
			min-height: 0;
		}

		.kpi-value {
			font-size: 20px;
		}

		.amount-number {
			font-size: 30px;
		}

		.is-pair .amount-number {
			font-size: 22px;
		}

		.money-summary {
			gap: 12px 28px;
		}

		.token-breakdown {
			flex-direction: column;
			padding: 12px 16px 0;
			gap: 6px;
		}

		.token-mix {
			padding: 12px 16px;
		}

		.coverage > summary {
			padding: 10px 16px;
		}

		.coverage-body {
			padding: 0 16px 12px 38px;
		}
	}
</style>
