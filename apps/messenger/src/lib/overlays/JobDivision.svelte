<script lang="ts">
	import type { Bot } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { actorFace, actorName, ticketTag } from './plan-board.ts';
	import type { DivisionRow } from './ticket-lanes.ts';

	/**
	 * Who does what in the job (ADR 0086): each Bot's tickets as written down — owns, reviews — beside
	 * the turns it actually ran, and how many of those were on someone else's ticket or under none. A
	 * Bot that owns tickets and ran nothing in the job is marked: owners are filled in from the plan's
	 * process when the organizer opens tickets, so the two drift apart.
	 */
	interface Props {
		rows: readonly DivisionRow[];
		bots: readonly Bot[];
		youLabel: string;
		deletedLabel: string;
		t: Copy;
	}

	let { rows, bots, youLabel, deletedLabel, t }: Props = $props();

	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot] as const)));
	const idle = $derived(rows.some((row) => row.owns.length > 0 && row.turns === 0));
	const c = $derived(t.plan.job.division);

	function tags(seqs: readonly number[]): string {
		return seqs.length > 0 ? seqs.map((seq) => `#${ticketTag(seq)}`).join(' ') : c.none;
	}
</script>

{#if rows.length > 0}
	<section class="job-division" aria-label={c.title}>
		<h4 class="job-block-title">{c.title}</h4>
		<div class="job-division-scroll">
			<table class="job-division-table">
				<thead>
					<tr>
						<th scope="col">{c.bot}</th>
						<th scope="col">{c.owns}</th>
						<th scope="col">{c.reviews}</th>
						<th scope="col">{c.turns}</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.bot)}
						{@const face = actorFace(row.bot, botsById, youLabel, deletedLabel)}
						{@const quiet = row.owns.length > 0 && row.turns === 0}
						<tr class:is-idle={quiet} data-division-bot={row.bot} title={quiet ? c.idle : undefined}>
							<th scope="row">
								<span class="job-division-face" style:background={face.palette?.bg} style:color={face.palette?.text} style:border-color={face.palette?.border}>
									{#if face.src}<img src={face.src} alt="" />{:else}{face.letter}{/if}
								</span>
								<span class="job-division-name">{actorName(row.bot, botsById, youLabel, deletedLabel)}</span>
							</th>
							<td class="mono">{tags(row.owns)}</td>
							<td class="mono">{tags(row.reviews)}</td>
							<td>
								<span class="mono job-division-turns">{row.turns}</span>
								{#if row.onOthers > 0 || row.loose > 0}
									<span class="job-division-more">{[row.onOthers > 0 ? c.onOthers(row.onOthers) : '', row.loose > 0 ? c.loose(row.loose) : ''].filter(Boolean).join(' · ')}</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if idle}
			<p class="job-block-note">{c.idleNote}</p>
		{/if}
	</section>
{/if}

<style>
	.job-division {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.job-block-title {
		margin: 0;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.02em;
		color: var(--muted);
	}

	.job-division-scroll {
		overflow-x: auto;
	}

	.job-division-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}

	.job-division-table th,
	.job-division-table td {
		padding: 5px 8px 5px 0;
		border-bottom: 1px solid var(--line-subtle);
		text-align: left;
		vertical-align: top;
		white-space: nowrap;
	}

	.job-division-table thead th {
		padding-top: 0;
		border-bottom-color: var(--line);
		font-size: 11px;
		font-weight: 500;
		color: var(--muted);
	}

	.job-division-table tbody th {
		font-weight: 500;
	}

	.job-division-table td:last-child {
		white-space: normal;
	}

	/* Owns tickets, ran nothing: the record and the work disagree. */
	.job-division-table tr.is-idle > * {
		background: var(--warn-bg);
	}

	.job-division-face {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 15px;
		height: 15px;
		box-sizing: border-box;
		margin-right: 5px;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: 50%;
		font-size: 9px;
		font-weight: 700;
		vertical-align: -3px;
	}

	.job-division-face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.job-division-turns {
		font-weight: 600;
	}

	.job-division-more {
		margin-left: 4px;
		font-size: 11px;
		color: var(--muted);
	}

	.job-block-note {
		margin: 0;
		font-size: 11px;
		line-height: 1.45;
		color: var(--muted);
	}
</style>
