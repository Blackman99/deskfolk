<script lang="ts">
	import type { QualityReportRow } from '@real-bot/protocol';
	import { spendCopyFor, type QualityCopy } from './spend-copy.ts';

	/**
	 * The quality report (ADR 0050): per Bot × model × plan kind over the last week, how its
	 * hand-overs fared and what an approved one cost. It only reads; to act on it, pin a model.
	 * Shown once there is something to report.
	 */
	interface Props {
		api: { qualityReport?: (days?: number) => Promise<QualityReportRow[]> } | null;
		locale?: 'zh' | 'en';
		/** Bumped with the spend view's own revision, so a new hand-over shows up. */
		revision?: number;
	}

	let { api, locale = 'zh', revision = 0 }: Props = $props();

	let rows = $state<QualityReportRow[]>([]);

	$effect(() => {
		void revision;
		const load = api?.qualityReport;
		if (!load) return;
		load.call(api, 7).then(
			(items) => (rows = items.filter((row) => row.hand_overs + row.approved + row.review_rejected + row.user_rejected + row.checks_failed + row.complaints + row.failure_shapes + row.review_misses > 0)),
			() => (rows = [])
		);
	});

	const copy: QualityCopy = $derived(spendCopyFor(locale).quality);

	function usd(value: number | null): string {
		if (value === null) return copy.none;
		return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
	}
</script>

{#if rows.length > 0}
	<section class="quality-surface" aria-label={copy.title} data-quality-report>
		<div class="quality-head">
			<h2>{copy.title}</h2>
			<p>{copy.hint}</p>
		</div>
		<div class="quality-table-wrap">
			<table class="quality-table">
				<thead>
					<tr>
						<th>{copy.bot}</th>
						<th>{copy.model}</th>
						<th>{copy.kind}</th>
						<th class="num">{copy.handOvers}</th>
						<th class="num">{copy.approved}</th>
						<th class="num" title={copy.turnedBackTitle}>{copy.turnedBack}</th>
						<th class="num">{copy.complaints}</th>
						<th class="num">{copy.shapes}</th>
						<th class="num">{copy.misses}</th>
						<th class="num">{copy.perApproved}</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row (`${row.bot_id}|${row.model}|${row.plan_kind}`)}
						<tr>
							<td>{row.bot_name ?? copy.deleted}</td>
							<td class="mono">{row.model ?? copy.none}</td>
							<td>{row.plan_kind ?? copy.none}</td>
							<td class="num">{row.hand_overs}</td>
							<td class="num">{row.approved}</td>
							<td class="num" title={copy.turnedBackTitle}>{row.review_rejected} · {row.user_rejected} · {row.checks_failed}</td>
							<td class="num">{row.complaints}</td>
							<td class="num">{row.failure_shapes}</td>
							<td class="num">{row.review_misses}</td>
							<td class="num">{usd(row.cost_per_approved)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

<style>
	.quality-surface {
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-xs);
		min-width: 0;
		overflow: hidden;
	}

	.quality-head {
		padding: 16px 20px 8px;
	}

	.quality-head h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}

	.quality-head p {
		margin: 4px 0 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.quality-table-wrap {
		overflow-x: auto;
		padding: 0 8px 12px;
	}

	.quality-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}

	.quality-table th,
	.quality-table td {
		padding: 6px 10px;
		text-align: left;
		white-space: nowrap;
		border-bottom: 1px solid var(--line-subtle);
	}

	.quality-table th {
		font-weight: 600;
		color: var(--muted);
	}

	.quality-table td {
		color: var(--ink-secondary);
	}

	.quality-table .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.quality-table .mono {
		font-family: var(--font-mono, ui-monospace, monospace);
	}
</style>
