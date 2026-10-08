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
		tokenMetrics: (row: Pick<SpendTotals, 'input_tokens' | 'cached_tokens' | 'output_tokens' | 'reasoning_tokens'>) => { label: string; value: number | null }[];
	}

	let { copy, locale, totals, num, money, tokenMetrics }: Props = $props();
</script>

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
				<span class="coverage-icon" aria-hidden="true"><SpendIcon name="info" /></span>
				{copy.coverage}
			</span>
			<span class="coverage-summary">
				{totals.missing_usage_calls ? copy.missingUsage(totals.missing_usage_calls) : copy.estimateCoverage(totals.reported_calls, totals.estimated_calls)}
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
	/* The direct children of the scroll area: SpendView's `.spend-scroll > *` cannot reach them from here. */
	.overview-summary {
		flex-shrink: 0;
		min-width: 0;
	}

	p, dl, dd, dt {
		margin: 0;
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

	.coverage[open] .coverage-chevron {
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

	summary:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	@container spend (max-width: 800px) {
		.summary-cards {
			grid-template-columns: 1fr;
		}
	}

	@container spend (max-width: 620px) {
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
	}

	@container spend (max-width: 360px) {
		.money-summary {
			grid-template-columns: 1fr;
			gap: 8px;
		}
	}
</style>
