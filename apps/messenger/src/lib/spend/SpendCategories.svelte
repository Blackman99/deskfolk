<script lang="ts">
	import SpendIcon from './SpendIcon.svelte';
	import SpendTrend from './SpendTrend.svelte';
	import type { SpendSummary } from '@real-bot/protocol';
	import type { SpendCopy } from './spend-copy.ts';
	import type { SpendLedger } from './spend-ledger.svelte.ts';

	interface Props {
		copy: SpendCopy;
		locale: 'zh' | 'en';
		timeZone: string;
		ledger: SpendLedger;
		categories: SpendSummary['categories'];
		num: (value: number | null) => string;
		money: (ticks: number | null, estimated?: boolean) => string;
	}

	let { copy, locale, timeZone, ledger, categories, num, money }: Props = $props();

	function categoryWidth(value: number | null): number {
		const maximum = Math.max(0, ...(ledger.summary?.categories.map((row) => row.total_tokens ?? 0) ?? []));
		return value != null && maximum > 0 ? (value / maximum) * 100 : 0;
	}
</script>

<div class="analysis-grid">
	<section class="surface trend-surface" aria-label={copy.trend}>
		<div class="section-head">
			<div class="section-head-title">
				<h2>{copy.trend}</h2>
			</div>
			<div class="segmented" role="group" aria-label={copy.trend}>
				<button
					type="button"
					aria-pressed={ledger.view.metric === 'tokens'}
					onclick={() => (ledger.view.metric = 'tokens')}
				>
					{copy.metricTokens}
				</button>
				<button
					type="button"
					aria-pressed={ledger.view.metric === 'money'}
					onclick={() => (ledger.view.metric = 'money')}
				>
					{copy.metricMoney}
				</button>
			</div>
		</div>
		<div class="trend-content">
			<SpendTrend days={ledger.days} metric={ledger.view.metric} {locale} range={ledger.askedWindow} {timeZone} />
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
			{#each categories as category (category.category)}
				<li class="category-item">
					<div class="category-row">
						<button
							type="button"
							class="category-name"
							disabled={ledger.loading}
							onclick={() => ledger.drillCategory(category.category)}
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
								aria-expanded={!!ledger.expanded[category.category]}
								onclick={() => ledger.toggleCategory(category.category)}
							>
								<SpendIcon name="chevron" />
							</button>
						{/if}
					</div>
					{#if ledger.expanded[category.category]}
						<ul class="kinds">
							{#each category.kinds as kind (kind.kind)}
								<li class="kind-item">
									<button
										type="button"
										class="text-action kind-name"
										disabled={ledger.loading}
										onclick={() => ledger.drillKind(kind.kind)}
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

<style>
	/* The direct children of the scroll area: SpendView's `.spend-scroll > *` cannot reach them from here. */
	.analysis-grid {
		flex-shrink: 0;
		min-width: 0;
	}

	h2 {
		margin: 0;
	}

	h2 {
		font-size: 14px;
		line-height: 1.4;
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--ink);
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
		border-radius: var(--radius-xs);
		color: var(--muted);
		min-height: 28px;
		padding: 3px 12px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
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
		border-radius: var(--radius-full);
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
		border-radius: var(--radius-xs);
		margin-left: auto;
		background: var(--pane);
		color: var(--muted);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.kind-toggle:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.kind-toggle[aria-expanded='true'] :global(svg) {
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
		font-size: 11px;
		color: var(--muted);
	}

	.num {
		font-variant-numeric: tabular-nums;
		font-size: 13px;
	}

	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	@container spend (min-width: 1000px) {
		.analysis-grid {
			grid-template-columns: minmax(0, 1.75fr) minmax(320px, 1fr);
			align-items: start;
		}
	}

	@container spend (max-width: 620px) {
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
	}
</style>
