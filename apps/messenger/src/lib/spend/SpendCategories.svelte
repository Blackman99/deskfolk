<script lang="ts">
	import SpendAmount from './SpendAmount.svelte';
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
	}

	let { copy, locale, timeZone, ledger, categories, num }: Props = $props();

	/** A category or line nothing was called under takes no row. */
	const shown = $derived(
		categories.filter((row) => row.calls > 0).map((row) => ({ ...row, kinds: row.kinds.filter((kind) => kind.calls > 0) }))
	);

	const whole = $derived(shown.reduce((sum, row) => sum + (row.total_tokens ?? 0), 0));

	function share(value: number | null): number {
		return value != null && whole > 0 ? (value / whole) * 100 : 0;
	}

	function percent(value: number | null): string {
		const part = share(value);
		return part >= 10 || part === 0 ? `${Math.round(part)}%` : part >= 0.1 ? `${part.toFixed(1)}%` : '<0.1%';
	}

	function meta(row: { calls: number; total_tokens: number | null }): string {
		return `${copy.recordedCalls(row.calls)} · ${copy.tokens(num(row.total_tokens))}`;
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
			<span class="bar-note">{copy.barsByTokens}</span>
		</div>
		{#if whole > 0}
			<div class="share-bar" aria-hidden="true">
				{#each shown as category (category.category)}
					{#if share(category.total_tokens) > 0}
						<span class="is-{category.category}" style:width="{share(category.total_tokens)}%" title="{copy.category[category.category]} {percent(category.total_tokens)}"></span>
					{/if}
				{/each}
			</div>
		{/if}
		<ul class="categories">
			{#each shown as category (category.category)}
				<li class="category-item">
					<div class="category-line">
						<button
							type="button"
							class="category-name"
							disabled={ledger.loading}
							onclick={() => ledger.drillCategory(category.category)}
						>
							<i class="category-dot is-{category.category}"></i>
							<span class="category-title-text">{copy.category[category.category]}</span>
						</button>
						<SpendAmount {copy} reported={category.reported_usd_ticks} estimated={category.estimated_usd_ticks} missing={copy.estimateUnknown} />
						{#if category.kinds.length > 1}
							<button
								type="button"
								class="kind-toggle row-icon"
								aria-label={ledger.expanded[category.category] ? copy.collapse : copy.expand}
								title={ledger.expanded[category.category] ? copy.collapse : copy.expand}
								aria-expanded={!!ledger.expanded[category.category]}
								onclick={() => ledger.toggleCategory(category.category)}
							>
								<SpendIcon name="chevron" />
							</button>
						{:else}
							<span class="kind-toggle-space" aria-hidden="true"></span>
						{/if}
					</div>
					<span class="category-meta num">
						<span>{meta(category)}</span>
						{#if whole > 0}<span class="category-share">{percent(category.total_tokens)}</span>{/if}
					</span>
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
									<SpendAmount {copy} reported={kind.reported_usd_ticks} estimated={kind.estimated_usd_ticks} missing={copy.estimateUnknown} />
									<span class="kind-meta num">{meta(kind)}</span>
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
	.analysis-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 16px;
	}

	.trend-surface .section-head {
		padding-bottom: 6px;
	}

	.trend-content {
		padding: 6px 18px 18px;
	}

	.bar-note {
		font-size: 11px;
		color: var(--muted);
	}

	.categories, .kinds {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.categories {
		padding: 0 18px 10px;
	}

	.category-item {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 8px 0 9px;
	}

	.category-item + .category-item {
		border-top: 1px solid var(--line-subtle);
	}

	.category-line {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: 13px;
	}

	.category-name {
		flex: 1;
		min-width: 0;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		border: 0;
		background: transparent;
		padding: 0;
		min-height: 24px;
		text-align: left;
		font: inherit;
		font-weight: 600;
		color: var(--ink);
		cursor: pointer;
		transition: color 0.15s ease;
	}

	.category-name:hover:not(:disabled) {
		color: var(--accent);
	}

	.category-title-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.category-dot {
		width: 8px;
		height: 8px;
		border-radius: 2px;
		flex: none;
		background: var(--accent);
	}

	.kind-toggle :global(svg) {
		transition: transform 0.2s ease;
	}

	.kind-toggle[aria-expanded='true'] :global(svg) {
		transform: rotate(180deg);
	}

	.kind-toggle-space {
		width: 28px;
		flex: none;
	}

	.category-meta {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		margin-right: 36px;
		padding-left: 16px;
		font-size: 11.5px;
		color: var(--muted);
	}

	/* Every category's share of the tokens, as one bar; the rows below name each part. */
	.share-bar {
		display: flex;
		gap: 2px;
		height: 10px;
		margin: 0 18px 4px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--line-subtle);
	}

	.share-bar span {
		display: block;
		height: 100%;
		min-width: 3px;
		background: var(--accent);
		transition: width 0.3s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.category-share {
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.category-dot.is-judgement, .share-bar .is-judgement { background: var(--purple); }

	.category-dot.is-decision, .share-bar .is-decision { background: var(--ok); }

	.category-dot.is-feedback, .share-bar .is-feedback { background: var(--warn); }

	.category-dot.is-other, .share-bar .is-other { background: var(--muted-light); }

	.kinds {
		margin: 8px 36px 0 16px;
		padding-left: 10px;
		border-left: 2px solid var(--line);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.kind-item {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0 10px;
		font-size: 12px;
	}

	.kind-name {
		padding: 0;
		min-height: 24px;
		overflow-wrap: anywhere;
	}

	.kind-meta {
		grid-column: 1 / -1;
		font-size: 11px;
		color: var(--muted);
	}

	/* Wide: the trend and the categories side by side, about the same height. */
	@container spend (min-width: 1000px) {
		.analysis-grid {
			grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr);
			align-items: stretch;
		}
	}

	@media (pointer: coarse) {
		.category-name {
			min-height: 40px;
		}
	}

	@container spend (max-width: 620px) {
		.trend-content {
			padding: 4px 14px 14px;
		}

		.categories {
			padding: 0 14px 6px;
		}

		.share-bar {
			margin: 0 14px 4px;
		}
	}
</style>
