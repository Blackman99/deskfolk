<script lang="ts">
	import SpendIcon from './SpendIcon.svelte';
	import type { SpendTotals } from '@real-bot/protocol';
	import type { SpendCopy } from './spend-copy.ts';

	interface Props {
		copy: SpendCopy;
		locale: 'zh' | 'en';
		totals: SpendTotals;
		num: (value: number | null) => string;
		money: (ticks: number | null, estimated?: boolean) => string;
	}

	let { copy, locale, totals, num, money }: Props = $props();

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
</script>

<section class="overview-summary surface" aria-label={copy.totals}>
	<div class="summary-top">
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

		<dl class="summary-stats">
			<div>
				<dt>{copy.calls}</dt>
				<dd class="num">{totals.calls.toLocaleString(locale)}</dd>
			</div>
			{#if sides.length}
				<div>
					<dt>{copy.totalTokens}</dt>
					<dd class="num" title={totals.total_tokens?.toLocaleString(locale)}>{num(totals.total_tokens)}</dd>
				</div>
			{/if}
		</dl>
	</div>

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
</section>

<style>
	p, dl, dd, dt {
		margin: 0;
	}

	.overview-summary {
		display: flex;
		flex-direction: column;
	}

	.summary-top {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 16px 32px;
		padding: 18px 20px 16px;
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
		font-size: clamp(30px, 4cqi, 38px);
		line-height: 1.15;
		font-weight: 700;
		letter-spacing: -0.03em;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}

	.is-pair .amount-number {
		font-size: clamp(24px, 3cqi, 30px);
	}

	.metric-foot {
		font-size: 12px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.summary-stats {
		display: flex;
		gap: 28px;
		padding-bottom: 3px;
	}

	.summary-stats div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.summary-stats dt {
		font-size: 12px;
		color: var(--muted);
	}

	.summary-stats dd {
		font-size: 17px;
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--ink);
	}

	.token-breakdown {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 36px;
		padding: 12px 20px;
		border-top: 1px solid var(--line-subtle);
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
		.summary-top {
			padding: 16px 16px 14px;
			align-items: flex-start;
			flex-direction: column;
			gap: 14px;
		}

		.amount-number {
			font-size: 32px;
		}

		.is-pair .amount-number {
			font-size: 24px;
		}

		.money-summary {
			gap: 12px 28px;
		}

		.summary-stats dd {
			font-size: 15px;
		}

		.token-breakdown {
			flex-direction: column;
			padding: 12px 16px;
			gap: 6px;
		}

		.coverage > summary {
			padding: 10px 16px;
		}

		.coverage-body {
			padding: 0 16px 12px 38px;
		}
	}
</style>
