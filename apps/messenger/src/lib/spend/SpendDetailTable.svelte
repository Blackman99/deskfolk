<script lang="ts">
	import SpendIcon from './SpendIcon.svelte';
	import { SPEND_CATEGORY_OF, spendLineOf } from '@real-bot/protocol';
	import type { SpendDetail, SpendTotals } from '@real-bot/protocol';
	import { localeTag } from '../locale-tag.ts';
	import { formatUsd } from '../spend-format.ts';
	import type { SpendCopy } from './spend-copy.ts';
	import type { SpendLedger } from './spend-ledger.svelte.ts';

	interface Props {
		copy: SpendCopy;
		locale: 'zh' | 'en';
		timeZone: string;
		ledger: SpendLedger;
		num: (value: number | null) => string;
		tokenMetrics: (row: Pick<SpendTotals, 'input_tokens' | 'cached_tokens' | 'output_tokens' | 'reasoning_tokens'>) => { label: string; value: number | null }[];
		/** Open the message that woke a turn. */
		onOpenTrigger?: (sessionId: string, messageId: string) => void;
	}

	let { copy, locale, timeZone, ledger, num, tokenMetrics, onOpenTrigger }: Props = $props();

	const categoryOf = SPEND_CATEGORY_OF;

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

	function amountTitle(row: SpendDetail): string | undefined {
		if (row.estimated_cost_usd_ticks != null && row.cost_usd_ticks == null) return copy.estimatedHint;
		if (row.cost_usd_ticks == null && row.estimated_cost_usd_ticks == null) {
			if (row.input_tokens == null || row.output_tokens == null) return copy.estimateIncompleteUsage;
			return copy.estimateUnconfigured;
		}
		return undefined;
	}

	function dateLabel(value: string): string {
		return new Intl.DateTimeFormat(localeTag(locale), { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
	}

	function timeLabel(value: string): string {
		return new Intl.DateTimeFormat(localeTag(locale), { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
	}
</script>

<section class="surface detail-surface" aria-label={copy.details}>
	<div class="section-head detail-head">
		<div class="section-head-title">
			<h2>{copy.details}</h2>
			<p class="section-hint">{copy.detailHint}</p>
		</div>
		<span class="loaded-count-badge">{copy.loadedCalls(ledger.details.length)}</span>
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
				{#each ledger.details as row (row.id)}
					<tr class:is-deleted={row.session_deleted || row.bot_deleted}>
						<td class="detail-time">
							<time datetime={row.created_at} title={row.created_at}>
								<span class="detail-date">{dateLabel(row.created_at)}</span>
								<span class="detail-clock text-muted">{timeLabel(row.created_at)}</span>
							</time>
						</td>
						<td class="detail-kind">
							<span class="kind-label is-{categoryOf[spendLineOf(row)]}">{copy.kind[spendLineOf(row)]}</span>
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
									<SpendIcon name="arrow" />
								</button>
							{/if}
							<details class="call-breakdown">
								<summary>
									<span>{copy.usageDetails}</span>
									<SpendIcon name="chevron" />
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

	{#if ledger.nextCursor}
		<div class="pagination">
			<button type="button" class="more quiet" disabled={ledger.loadingMore || ledger.loading} onclick={() => void ledger.loadMore()}>{ledger.loadingMore ? copy.loadingMore : copy.loadMore}</button>
		</div>
	{/if}
</section>

<style>
	/* The direct children of the scroll area: SpendView's `.spend-scroll > *` cannot reach them from here. */
	.detail-surface {
		flex-shrink: 0;
		min-width: 0;
	}

	h2, p, dl, dd, dt {
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

	summary {
		cursor: pointer;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	.call-breakdown[open] > summary :global(svg) {
		transform: rotate(180deg);
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

	.num {
		font-variant-numeric: tabular-nums;
		font-size: 13px;
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
		font-size: 13px;
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
		font-size: 12px;
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

	.deleted {
		display: inline-block;
		padding: 1px 6px;
		font-size: 10px;
		font-weight: 500;
		color: var(--muted);
		border: 1px solid var(--line);
		border-radius: var(--radius-xs);
		white-space: nowrap;
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
		border-radius: var(--radius-xs);
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
		border-radius: var(--radius-xs);
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

	.detail-actions summary {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--muted);
		min-height: 28px;
		font-size: 11px;
		cursor: pointer;
		transition: color 0.15s ease;
	}

	.detail-actions summary:hover {
		color: var(--ink);
	}

	.detail-actions summary :global(svg) {
		width: 12px;
		height: 12px;
	}

	.call-breakdown dl {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px 10px;
		padding: 6px 0;
		background: var(--line-subtle);
		border-radius: var(--radius-xs);
		padding: 8px 10px;
		margin: 4px 0 0;
	}

	.call-breakdown dt {
		font-size: 10px;
		color: var(--muted);
	}

	.call-breakdown dd {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.open-trigger-btn {
		font-size: 12px;
	}

	.loaded-count-badge {
		font-size: 12px;
		color: var(--muted);
		background: var(--line-subtle);
		padding: 3px 8px;
		border-radius: var(--radius-xs);
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
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.quiet:hover:not(:disabled) {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.more {
		width: 100%;
		max-width: 280px;
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

	button:focus-visible, summary:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	@container spend (max-width: 800px) {
		th, td { padding: 10px 8px; }
	}

	@container spend (max-width: 620px) {
		.section-head {
			padding: 12px 14px;
		}

		/* Mobile Table-to-Card transformation */
		.detail-table, tbody {
			display: block;
			width: 100%;
		}

		thead {
			display: none;
		}

		td[data-label]::before {
			content: attr(data-label);
			display: block;
			color: var(--muted);
			font-size: 11px;
			margin-bottom: 2px;
			font-weight: 500;
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
	}
</style>
