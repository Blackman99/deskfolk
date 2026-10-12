<script lang="ts">
	import SpendAmount from './SpendAmount.svelte';
	import SpendIcon from './SpendIcon.svelte';
	import { SPEND_CATEGORY_OF, spendLineOf } from '@real-bot/protocol';
	import type { SpendDetail } from '@real-bot/protocol';
	import { localeTag } from '../locale-tag.ts';
	import type { SpendCopy } from './spend-copy.ts';
	import type { SpendLedger } from './spend-ledger.svelte.ts';
	import { calendarDate } from './spend-query.ts';

	interface Props {
		copy: SpendCopy;
		locale: 'zh' | 'en';
		timeZone: string;
		ledger: SpendLedger;
		num: (value: number | null) => string;
		/** Open the message that woke a turn. */
		onOpenTrigger?: (sessionId: string, messageId: string) => void;
	}

	let { copy, locale, timeZone, ledger, num, onOpenTrigger }: Props = $props();

	const categoryOf = SPEND_CATEGORY_OF;

	/** The calls of one local day, newest day first as the ledger pages them. */
	const days = $derived.by(() => {
		const out: { key: string; rows: SpendDetail[] }[] = [];
		for (const row of ledger.details) {
			const key = calendarDate(new Date(row.created_at), timeZone);
			const last = out[out.length - 1];
			if (last?.key === key) last.rows.push(row);
			else out.push({ key, rows: [row] });
		}
		return out;
	});

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

	function amountTitle(row: SpendDetail): string | undefined {
		if (row.estimated_cost_usd_ticks != null && row.cost_usd_ticks == null) return copy.estimatedHint;
		if (row.cost_usd_ticks == null && row.estimated_cost_usd_ticks == null) {
			if (row.input_tokens == null || row.output_tokens == null) return copy.estimateIncompleteUsage;
			return copy.estimateUnconfigured;
		}
		return undefined;
	}

	/** Every token field of the call, for the hover on its total. */
	function tokenTitle(row: SpendDetail): string {
		return [
			[copy.input, row.input_tokens],
			[copy.cached, row.cached_tokens],
			[copy.output, row.output_tokens],
			[copy.reasoning, row.reasoning_tokens]
		]
			.map(([label, value]) => `${label} ${num(value as number | null)}`)
			.join(' · ');
	}

	function dayLabel(key: string): string {
		const [year, month, day] = key.split('-').map(Number);
		const date = new Date(Date.UTC(year!, month! - 1, day));
		const thisYear = Number(calendarDate(new Date(), timeZone).slice(0, 4));
		return new Intl.DateTimeFormat(localeTag(locale), {
			timeZone: 'UTC',
			month: 'short',
			day: 'numeric',
			weekday: 'short',
			...(year === thisYear ? {} : { year: 'numeric' as const })
		}).format(date);
	}

	function fullTime(value: string): string {
		return new Intl.DateTimeFormat(localeTag(locale), { timeZone, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
	}

	function timeLabel(value: string): string {
		return new Intl.DateTimeFormat(localeTag(locale), { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
	}

	function canOpen(row: SpendDetail): boolean {
		return !!row.trigger_message_id && !row.session_deleted && !!onOpenTrigger;
	}
</script>

<section class="surface detail-surface" aria-label={copy.details}>
	<div class="section-head detail-head">
		<div class="section-head-title">
			<h2>{copy.details}</h2>
			<p class="section-hint">{copy.detailHint}</p>
		</div>
		<span class="loaded-count">{copy.loadedCalls(ledger.details.length)}</span>
	</div>

	<div class="table-container">
		<table class="detail-table">
			<thead>
				<tr>
					<th class="col-time">{copy.time}</th>
					<th class="col-kind">{copy.categories}</th>
					<th class="col-owner">{copy.session} / {copy.bot}</th>
					<th class="col-model">{copy.model}</th>
					<th class="col-tokens">{copy.totalTokens}</th>
					<th class="col-amount">{copy.amount}</th>
					<th class="col-open"><span class="sr">{copy.openTrigger}</span></th>
				</tr>
			</thead>
			{#each days as day (day.key)}
				<tbody>
					<tr class="day-row">
						<th colspan="7" scope="colgroup">{dayLabel(day.key)}</th>
					</tr>
					{#each day.rows as row (row.id)}
						<tr class:is-deleted={row.session_deleted || row.bot_deleted} class:is-actionable={canOpen(row)}>
							<td class="detail-time">
								<time datetime={row.created_at} title={fullTime(row.created_at)}>{timeLabel(row.created_at)}</time>
							</td>
							<td class="detail-kind">
								<span class="kind-label is-{categoryOf[spendLineOf(row)]}">{copy.kind[spendLineOf(row)]}</span>
							</td>
							<td class="detail-owner">
								<span class="owner-session">{detailSession(row)}</span>
								{#if row.session_deleted}
									<span class="deleted">{copy.deleted}</span>
								{/if}
								<span class="owner-bot">{detailBot(row)}</span>
								{#if row.bot_deleted}
									<span class="deleted">{copy.deleted}</span>
								{/if}
							</td>
							<td class="detail-model" title={detailModel(row)}>
								<span class="model-name">{row.model ?? copy.unrecordedModel}</span>
								{#if row.model != null && row.provider_name}
									<span class="model-provider">{row.provider_name}</span>
								{/if}
							</td>
							<td class="detail-tokens num" title={tokenTitle(row)}>
								<span class="tokens-total">{num(row.total_tokens)}</span>
								<span class="tokens-unit">{copy.tokens(num(row.total_tokens))}</span>
								{#if row.input_tokens != null || row.output_tokens != null}
									<span class="tokens-split">{copy.inOut(num(row.input_tokens), num(row.output_tokens))}</span>
								{/if}
							</td>
							<td class="detail-amount num" title={amountTitle(row)}>
								<SpendAmount {copy} reported={row.cost_usd_ticks} estimated={row.cost_usd_ticks == null ? row.estimated_cost_usd_ticks : null} />
							</td>
							<td class="detail-actions">
								{#if canOpen(row)}
									<button type="button" class="row-icon open-trigger-btn" title={copy.openTrigger} onclick={() => onOpenTrigger?.(row.session_id, row.trigger_message_id!)}><SpendIcon name="arrow" /><span class="sr">{copy.openTrigger}</span></button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			{/each}
		</table>
	</div>

	{#if ledger.nextCursor}
		<div class="pagination">
			<button type="button" class="more quiet" disabled={ledger.loadingMore || ledger.loading} onclick={() => void ledger.loadMore()}>{ledger.loadingMore ? copy.loadingMore : copy.loadMore}</button>
		</div>
	{/if}
</section>

<style>
	.loaded-count {
		font-size: 12px;
		color: var(--muted);
	}

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
		padding: 9px 10px;
		text-align: left;
		vertical-align: middle;
		border-top: 1px solid var(--line-subtle);
		overflow-wrap: anywhere;
	}

	th:first-child, td:first-child {
		padding-left: 18px;
	}

	th:last-child, td:last-child {
		padding-right: 12px;
	}

	thead th {
		font-weight: 550;
		font-size: 12px;
		color: var(--muted);
		background: var(--sidebar-bg);
		user-select: none;
	}

	.col-time { width: 64px; }
	.col-kind { width: 13%; }
	.col-owner { width: 26%; }
	.col-model { width: 25%; }
	.col-tokens { width: 13%; }
	.col-amount { width: 14%; }
	.col-open { width: 44px; }

	thead .col-tokens, thead .col-amount, td.num {
		text-align: right;
	}

	tbody tr:not(.day-row) {
		transition: background 0.1s ease;
	}

	tbody tr:not(.day-row):hover {
		background: var(--row-hover);
	}

	.day-row th {
		padding-top: 14px;
		padding-bottom: 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
		background: var(--pane);
	}

	.detail-time time {
		font-size: 12px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.kind-label {
		display: inline-flex;
		align-items: center;
		padding: 2px 7px;
		border-radius: var(--radius-xs);
		font-size: 11px;
		font-weight: 550;
		line-height: 16px;
		max-width: 100%;
		background: var(--line-subtle);
		color: var(--ink-secondary);
	}

	.kind-label.is-turn { background: var(--accent-tint); color: var(--accent); }

	.kind-label.is-judgement { background: var(--purple-bg); color: var(--purple-text); }

	.kind-label.is-decision { background: var(--ok-bg); color: var(--ok-text); }

	.kind-label.is-feedback { background: var(--warn-bg); color: var(--warn-text); }

	.detail-owner {
		line-height: 1.35;
	}

	.owner-session {
		font-weight: 550;
		color: var(--ink);
	}

	.owner-bot {
		display: block;
		font-size: 11.5px;
		color: var(--muted);
	}

	.detail-owner .deleted {
		margin-left: 4px;
	}

	/* The model's own name first: cut short, a provider-first label would show only the provider. */
	.detail-model {
		line-height: 1.35;
	}

	.model-name, .model-provider {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.model-name {
		font-size: 12px;
		color: var(--ink-secondary);
	}

	.model-provider {
		font-size: 11px;
		color: var(--muted);
	}

	.detail-tokens {
		line-height: 1.3;
	}

	.tokens-total {
		display: block;
		font-weight: 550;
	}

	.tokens-split {
		display: block;
		font-size: 11px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tokens-unit {
		display: none;
	}

	.detail-amount {
		white-space: nowrap;
	}

	.detail-actions {
		text-align: right;
	}

	.pagination {
		padding: 14px 18px;
		text-align: center;
		border-top: 1px solid var(--line-subtle);
	}

	.more {
		width: 100%;
		max-width: 280px;
	}

	/*
	 * Middle widths: the model gives up room and is cut short; its full name is its title. Hiding the
	 * column would leave the day rows' colspan one column wider than the table.
	 */
	@container spend (max-width: 999px) {
		.col-kind { width: 18%; }
		.col-owner { width: 26%; }
		.col-model { width: 18%; }
		.col-tokens { width: 14%; }
		.col-amount { width: 16%; }
	}

	/*
	 * Narrow: each call is two lines. Session, Bot and its money on the first; kind, time, model and
	 * its tokens on the second. The whole row opens the message that woke it.
	 */
	@container spend (max-width: 620px) {
		.detail-head {
			flex-wrap: nowrap;
		}

		.section-hint {
			display: none;
		}

		.detail-table, tbody {
			display: block;
			width: 100%;
		}

		thead {
			display: none;
		}

		.day-row {
			display: block;
		}

		tr.day-row > th {
			display: block;
			padding: 12px 14px 4px;
			border-top: 1px solid var(--line-subtle);
			background: var(--sidebar-bg);
		}

		tbody tr:not(.day-row) {
			position: relative;
			display: grid;
			grid-template-columns: auto auto minmax(0, 1fr) auto auto;
			grid-template-areas:
				'owner owner owner amount open'
				'kind time model tokens open';
			align-items: center;
			gap: 4px 8px;
			padding: 10px 10px 10px 14px;
			border-top: 1px solid var(--line-subtle);
		}

		tbody tr.day-row + tr {
			border-top: 0;
		}

		td {
			display: block;
			padding: 0;
			border: 0;
			min-width: 0;
		}

		th:first-child, td:first-child, th:last-child, td:last-child {
			padding: 0;
		}

		.detail-kind { grid-area: kind; }

		.detail-time { grid-area: time; }

		.detail-time time {
			font-size: 11.5px;
		}

		.kind-label {
			padding: 0 5px;
			font-size: 10.5px;
			line-height: 16px;
			white-space: nowrap;
		}

		.detail-owner {
			grid-area: owner;
			display: flex;
			align-items: baseline;
			gap: 6px;
			overflow: hidden;
			white-space: nowrap;
		}

		.owner-session {
			overflow: hidden;
			text-overflow: ellipsis;
			font-size: 14px;
		}

		.owner-bot {
			flex: 1 1 0;
			min-width: 24px;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.detail-owner .deleted {
			margin-left: 0;
		}

		.detail-model {
			grid-area: model;
			overflow: hidden;
		}

		.model-name {
			font-size: 11.5px;
			color: var(--muted);
		}

		.model-provider {
			display: none;
		}

		.detail-tokens {
			grid-area: tokens;
			font-size: 11.5px;
			color: var(--muted);
		}

		.tokens-total, .tokens-split {
			display: none;
		}

		.tokens-unit {
			display: inline;
		}

		.detail-amount {
			grid-area: amount;
			font-size: 13.5px;
		}

		.detail-actions {
			grid-area: open;
			align-self: center;
		}

		/* The open button's hit area is the whole row; its arrow stays at the end. */
		.is-actionable .open-trigger-btn {
			position: static;
		}

		.is-actionable .open-trigger-btn::after {
			content: '';
			position: absolute;
			inset: 0;
		}

		.is-actionable:active {
			background: var(--row-hover);
		}
	}
</style>
