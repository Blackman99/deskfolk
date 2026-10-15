<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Bot, TaskDetail, TicketStatus, TicketWithArtifacts } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import {
		actorFace,
		actorName,
		completionPercentage,
		countedTicketCount,
		openTicketCount,
		parkedTicketCount,
		ticketTag
	} from './plan-board.ts';
	import { stageLabel } from './ticket-labels.ts';
	import {
		LANE_GAP_UNITS,
		laneBroken,
		laneMarkWidth,
		laneX,
		nearestMark,
		ranBesides,
		ticketOwner,
		type LaneMark,
		type TicketLanes
	} from './ticket-lanes.ts';

	/**
	 * The job's tickets down the side of its trace (ADR 0086), one row each, and in every row a small
	 * lane of its turns on the axis every row shares: when work landed on it, who did it, where it was
	 * cut, how long the job sat still. A row picks its ticket; a press on its lane also brings the
	 * trace to the nearest card. The board of five columns is the rail opened out.
	 */
	interface Props {
		detail: TaskDetail;
		lanes: TicketLanes;
		bots: readonly Bot[];
		youLabel: string;
		deletedLabel: string;
		t: Copy;
		selectedId: string | null;
		/** One status the spec asked for, or every ticket. */
		statusFilter: TicketStatus | 'all';
		onPick: (ticketId: string | null) => void;
		/** A card on a ticket's lane: the ticket is picked and the trace slides to the card. */
		onPickMark: (ticketId: string | null, mark: LaneMark) => void;
		onClearFilter: () => void;
		onExpand: () => void;
	}

	let { detail, lanes, bots, youLabel, deletedLabel, t, selectedId, statusFilter, onPick, onPickMark, onClearFilter, onExpand }: Props = $props();

	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot] as const)));
	const tickets = $derived(
		[...detail.tickets].sort((a, b) => a.seq - b.seq).filter((ticket) => statusFilter === 'all' || ticket.status === statusFilter)
	);
	const counted = $derived(countedTicketCount(detail.ticket_counts));
	const done = $derived(completionPercentage(detail.ticket_counts));
	const markWidth = $derived(Math.max(laneMarkWidth(lanes) * 1000 * 0.8, 3));
	const gapWidth = $derived(laneMarkWidth(lanes) * 1000 * LANE_GAP_UNITS);

	function nameOf(actor: string): string {
		return actorName(actor, botsById, youLabel, deletedLabel);
	}

	/**
	 * A Bot's colour on a lane is its avatar's — the ink of its letter, deep enough to read as a mark
	 * a couple of pixels wide — so a mark reads as the face on its card.
	 */
	function colourOf(actor: string): string {
		const palette = actorFace(actor, botsById, youLabel, deletedLabel).palette;
		return palette?.text ?? palette?.border ?? 'var(--muted-light)';
	}

	/** Where on the lane a press landed, from 0 to 1; null when it was not on the lane. */
	function laneAt(event: MouseEvent, row: HTMLElement): number | null {
		const lane = row.querySelector<SVGElement>('.rail-lane');
		const target = event.target instanceof Element ? event.target : null;
		if (!lane || !target || !lane.contains(target)) return null;
		const box = lane.getBoundingClientRect();
		return box.width > 0 ? (event.clientX - box.left) / box.width : null;
	}

	function press(event: MouseEvent, ticket: TicketWithArtifacts): void {
		const at = laneAt(event, event.currentTarget as HTMLElement);
		const mark = at === null ? null : nearestMark(lanes, lanes.byTicket.get(ticket.id) ?? [], at);
		if (mark) {
			onPickMark(ticket.id, mark);
			return;
		}
		onPick(selectedId === ticket.id ? null : ticket.id);
	}

	function pressLoose(event: MouseEvent, marks: readonly LaneMark[]): void {
		const at = laneAt(event, event.currentTarget as HTMLElement);
		const mark = at === null ? null : nearestMark(lanes, marks, at);
		if (mark) onPickMark(null, mark);
	}

	/** Up and down walk the rows; the press itself is a button's. */
	function walk(event: KeyboardEvent): void {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		const rows = [...((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.rail-row'))];
		const at = rows.indexOf(document.activeElement as HTMLElement);
		const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
		if (!next) return;
		event.preventDefault();
		next.focus();
	}
</script>

{#snippet lane(marks: readonly LaneMark[], label: string)}
	<svg class="rail-lane" viewBox="0 0 1000 10" preserveAspectRatio="none" role="img" aria-label={label}>
		<line class="rail-lane-axis" x1="0" x2="1000" y1="5" y2="5" vector-effect="non-scaling-stroke" />
		{#each lanes.gaps as gap (gap.col)}
			<rect class="rail-lane-gap" x={laneX(lanes, gap.col) * 1000 - gapWidth} width={gapWidth * 0.5} y="0" height="10">
				<title>{t.plan.job.gap(gap.ms / 60_000)}</title>
			</rect>
		{/each}
		{#each marks as mark (mark.turnId)}
			{#if laneBroken(mark.status)}
				<rect class="rail-mark is-broken" x={laneX(lanes, mark.col) * 1000} width={markWidth} y="1.5" height="7" style:stroke={colourOf(mark.actor)} vector-effect="non-scaling-stroke" />
			{:else}
				<rect class="rail-mark" class:is-mine={mark.mine} x={laneX(lanes, mark.col) * 1000} width={markWidth} y="1" height="8" style:fill={mark.mine ? undefined : colourOf(mark.actor)} />
			{/if}
		{/each}
	</svg>
{/snippet}

<section class="ticket-rail" aria-label={t.plan.job.railTitle}>
	<header class="rail-head">
		<span class="rail-title">{t.plan.job.railTitle}</span>
		<span class="rail-counts">{t.plan.ticketCounts(openTicketCount(detail.ticket_counts), counted, parkedTicketCount(detail.ticket_counts))}</span>
		{#if counted > 0}
			<span class="rail-done mono" class:is-done={done === 100}>{done}%</span>
		{/if}
		<button type="button" class="rail-expand" title={t.plan.job.expandBoard} aria-label={t.plan.job.expandBoard} onclick={onExpand}>
			<Icon name="kanban" />
		</button>
	</header>
	{#if statusFilter !== 'all'}
		<div class="rail-filter">
			<span>{t.plan.job.filtered(t.plan.ticketStatus[statusFilter])}</span>
			<button type="button" class="rail-filter-clear" onclick={onClearFilter}>{t.plan.job.clearFilter}</button>
		</div>
	{/if}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<ol class="rail-rows" onkeydown={walk}>
		{#if lanes.yours.length > 0}
			<li class="rail-context">
				<span class="rail-row-top">
					<span class="rail-title-text is-quiet">{t.plan.job.yours}</span>
					<span class="rail-count mono">{lanes.yours.length}</span>
				</span>
				{@render lane(lanes.yours, t.plan.job.yours)}
			</li>
		{/if}
		{#each tickets as ticket (ticket.id)}
			{@const marks = lanes.byTicket.get(ticket.id) ?? []}
			{@const owner = ticketOwner(ticket)}
			{@const face = owner ? actorFace(owner, botsById, youLabel, deletedLabel) : null}
			{@const reviewer = ticket.reviewer_bot_id ? actorFace(ticket.reviewer_bot_id, botsById, youLabel, deletedLabel) : null}
			{@const besides = ranBesides(ticket, lanes.ranBy.get(ticket.id))}
			<li>
				<button
					type="button"
					class="rail-row"
					class:is-picked={ticket.id === selectedId}
					aria-pressed={ticket.id === selectedId}
					data-rail-ticket={ticket.id}
					onclick={(event) => press(event, ticket)}
				>
					<span class="rail-row-top">
						<span class="rail-tag mono">{ticketTag(ticket.seq)}</span>
						<span class="rail-title-text" title={ticket.title}>{ticket.title}</span>
						{#if owner && face}
							<span
								class="rail-avatar"
								title={nameOf(owner)}
								style:background={face.palette?.bg}
								style:color={face.palette?.text}
								style:border-color={face.palette?.border}
							>
								{#if face.src}<img src={face.src} alt="" />{:else}{face.letter}{/if}
							</span>
						{/if}
						{#if ticket.reviewer_bot_id && reviewer}
							<span
								class="rail-avatar is-reviewer"
								title={t.plan.reviewedBy(nameOf(ticket.reviewer_bot_id))}
								style:background={reviewer.palette?.bg}
								style:color={reviewer.palette?.text}
								style:border-color={reviewer.palette?.border}
							>
								{#if reviewer.src}<img src={reviewer.src} alt="" />{:else}{reviewer.letter}{/if}
							</span>
						{/if}
						<span class="rail-stage is-{ticket.status}">{stageLabel(ticket, t)}</span>
						<span class="rail-count mono" title={t.plan.job.turns(marks.length)}>{marks.length}</span>
					</span>
					{#if besides}
						<!-- Who works it, where that is not its owner alone: the record and the work, side by side. -->
						<span class="rail-besides" data-rail-besides={besides.kind}>
							{(besides.kind === 'instead' ? t.plan.job.ranInstead : t.plan.job.ranAlso)(besides.bots.map(nameOf).join('、'))}
						</span>
					{/if}
					{@render lane(marks, t.plan.job.turns(marks.length))}
				</button>
			</li>
		{/each}
		{#if lanes.loose.length > 0}
			<li>
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div class="rail-context is-loose" title={t.plan.job.looseHint} onclick={(event) => pressLoose(event, lanes.loose)}>
					<span class="rail-row-top">
						<span class="rail-title-text is-quiet">{t.plan.job.loose}</span>
						<span class="rail-count mono">{lanes.loose.length}</span>
					</span>
					{@render lane(lanes.loose, t.plan.job.loose)}
				</div>
			</li>
		{/if}
	</ol>
	{#if tickets.length === 0 && statusFilter === 'all'}
		<p class="rail-empty">{t.plan.job.noTickets}</p>
	{/if}
</section>

<style>
	/* A column of rows, scrolling on its own under a head that stays put. */
	.ticket-rail {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		height: 100%;
		background: var(--pane);
	}

	.rail-head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 10px 8px 12px;
		border-bottom: 1px solid var(--line-subtle);
	}

	.rail-title {
		font-size: 12px;
		font-weight: 700;
		color: var(--ink);
	}

	.rail-counts {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--muted);
	}

	.rail-done {
		padding: 0 6px;
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--muted);
		font-size: 10px;
		font-weight: 700;
		line-height: 16px;
	}

	.rail-done.is-done {
		background: var(--ok-bg);
		color: var(--ok-text);
	}

	.rail-expand {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.rail-expand:hover {
		border-color: var(--line);
		background: var(--line-subtle);
		color: var(--ink);
	}

	.rail-filter {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 12px;
		border-bottom: 1px solid var(--line-subtle);
		background: var(--accent-tint);
		font-size: 11px;
		color: var(--accent);
	}

	.rail-filter-clear {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.rail-rows {
		flex: 1;
		min-height: 0;
		margin: 0;
		padding: 0;
		list-style: none;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.rail-row,
	.rail-context {
		display: flex;
		flex-direction: column;
		gap: 5px;
		width: 100%;
		box-sizing: border-box;
		padding: 7px 10px 6px 12px;
		border: 0;
		border-bottom: 1px solid var(--line-subtle);
		background: transparent;
		color: var(--ink);
		font: inherit;
		text-align: left;
	}

	.rail-row {
		cursor: pointer;
	}

	.rail-row:hover,
	.rail-context.is-loose:hover {
		background: var(--line-subtle);
	}

	/* Picked is something you did, so it is the interaction colour. */
	.rail-row.is-picked {
		background: var(--accent-tint);
	}

	.rail-row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.rail-context.is-loose {
		cursor: pointer;
	}

	.rail-row-top {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-size: 12.5px;
	}

	.rail-tag {
		flex: none;
		font-size: 11px;
		color: var(--muted);
	}

	.rail-title-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rail-title-text.is-quiet {
		color: var(--muted);
		font-size: 12px;
	}

	.rail-avatar {
		flex: none;
		width: 16px;
		height: 16px;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: 50%;
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		user-select: none;
	}

	/* The reviewer beside the owner, a size down. */
	.rail-avatar.is-reviewer {
		width: 13px;
		height: 13px;
		margin-left: -3px;
		font-size: 8px;
	}

	.rail-besides {
		display: block;
		margin-top: -2px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--warn-text);
	}

	.rail-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	/* The status as the board's pill says it, its dot in the column's colour. */
	.rail-stage {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		white-space: nowrap;
		color: var(--muted);
	}

	.rail-stage::before {
		content: "";
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}

	.rail-stage.is-doing {
		color: var(--accent);
	}

	.rail-stage.is-review {
		color: var(--purple);
	}

	.rail-stage.is-done {
		color: var(--ok-text);
	}

	.rail-count {
		flex: none;
		min-width: 18px;
		text-align: right;
		font-size: 10.5px;
		color: var(--muted);
	}

	.rail-lane {
		display: block;
		width: 100%;
		height: 10px;
		overflow: visible;
	}

	.rail-lane-axis {
		stroke: var(--line);
		stroke-width: 1;
	}

	.rail-lane-gap {
		fill: var(--line);
	}

	.rail-mark {
		fill: var(--muted-light);
	}

	/* Your own lines and decisions, quieter than any Bot's turn. */
	.rail-mark.is-mine {
		fill: var(--ink-secondary);
		opacity: 0.55;
	}

	/* A turn that was stopped or cut: its outline only. */
	.rail-mark.is-broken {
		fill: var(--pane);
		stroke-width: 1.2;
		stroke-dasharray: 2 1.5;
	}

	.rail-empty {
		margin: 14px 12px;
		font-size: 12px;
		color: var(--muted);
	}
</style>
