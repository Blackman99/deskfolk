<script lang="ts">
	import SpendAmount from './SpendAmount.svelte';
	import SpendBotFace from './SpendBotFace.svelte';
	import ModelSourceMark from '../ModelSourceMark.svelte';
	import type { ModelSource } from '../model-source.ts';
	import SpendIcon from './SpendIcon.svelte';
	import type { Bot, SpendGroup } from '@real-bot/protocol';
	import { formatTokens, formatUsd } from '../spend-format.ts';
	import type { SpendCopy } from './spend-copy.ts';
	import type { SpendLedger } from './spend-ledger.svelte.ts';
	import type { SpendDimension, SpendSortColumn } from './spend-query.ts';

	interface Props {
		copy: SpendCopy;
		ledger: SpendLedger;
		num: (value: number | null) => string;
		/** Open the conversation this row belongs to. */
		onOpenSession?: (sessionId: string) => void;
		/** The roster's Bot for an id, for its face on the Bot dimension. */
		botOf?: (id: string | null) => Bot | null;
		/** Where a model ran, for its agent's or vendor's logo on the model dimension. */
		sourceOf?: (providerId: string | null, providerName: string | null) => ModelSource | null;
	}

	let { copy, ledger, num, onOpenSession, botOf = () => null, sourceOf = () => null }: Props = $props();

	const dimensions: SpendDimension[] = ['model', 'session', 'bot'];

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

	const sortedGroups = $derived.by(() => {
		const rows = [...(ledger.summary?.groups ?? [])];
		const dir = ledger.view.dir === 'asc' ? 1 : -1;
		rows.sort((a, b) => {
			if (ledger.view.sort === 'name') return ledger.groupLabel(a).localeCompare(ledger.groupLabel(b)) * dir;
			const av = columnValue(a, ledger.view.sort);
			const bv = columnValue(b, ledger.view.sort);
			if (av == null && bv == null) return 0;
			if (av == null) return 1;
			if (bv == null) return -1;
			return (av - bv) * dir;
		});
		return rows;
	});

	/** The first rows of a long list; the rest wait behind a button. A new dimension starts short again. */
	const FIRST_ROWS = 6;
	let showAll = $state(false);
	$effect(() => {
		void ledger.view.dimension;
		showAll = false;
	});
	const shownGroups = $derived(showAll ? sortedGroups : sortedGroups.slice(0, FIRST_ROWS));

	/** An amount column no row has a figure in is a column of dashes; it is left out. One stays. */
	const hasReported = $derived(sortedGroups.some((group) => group.reported_usd_ticks != null));
	const hasEstimated = $derived(sortedGroups.some((group) => group.estimated_usd_ticks != null));

	const widest = $derived(Math.max(0, ...sortedGroups.map((group) => group.total_tokens ?? 0)));

	function share(value: number | null): number {
		return value != null && widest > 0 ? (value / widest) * 100 : 0;
	}

	function sortBy(column: SpendSortColumn): void {
		if (ledger.view.sort === column) ledger.view.dir = ledger.view.dir === 'asc' ? 'desc' : 'asc';
		else {
			ledger.view.sort = column;
			ledger.view.dir = column === 'name' ? 'asc' : 'desc';
		}
	}

	function sortMark(column: SpendSortColumn): string {
		if (ledger.view.sort !== column) return '';
		return ledger.view.dir === 'asc' ? ' ↑' : ' ↓';
	}

	type Column = { key: SpendSortColumn; label: keyof Pick<SpendCopy, 'calls' | 'input' | 'output' | 'totalTokens' | 'reported' | 'estimated'> | 'name' };

	const allColumns: Column[] = [
		{ key: 'name', label: 'name' },
		{ key: 'calls', label: 'calls' },
		{ key: 'input', label: 'input' },
		{ key: 'output', label: 'output' },
		{ key: 'total', label: 'totalTokens' },
		{ key: 'reported', label: 'reported' },
		{ key: 'estimated', label: 'estimated' }
	];

	function shows(column: Column): boolean {
		if (column.key === 'reported') return hasReported;
		if (column.key === 'estimated') return hasEstimated || !hasReported;
		return true;
	}

	const columns = $derived(allColumns.filter(shows));
	/** The narrow sort picker: the columns on show, and whatever is sorting now. */
	const sortChoices = $derived(allColumns.filter((column) => shows(column) || column.key === ledger.view.sort));

	function columnLabel(column: Column): string {
		if (column.label === 'name') return copy.dimensions[ledger.shownDimension];
		return copy[column.label];
	}

	function canOpen(group: SpendGroup): boolean {
		return ledger.groupsActionable && ledger.shownDimension === 'session' && !!group.id && !group.deleted && !!onOpenSession;
	}
</script>

<section class="surface dimension-surface" aria-label={copy.dimension}>
	<div class="section-head distribution-head">
		<div class="section-head-title">
			<h2>{copy.distribution}</h2>
			<p class="section-hint">{copy.breakdownHint}</p>
		</div>
		<div class="segmented dimension-tabs" role="group" aria-label={copy.dimension}>
			{#each dimensions as dimension}
				<button
					type="button"
					aria-pressed={ledger.view.dimension === dimension}
					onclick={() => (ledger.view.dimension = dimension)}
				>
					{copy.dimensions[dimension]}
				</button>
			{/each}
		</div>
		<div class="compact-sort">
			<label>
				<span>{copy.sort}</span>
				<select
					aria-label={copy.sort}
					value={ledger.view.sort}
					onchange={(event) => (ledger.view.sort = event.currentTarget.value as SpendSortColumn)}
				>
					{#each sortChoices as column (column.key)}
						<option value={column.key}>{columnLabel(column)}</option>
					{/each}
				</select>
			</label>
			<button
				type="button"
				class="sort-dir-btn"
				aria-label={ledger.view.dir === 'asc' ? copy.ascending : copy.descending}
				onclick={() => (ledger.view.dir = ledger.view.dir === 'asc' ? 'desc' : 'asc')}
			>
				{ledger.view.dir === 'asc' ? '↑' : '↓'}
			</button>
		</div>
	</div>

	<div class="table-container">
		<table class="dimension-table">
			<thead>
				<tr>
					{#each columns as column (column.key)}
						<th class="col-{column.key}" aria-sort={ledger.view.sort === column.key ? (ledger.view.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
							<button
								type="button"
								class="sort"
								aria-label={copy.sortBy(columnLabel(column))}
								onclick={() => sortBy(column.key)}
							>
								{columnLabel(column)}{sortMark(column.key)}
							</button>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each shownGroups as group (`${group.id ?? 'null'}-${group.provider_id ?? ''}-${group.model ?? ''}`)}
					<tr class:is-deleted={group.deleted} class:is-actionable={ledger.groupsActionable && !ledger.loading}>
						<td class="group-name-cell">
							<div class="group-name-wrapper">
								{#if ledger.shownDimension === 'bot'}
									<SpendBotFace id={group.id} name={group.name} bot={botOf(group.id)} />
								{:else if ledger.shownDimension === 'model'}
									{@const source = sourceOf(group.provider_id, group.provider_name)}
									{#if source}
										<ModelSourceMark {source} tile />
									{/if}
								{/if}
								<button
									type="button"
									class="group-name"
									disabled={!ledger.groupsActionable || ledger.loading}
									onclick={() => ledger.drillGroup(group)}
								>
									{ledger.groupLabel(group)}
								</button>
								{#if group.deleted}
									<span class="deleted">{copy.deleted}</span>
								{/if}
								{#if canOpen(group)}
									<button type="button" class="row-icon open-session-btn" title={copy.openSession} onclick={() => onOpenSession?.(group.id!)}><SpendIcon name="arrow" /><span class="sr">{copy.openSession}</span></button>
								{/if}
							</div>
							<span class="name-bar" aria-hidden="true"><span style:width="{share(group.total_tokens)}%"></span></span>
						</td>
						<td class="num group-calls">{formatTokens(group.calls)}</td>
						<td class="num group-input">{num(group.input_tokens)}</td>
						<td class="num group-output">{num(group.output_tokens)}</td>
						<td class="num group-total">{num(group.total_tokens)}</td>
						{#if hasReported}
							<td class="num group-reported">{group.reported_usd_ticks == null ? copy.dash : formatUsd(group.reported_usd_ticks)}</td>
						{/if}
						{#if hasEstimated || !hasReported}
							<td class="num group-estimated" title={group.estimated_usd_ticks == null && group.reported_usd_ticks == null ? copy.estimateUnknown : undefined}>{group.estimated_usd_ticks == null ? copy.dash : formatUsd(group.estimated_usd_ticks)}</td>
						{/if}
						<!-- Narrow: the row is two lines, its money on the right and its calls and tokens under the name. -->
						<td class="group-amount"><SpendAmount {copy} reported={group.reported_usd_ticks} estimated={group.estimated_usd_ticks} missing={copy.estimateUnknown} /></td>
						<td class="group-meta num">{copy.recordedCalls(group.calls)} · {copy.tokens(num(group.total_tokens))}</td>
						<td class="group-bar" aria-hidden="true"><span style:width="{share(group.total_tokens)}%"></span></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if sortedGroups.length > FIRST_ROWS}
		<div class="more-rows">
			<button type="button" class="text-action" aria-expanded={showAll} onclick={() => (showAll = !showAll)}>
				{showAll ? copy.showFewerRows : copy.showAllRows(sortedGroups.length)}
			</button>
		</div>
	{/if}
</section>

<style>
	p {
		margin: 0;
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
		padding: 10px 12px;
		text-align: right;
		border-top: 1px solid var(--line-subtle);
		vertical-align: middle;
	}

	th:first-child, td:first-child {
		padding-left: 18px;
		text-align: left;
	}

	th:last-of-type, td:nth-last-child(4) {
		padding-right: 18px;
	}

	th {
		font-weight: 550;
		font-size: 12px;
		color: var(--muted);
		background: var(--sidebar-bg);
		user-select: none;
	}

	tbody tr {
		transition: background 0.1s ease;
	}

	tbody tr:hover {
		background: var(--row-hover);
	}

	.dimension-table th.col-name { width: 34%; }

	.sort {
		min-height: 24px;
		border: 0;
		background: transparent;
		padding: 0;
		font: inherit;
		color: inherit;
		text-align: inherit;
		cursor: pointer;
		font-weight: 550;
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.sort:hover {
		color: var(--ink);
	}

	.group-name-wrapper {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.group-name {
		min-width: 0;
		min-height: 28px;
		border: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-weight: 600;
		padding: 0;
		text-align: left;
		cursor: pointer;
		overflow-wrap: anywhere;
		transition: color 0.15s ease;
	}

	.group-name:hover:not(:disabled) {
		color: var(--accent);
	}

	.group-name:disabled {
		cursor: default;
		color: var(--muted);
		opacity: 1;
	}

	.is-deleted .group-name {
		color: var(--muted);
	}

	.group-reported, .group-estimated {
		font-weight: 600;
	}

	.group-amount, .group-meta, .group-bar {
		display: none;
	}

	.more-rows {
		display: flex;
		justify-content: center;
		padding: 6px 12px 8px;
		border-top: 1px solid var(--line-subtle);
	}

	/* Wide: the row's share of the busiest row's tokens, under its name. Narrow has its own bar. */
	.name-bar {
		display: block;
		max-width: 360px;
		height: 4px;
		margin-top: 6px;
		background: var(--line-subtle);
		border-radius: var(--radius-full);
		overflow: hidden;
	}

	.name-bar span {
		display: block;
		height: 100%;
		min-width: 2px;
		background: var(--accent);
		border-radius: inherit;
	}

	.is-deleted .name-bar span {
		background: var(--muted-light);
	}

	.compact-sort {
		display: none;
	}

	/* Middle widths: the input and output columns go first; the total keeps the row's size. */
	@container spend (max-width: 999px) {
		.dimension-table :is(th.col-input, th.col-output, .group-input, .group-output) {
			display: none;
		}

		.dimension-table th.col-name { width: 40%; }
	}

	/*
	 * Narrow (a phone, a narrow pane): no table. Each group is two lines and a bar, the whole row
	 * picks it, the same as its name does.
	 */
	@container spend (max-width: 620px) {
		/*
		 * The title takes its own line. Under it, one row: the switch, as big as the trend card's, then
		 * the sort at the row's end, the same height as the switch. Short of room, the sort wraps right.
		 */
		.distribution-head {
			gap: 10px 8px;
		}

		.distribution-head .section-head-title {
			flex: 1 0 100%;
		}

		.compact-sort {
			display: flex;
			align-items: center;
			gap: 4px;
			margin-left: auto;
		}

		.compact-sort label {
			display: flex;
			align-items: center;
			gap: 6px;
			color: var(--muted);
			font-size: 12px;
		}

		.compact-sort select {
			appearance: none;
			-webkit-appearance: none;
			height: 30px;
			padding: 0 10px;
			border: 0;
			border-radius: var(--radius-full);
			background: var(--line-subtle);
			color: var(--ink);
			font: inherit;
			font-size: 12px;
			font-weight: 500;
		}

		.sort-dir-btn {
			width: 30px;
			height: 30px;
			border: 0;
			border-radius: var(--radius-full);
			background: var(--line-subtle);
			color: var(--ink);
			font: inherit;
			font-size: 13px;
			cursor: pointer;
		}

		.dimension-table, tbody {
			display: block;
			width: 100%;
		}

		thead {
			display: none;
		}

		.dimension-table tr {
			position: relative;
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-areas:
				'name amount'
				'meta amount'
				'bar bar';
			align-items: center;
			gap: 2px 12px;
			padding: 11px 14px 12px;
			border-top: 1px solid var(--line-subtle);
		}

		.dimension-table td {
			display: none;
			padding: 0;
			border: 0;
			text-align: left;
		}

		.dimension-table .group-name-cell {
			display: block;
			grid-area: name;
			min-width: 0;
		}

		.dimension-table .group-amount {
			display: block;
			grid-area: amount;
			font-size: 14px;
		}

		.dimension-table .group-meta {
			display: block;
			grid-area: meta;
			font-size: 11.5px;
			color: var(--muted);
		}

		.name-bar {
			display: none;
		}

		.dimension-table .group-bar {
			display: block;
			grid-area: bar;
			height: 3px;
			margin-top: 6px;
			background: var(--line-subtle);
			border-radius: var(--radius-full);
			overflow: hidden;
		}

		.group-bar span {
			display: block;
			height: 100%;
			min-width: 2px;
			background: var(--accent);
			border-radius: inherit;
		}

		.is-deleted .group-bar span {
			background: var(--muted-light);
		}

		.group-name {
			min-height: 0;
			font-size: 14px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		/* The name's hit area is the whole row. The open-session icon sits above it. */
		.is-actionable .group-name::after {
			content: '';
			position: absolute;
			inset: 0;
		}

		.is-actionable:active {
			background: var(--row-hover);
		}
	}
</style>
