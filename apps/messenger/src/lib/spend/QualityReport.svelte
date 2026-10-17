<script lang="ts">
	import type { Bot, QualityReportRow } from '@real-bot/protocol';
	import SpendBotFace from './SpendBotFace.svelte';
	import SpendIcon from './SpendIcon.svelte';
	import { spendCopyFor, type QualityCopy } from './spend-copy.ts';

	/**
	 * The quality report (ADR 0050): per Bot × model × plan kind over the last week, how its
	 * hand-overs fared and what an approved one cost. It only reads; to act on it, pin a model.
	 * Shown once there is something to report. Rows are grouped by Bot; a Bot opens to its lines.
	 */
	interface Props {
		api: { qualityReport?: (days?: number) => Promise<QualityReportRow[]> } | null;
		locale?: 'zh' | 'en';
		/** Bumped with the spend view's own revision, so a new hand-over shows up. */
		revision?: number;
		/** The roster's Bot for an id, for its face beside its row. */
		botOf?: (id: string | null) => Bot | null;
	}

	let { api, locale = 'zh', revision = 0, botOf = () => null }: Props = $props();

	let rows = $state<QualityReportRow[]>([]);
	let open = $state<Record<string, boolean>>({});

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

	type Tally = { handOvers: number; approved: number; turnedBack: number; complaints: number; cost: number | null; costApproved: number };

	function tally(lines: QualityReportRow[]): Tally {
		const sum: Tally = { handOvers: 0, approved: 0, turnedBack: 0, complaints: 0, cost: null, costApproved: 0 };
		for (const row of lines) {
			sum.handOvers += row.hand_overs;
			sum.approved += row.approved;
			sum.turnedBack += row.review_rejected + row.user_rejected + row.checks_failed;
			sum.complaints += row.complaints;
			// Per approval only counts lines that know what they cost.
			if (row.cost_usd != null) {
				sum.cost = (sum.cost ?? 0) + row.cost_usd;
				sum.costApproved += row.approved;
			}
		}
		return sum;
	}

	const total = $derived(tally(rows));

	/** One entry per Bot, the busiest first. A deleted Bot keeps its own id, so two deleted Bots stay apart. */
	const bots = $derived.by(() => {
		const byBot = new Map<string, QualityReportRow[]>();
		for (const row of rows) byBot.set(row.bot_id, [...(byBot.get(row.bot_id) ?? []), row]);
		return [...byBot].map(([id, lines]) => ({ id, name: lines[0]!.bot_name, lines, sum: tally(lines) })).sort((a, b) => b.sum.handOvers - a.sum.handOvers || b.lines.length - a.lines.length);
	});

	/** The busiest Bots first; the rest wait behind a button. */
	const FIRST_BOTS = 5;
	let showAll = $state(false);
	const shownBots = $derived(showAll ? bots : bots.slice(0, FIRST_BOTS));

	function usd(value: number | null): string {
		if (value === null) return copy.none;
		return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
	}

	function perApproved(sum: Tally): string {
		return sum.cost != null && sum.costApproved > 0 ? usd(sum.cost / sum.costApproved) : copy.none;
	}

	function rate(sum: Tally): string {
		return sum.handOvers > 0 ? `${Math.round(Math.min(1, sum.approved / sum.handOvers) * 100)}%` : copy.none;
	}

	/** The meter's two parts, as shares of what was handed over; turned back fills what approval left. */
	function parts(sum: Tally): { approved: number; turnedBack: number } {
		if (sum.handOvers <= 0) return { approved: 0, turnedBack: 0 };
		const approved = Math.min(100, (sum.approved / sum.handOvers) * 100);
		return { approved, turnedBack: Math.min(100 - approved, (sum.turnedBack / sum.handOvers) * 100) };
	}
</script>

{#if rows.length > 0}
	<section class="quality-surface" aria-label={copy.title} data-quality-report>
		<div class="quality-head">
			<h2>{copy.title}</h2>
			<p>{copy.hint}</p>
		</div>

		<dl class="quality-kpis">
			<div>
				<dt>{copy.handOvers}</dt>
				<dd class="num">{total.handOvers}</dd>
			</div>
			<div>
				<dt>{copy.approvalRate}</dt>
				<dd class="num">{rate(total)}<span class="kpi-part">{total.approved} / {total.handOvers}</span></dd>
			</div>
			<div>
				<dt title={copy.turnedBackTitle}>{copy.turnedBack}</dt>
				<dd class="num">{total.turnedBack}</dd>
			</div>
			<div>
				<dt>{copy.complaints}</dt>
				<dd class="num">{total.complaints}</dd>
			</div>
			<div>
				<dt>{copy.perApproved}</dt>
				<dd class="num">{perApproved(total)}</dd>
			</div>
		</dl>

		<div class="bot-grid" role="list" aria-label={copy.bot}>
			<div class="bot-line bot-columns" aria-hidden="true">
				<span>{copy.bot}</span>
				<span class="legend">
					<span><i class="swatch is-approved"></i>{copy.approved}</span>
					<span><i class="swatch is-turned-back"></i>{copy.turnedBack}</span>
				</span>
				<span class="num">{copy.handOvers}</span>
				<span class="num">{copy.turnedBack}</span>
				<span class="num">{copy.complaints}</span>
				<span class="num">{copy.perApproved}</span>
			</div>
			{#each shownBots as bot (bot.id)}
				{@const part = parts(bot.sum)}
				<div class="quality-bot" role="listitem" data-quality-bot={bot.id}>
					<div class="bot-line">
						<button
							type="button"
							class="bot-toggle"
							aria-expanded={!!open[bot.id]}
							aria-label="{bot.name ?? copy.deleted} · {open[bot.id] ? copy.hideLines : copy.showLines}"
							onclick={() => (open[bot.id] = !open[bot.id])}
						>
							<span class="bot-chevron" aria-hidden="true"><SpendIcon name="chevron" /></span>
							<SpendBotFace id={bot.id} name={bot.name} bot={botOf(bot.id)} size={24} />
							<span class="bot-name">
								<span class="who">{bot.name ?? copy.deleted}</span>
								<span class="bot-sub">{copy.lines(bot.lines.length)}</span>
							</span>
						</button>
						<span class="bot-meter" title="{copy.approved} {bot.sum.approved} · {copy.turnedBack} {bot.sum.turnedBack} · {copy.handOvers} {bot.sum.handOvers}">
							<span class="meter-track" aria-hidden="true">
								<span class="is-approved" style:width="{part.approved}%"></span>
								<span class="is-turned-back" style:width="{part.turnedBack}%"></span>
							</span>
							<span class="meter-rate num">{rate(bot.sum)}</span>
						</span>
						<span class="num stat" data-label={copy.handOvers}>{bot.sum.handOvers}</span>
						<span class="num stat" data-label={copy.turnedBack}>{bot.sum.turnedBack}</span>
						<span class="num stat" data-label={copy.complaints}>{bot.sum.complaints}</span>
						<span class="num stat cost" data-label={copy.perApproved}>{perApproved(bot.sum)}</span>
					</div>
					{#if open[bot.id]}
						<div class="quality-table-wrap">
							<table class="quality-table">
								<thead>
									<tr>
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
									{#each bot.lines as row (`${row.model}|${row.plan_kind}`)}
										<tr>
											<td class="mono who">{row.model ?? copy.none}</td>
											<td class="what">{row.plan_kind ?? copy.none}</td>
											<td class="num" data-label={copy.handOvers}>{row.hand_overs}</td>
											<td class="num" data-label={copy.approved}>{row.approved}</td>
											<td class="num" data-label={copy.turnedBack} title={copy.turnedBackTitle}>{row.review_rejected} · {row.user_rejected} · {row.checks_failed}</td>
											<td class="num" data-label={copy.complaints}>{row.complaints}</td>
											<td class="num" data-label={copy.shapes}>{row.failure_shapes}</td>
											<td class="num" data-label={copy.misses}>{row.review_misses}</td>
											<td class="num cost" data-label={copy.perApproved}>{usd(row.cost_per_approved)}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</div>
			{/each}
		</div>
		{#if bots.length > FIRST_BOTS}
			<div class="more-bots">
				<button type="button" class="more-toggle" aria-expanded={showAll} onclick={() => (showAll = !showAll)}>
					{showAll ? copy.showFewer : copy.showAll(bots.length)}
				</button>
			</div>
		{/if}
	</section>
{/if}

<style>
	.quality-surface {
		flex-shrink: 0;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		min-width: 0;
		overflow: hidden;
	}

	.quality-head {
		padding: 14px 18px 8px;
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

	dl, dd, dt {
		margin: 0;
	}

	.num {
		font-variant-numeric: tabular-nums;
	}

	/* The week at a glance: five tiles in a row, wrapping on a narrow pane. */
	.quality-kpis {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
		gap: 1px;
		margin: 6px 18px 12px;
		background: var(--line-subtle);
		border: 1px solid var(--line-subtle);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}

	.quality-kpis div {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 12px;
		background: var(--pane);
		min-width: 0;
	}

	.quality-kpis dt {
		font-size: 11.5px;
		color: var(--muted);
	}

	.quality-kpis dd {
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: 18px;
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--ink);
	}

	.kpi-part {
		font-size: 11.5px;
		font-weight: 450;
		color: var(--muted);
	}

	.bot-grid {
		padding: 0 18px 10px;
	}

	/* One template for the column heads and every Bot, so the figures line up down the list. */
	.bot-line {
		display: grid;
		grid-template-columns: minmax(120px, 1.1fr) minmax(140px, 2fr) repeat(3, 56px) 72px;
		align-items: center;
		gap: 0 12px;
		min-height: 44px;
		font-size: 12.5px;
	}

	.bot-line .stat {
		text-align: right;
		color: var(--ink-secondary);
	}

	.bot-line .cost {
		font-weight: 600;
		color: var(--ink);
	}

	.bot-columns {
		min-height: 30px;
		font-size: 11.5px;
		color: var(--muted);
		border-bottom: 1px solid var(--line-subtle);
	}

	.bot-columns .num {
		text-align: right;
	}

	.legend {
		display: inline-flex;
		gap: 12px;
	}

	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.swatch {
		width: 8px;
		height: 8px;
		border-radius: 2px;
	}

	.quality-bot + .quality-bot {
		border-top: 1px solid var(--line-subtle);
	}

	.bot-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		min-height: 40px;
		padding: 0;
		border: 0;
		background: transparent;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.bot-toggle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: var(--radius-xs);
	}

	.bot-chevron {
		display: flex;
		color: var(--muted);
		transform: rotate(-90deg);
		transition: transform 0.2s ease;
	}

	.bot-chevron :global(svg) {
		width: 14px;
		height: 14px;
	}

	.bot-toggle[aria-expanded='true'] .bot-chevron {
		transform: none;
	}

	.bot-name {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.bot-name .who {
		font-weight: 600;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bot-toggle:hover .who {
		color: var(--accent);
	}

	.bot-sub {
		font-size: 11px;
		color: var(--muted);
	}

	.bot-meter {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.meter-track {
		flex: 1;
		display: flex;
		gap: 2px;
		height: 8px;
		background: var(--line-subtle);
		border-radius: var(--radius-full);
		overflow: hidden;
	}

	.meter-track span {
		display: block;
		height: 100%;
	}

	.meter-rate {
		width: 36px;
		text-align: right;
		font-weight: 600;
		color: var(--ink);
	}

	.is-approved {
		background: var(--ok);
	}

	.is-turned-back {
		background: var(--warn);
	}

	.more-bots {
		display: flex;
		justify-content: center;
		padding: 6px 12px 8px;
		border-top: 1px solid var(--line-subtle);
	}

	.more-toggle {
		min-height: 28px;
		padding: 0 6px;
		border: 0;
		background: transparent;
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		color: var(--accent);
		cursor: pointer;
	}

	.more-toggle:hover {
		text-decoration: underline;
	}

	.more-toggle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.quality-table-wrap {
		overflow-x: auto;
		margin: 0 0 10px 20px;
		border-left: 2px solid var(--line);
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

	/* Narrow: one Bot × model × plan kind per row, its counts wrapped under it, each named. */
	@container spend (max-width: 620px) {
		.quality-head {
			padding: 12px 14px 6px;
		}

		/* Three small tiles to a row; the last row's tiles share it, so no cell stands empty. */
		.quality-kpis {
			display: flex;
			flex-wrap: wrap;
			margin: 4px 14px 8px;
		}

		.quality-kpis div {
			flex: 1 1 28%;
			padding: 8px 10px;
		}

		.quality-kpis dd {
			font-size: 16px;
		}

		.bot-grid {
			padding: 0 14px 6px;
		}

		.bot-columns {
			display: none;
		}

		/*
		 * Three lines: the name with its rate at the end, the meter across the whole row, then the
		 * counts, each named. The meter's box steps aside so its bar and its rate take their own places.
		 */
		.bot-line {
			grid-template-columns: auto auto auto minmax(0, 1fr);
			grid-template-areas:
				'name name name rate'
				'track track track track';
			gap: 6px 14px;
			padding: 8px 0 10px;
		}

		.bot-toggle {
			grid-area: name;
			min-height: 32px;
		}

		.bot-name {
			flex-direction: row;
			align-items: baseline;
			gap: 8px;
		}

		.bot-sub {
			white-space: nowrap;
		}

		.bot-meter {
			display: contents;
		}

		.meter-track {
			grid-area: track;
		}

		.meter-rate {
			grid-area: rate;
			justify-self: end;
			width: auto;
		}

		.bot-line .stat {
			text-align: left;
			font-size: 12px;
		}

		.bot-line .stat::before {
			content: attr(data-label) ' ';
			color: var(--muted);
			font-weight: 400;
		}

		.quality-table-wrap {
			margin: 0 0 8px 6px;
		}

		.quality-table, .quality-table tbody {
			display: block;
		}

		.quality-table thead {
			display: none;
		}

		.quality-table tr {
			display: flex;
			flex-wrap: wrap;
			align-items: baseline;
			gap: 2px 12px;
			padding: 10px 14px;
			border-top: 1px solid var(--line-subtle);
		}

		.quality-table td {
			padding: 0;
			border: 0;
			white-space: normal;
		}

		.quality-table .who {
			font-weight: 600;
			color: var(--ink);
			font-size: 13px;
		}

		.quality-table .what {
			color: var(--muted);
		}

		/* A line break between the names and the counts. */
		.quality-table tr::before {
			content: '';
			order: 1;
			flex-basis: 100%;
		}

		.quality-table td.num {
			order: 2;
		}

		.quality-table td[data-label]::before {
			content: attr(data-label) ' ';
			color: var(--muted);
		}

		.quality-table .cost {
			font-weight: 600;
			color: var(--ink);
		}
	}
</style>
