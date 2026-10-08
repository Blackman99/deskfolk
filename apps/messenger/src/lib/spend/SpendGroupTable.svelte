<script lang="ts">
	import SpendIcon from './SpendIcon.svelte';
	import type { SpendGroup, SpendTotals } from '@real-bot/protocol';
	import { formatTokens } from '../spend-format.ts';
	import type { SpendCopy } from './spend-copy.ts';
	import type { SpendLedger } from './spend-ledger.svelte.ts';
	import type { SpendDimension, SpendSortColumn } from './spend-query.ts';

	interface Props {
		copy: SpendCopy;
		ledger: SpendLedger;
		num: (value: number | null) => string;
		money: (ticks: number | null, estimated?: boolean) => string;
		tokenMetrics: (row: Pick<SpendTotals, 'input_tokens' | 'cached_tokens' | 'output_tokens' | 'reasoning_tokens'>) => { label: string; value: number | null }[];
		/** Open the conversation this row belongs to. */
		onOpenSession?: (sessionId: string) => void;
	}

	let { copy, ledger, num, money, tokenMetrics, onOpenSession }: Props = $props();

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
		if (column.label === 'name') return copy.dimensions[ledger.shownDimension];
		return copy[column.label];
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
	</div>

	<div class="compact-sort">
		<label>
			<span>{copy.sort}</span>
			<select
				aria-label={copy.sort}
				value={ledger.view.sort}
				onchange={(event) => (ledger.view.sort = event.currentTarget.value as SpendSortColumn)}
			>
				{#each columns as column}
					<option value={column.key}>{columnLabel(column)}</option>
				{/each}
			</select>
		</label>
		<button
			type="button"
			class="quiet sort-dir-btn"
			aria-label={ledger.view.dir === 'asc' ? copy.ascending : copy.descending}
			onclick={() => (ledger.view.dir = ledger.view.dir === 'asc' ? 'desc' : 'asc')}
		>
			{ledger.view.dir === 'asc' ? '↑' : '↓'}
		</button>
	</div>

	<div class="table-container">
		<table class="dimension-table">
			<thead>
				<tr>
					{#each columns as column}
						<th aria-sort={ledger.view.sort === column.key ? (ledger.view.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
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
					<th><span class="sr">{copy.openSession}</span></th>
				</tr>
			</thead>
			<tbody>
				{#each sortedGroups as group (`${group.id ?? 'null'}-${group.provider_id ?? ''}-${group.model ?? ''}`)}
					<tr class:is-deleted={group.deleted}>
						<td class="group-name-cell">
							<div class="group-name-wrapper">
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
							</div>
						</td>
						<td class="num group-calls" data-label={copy.calls}>{formatTokens(group.calls)}</td>
						<td class="num group-input" data-label={copy.input}>{num(group.input_tokens)}</td>
						<td class="num group-output" data-label={copy.output}>{num(group.output_tokens)}</td>
						<td class="num group-total" data-label={copy.totalTokens}>{num(group.total_tokens)}</td>
						<td class="num group-reported" data-label={copy.reported}>{money(group.reported_usd_ticks)}</td>
						<td class="num group-estimated" data-label={copy.estimated}>{money(group.estimated_usd_ticks)}</td>
						<td class="group-actions">
							{#if ledger.groupsActionable && ledger.shownDimension === 'session' && group.id && !group.deleted && onOpenSession}
								<button type="button" class="text-action open-session-btn" onclick={() => onOpenSession?.(group.id!)}>
									<span>{copy.openSession}</span>
									<SpendIcon name="arrow" />
								</button>
							{/if}
							<details class="group-more">
								<summary aria-label={copy.inspect}>
									<span>{copy.usageDetails}</span>
									<SpendIcon name="chevron" />
								</summary>
								<dl>
									{#each tokenMetrics(group) as item}
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
</section>

<style>
	/* The direct children of the scroll area: SpendView's `.spend-scroll > *` cannot reach them from here. */
	.dimension-surface {
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

	.group-more[open] > summary :global(svg) {
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

	.dimension-table th:first-child { width: 28%; }

	.dimension-table th:last-child { width: 14%; }

	.sort {
		min-height: 28px;
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
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
	}

	.group-name {
		min-height: 32px;
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

	.is-deleted .group-name {
		color: var(--muted);
	}

	.group-actions {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
	}

	.group-actions:empty {
		padding: 0;
	}

	.open-session-btn {
		font-size: 12px;
	}

	.group-more {
		display: none;
	}

	.group-more summary {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--muted);
		min-height: 28px;
		font-size: 11px;
		cursor: pointer;
		transition: color 0.15s ease;
	}

	.group-more summary:hover {
		color: var(--ink);
	}

	.group-more summary :global(svg) {
		width: 12px;
		height: 12px;
	}

	.group-more dl {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px 10px;
		padding: 6px 0;
		background: var(--line-subtle);
		border-radius: var(--radius-xs);
		padding: 8px 10px;
		margin: 4px 0 0;
	}

	.group-more dt {
		font-size: 10px;
		color: var(--muted);
	}

	.group-more dd {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
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

	.compact-sort {
		display: none;
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

	button:focus-visible, summary:focus-visible, select:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	@container spend (max-width: 800px) {
		.dimension-table th:first-child { width: 25%; }

		th, td { padding: 10px 8px; }
	}

	@container spend (max-width: 620px) {
		.section-head {
			padding: 12px 14px;
		}

		.compact-sort {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 0 14px 12px;
		}

		.compact-sort label {
			flex: 1;
			display: flex;
			align-items: center;
			gap: 8px;
			color: var(--muted);
			font-size: 12px;
			font-weight: 500;
		}

		.compact-sort select {
			min-width: 0;
			flex: 1;
			padding: 0 10px;
			height: 44px;
			background: var(--pane);
			border: 1px solid var(--line);
			border-radius: var(--radius-sm);
			color: var(--ink);
			font: inherit;
			font-size: 13px;
		}

		.compact-sort .sort-dir-btn {
			height: 44px;
			width: 44px;
			padding: 0;
		}

		.dimension-tabs {
			width: 100%;
			display: flex;
		}

		.dimension-tabs button {
			flex: 1;
			min-height: 40px;
			font-size: 13px;
		}

		/* Mobile Table-to-Card transformation */
		.dimension-table, tbody {
			display: block;
			width: 100%;
		}

		thead {
			display: none;
		}

		.dimension-table tr {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 8px 14px;
			padding: 14px;
			border-top: 1px solid var(--line);
		}

		.dimension-table td {
			display: block;
			width: auto;
			border: 0;
			text-align: left;
			padding: 0;
		}

		.dimension-table .group-name-cell {
			grid-column: 1 / -1;
		}

		.group-name {
			font-size: 14px;
			min-height: 44px;
			display: flex;
			align-items: center;
		}

		.dimension-table .group-input, .dimension-table .group-output {
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

		.group-total {
			grid-row: 2;
			grid-column: 1;
		}

		.group-calls {
			grid-row: 2;
			grid-column: 2;
		}

		.group-estimated, .group-reported {
			font-size: 14px;
			font-weight: 600;
		}

		.dimension-table .group-actions {
			grid-column: 1 / -1;
			padding-top: 4px;
			align-items: stretch;
		}

		.group-more {
			display: block;
		}

		.group-more summary {
			display: flex;
			align-items: center;
			justify-content: space-between;
			min-height: 44px;
			font-size: 12px;
		}

		.open-session-btn {
			min-height: 44px;
			width: 100%;
			justify-content: space-between;
			border: 1px solid var(--line);
			border-radius: var(--radius-sm);
			padding: 0 12px;
			background: var(--line-subtle);
		}
	}
</style>
