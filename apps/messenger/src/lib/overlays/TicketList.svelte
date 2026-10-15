<script lang="ts">
	import Icon from '../Icon.svelte';
	import { tick, untrack } from 'svelte';
	import type { Bot, Provider, TaskDetail, TaskTraceNode, Ticket, TicketStatus, TicketWithArtifacts } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import Select from '../Select.svelte';
	import {
		TICKET_STATUS_ORDER,
		actorFace,
		actorName,
		boardState,
		completionPercentage,
		countedTicketCount,
		dependsTags,
		latestTurnOfTicket,
		openTicketCount,
		parkedTicketCount,
		ticketTag,
		totalTicketCount
	} from './plan-board.ts';
	import { boardColumns } from './ticket-board.ts';
	import { beginCardDrag, type CardDrag } from './ticket-board-drag.ts';
	import { TicketEdits } from './ticket-edits.svelte.ts';
	import { ballLabel, canMakeSample, isDropped, stageLabel, statusOptionsFor } from './ticket-labels.ts';
	import TicketConfirm from './TicketConfirm.svelte';
	import TicketDepends from './TicketDepends.svelte';
	import TicketDetail from './TicketDetail.svelte';

	interface Props {
		api: MessengerApi | null;
		detail: TaskDetail;
		nodes: readonly TaskTraceNode[];
		bots: readonly Bot[];
		youLabel: string;
		deletedLabel: string;
		t: Copy;
		/** The ticket whose cards are lit on the board; null lights nothing. */
		selectedId: string | null;
		/** The endpoints, for a ticket's model menu (level 7). */
		providers?: readonly Provider[];
		onSelect: (ticketId: string | null) => void;
		onJump: (sessionId: string, messageId: string) => void;
		onOpenArtifacts: (ticket: TicketWithArtifacts) => void;
		onPatched: (ticket: Ticket) => void;
		onConflict: () => void;
		/** The column the spec asked to bring into view; 'all' lights none. Cards are never hidden by it. */
		statusFilter?: TicketStatus | 'all';
		/** Open the spec the tickets answer to, keeping the picked ticket picked. */
		onShowSpec?: () => void;
		/** Show the picked ticket's work on the trace: its rounds lit, its newest card in view. */
		onShowInTrace?: (ticketId: string) => void;
		/** The job's one queue of ticket edits, shared with the inspector; left out, the board keeps its own. */
		edits?: TicketEdits;
		/** Whether the picked card unfolds what it answers to and its settings; off where the inspector shows them. */
		details?: boolean;
	}

	let {
		api,
		detail,
		nodes,
		bots,
		youLabel,
		deletedLabel,
		t,
		selectedId,
		providers = [],
		onSelect,
		onJump,
		onOpenArtifacts,
		onPatched,
		onConflict,
		statusFilter = $bindable('all'),
		onShowSpec,
		onShowInTrace,
		edits: sharedEdits,
		details = true
	}: Props = $props();

	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot] as const)));
	const tickets = $derived([...detail.tickets].sort((a, b) => a.seq - b.seq));

	/** Status moves and the picked ticket's settings, through the plan's one queue of edits. */
	const edits =
		untrack(() => sharedEdits) ??
		new TicketEdits({
			api: () => api,
			detail: () => detail,
			t: () => t,
			providers: () => providers,
			onPatched: (ticket) => onPatched(ticket),
			onConflict: () => onConflict()
		});
	$effect(() => edits.attachFocus({ cardHasFocus, keepFocus }));
	/** The card under the pointer, once the press has travelled far enough to be a drag. */
	let drag = $state<CardDrag | null>(null);
	/** The column elements, so a lit column can be scrolled into view. */
	let columnFocus = $state<Partial<Record<TicketStatus, HTMLElement>>>({});
	/** This list. Cards are looked up inside it: another pane can show the same plan. */
	let rootEl = $state<HTMLElement | null>(null);

	const totalTickets = $derived(totalTicketCount(detail.ticket_counts));
	/** The tickets the percentage is a share of: dropped and set-aside ones are not work to do. */
	const countedTickets = $derived(countedTicketCount(detail.ticket_counts));
	const completionPct = $derived(completionPercentage(detail.ticket_counts));
	/** The job is over, set aside or dormant: nobody picks up a ticket left open (the daemon's ball does not move in it). */
	const boardSettled = $derived(boardState(detail));
	const settledChip = $derived(boardSettled === 'dormant' ? t.plan.dormant : boardSettled === 'parked' ? t.plan.status.parked : t.plan.status.done);
	/** The hint says tickets are left open, so it waits for one to be. */
	const hasOpenCards = $derived(tickets.some((row) => row.status === 'todo' || row.status === 'doing' || row.status === 'review'));
	const columns = $derived(boardColumns(tickets, edits.optimistic));

	$effect(() => {
		if (statusFilter === 'all') return;
		columnFocus[statusFilter]?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
	});

	/** The plan the conflict line belongs to. A different one clears the line; the first read only records it. */
	let conflictFor = $state<string | null>(null);
	$effect(() => {
		const id = detail.id;
		if (conflictFor === null || id === conflictFor) {
			conflictFor = id;
			return;
		}
		conflictFor = id;
		edits.conflictNote = false;
	});

	function select(ticketId: string): void {
		onSelect(selectedId === ticketId ? null : ticketId);
	}

	function dependsLabel(ticket: TicketWithArtifacts): string | null {
		const tags = dependsTags(ticket, detail.tickets);
		return tags ? t.plan.dependsOn(tags) : null;
	}


	let dependsOpen = $state<string | null>(null);

	/** Your local agents, asked once the board offers a ticket's model: their models can be a ticket's too (ADR 0079). */
	$effect(() => {
		edits.loadModels();
	});

	function cardRow(ticketId: string): HTMLElement | null {
		return rootEl?.querySelector<HTMLElement>(`[data-ticket-id="${ticketId}"]`) ?? null;
	}

	function cardHasFocus(ticketId: string): boolean {
		const row = cardRow(ticketId);
		return !!row && row.contains(document.activeElement);
	}

	async function focusCard(ticketId: string): Promise<void> {
		await tick();
		cardRow(ticketId)?.querySelector<HTMLElement>('.ticket-main')?.focus();
	}

	/**
	 * A card that had the focus mounts again in its new column, so the focus is put back on it —
	 * unless something else took it meanwhile (you went on typing elsewhere): that one keeps it.
	 */
	async function keepFocus(ticketId: string): Promise<void> {
		await tick();
		const active = document.activeElement;
		if (active && active !== document.body && active.isConnected) return;
		cardRow(ticketId)?.querySelector<HTMLElement>('.ticket-main')?.focus();
	}

	/** A press on the card. Touch scrolls the board; it does not drag. */
	function pressCard(event: PointerEvent, ticket: TicketWithArtifacts): void {
		if (!api) return;
		beginCardDrag(event, ticket.id, {
			from: () => edits.columnOfTicket(ticket),
			busy: () => edits.patchingId === ticket.id,
			onDrag: (next) => (drag = next),
			onDrop: (status) => edits.requestStatus(ticket, status)
		});
	}

	/** Left and right move the focus to the neighbouring column. They do not change a status. */
	function moveFocus(event: KeyboardEvent, ticket: TicketWithArtifacts): void {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		const drawn = edits.columnOfTicket(ticket);
		const index = TICKET_STATUS_ORDER.indexOf(drawn);
		const next = TICKET_STATUS_ORDER[index + (event.key === 'ArrowRight' ? 1 : -1)];
		if (!next) return;
		event.preventDefault();
		const column = columns.find((entry) => entry.status === next);
		const at = column?.tickets.findIndex((row) => row.seq >= ticket.seq) ?? -1;
		const target = column?.tickets[at >= 0 ? at : 0];
		if (!target) return;
		void focusCard(target.id);
	}
</script>

<section class="ticket-list" aria-label={t.plan.tickets} bind:this={rootEl}>
	<div class="ticket-list-header-group">
		<div class="ticket-list-head">
			<div class="ticket-list-title-wrap">
				<Icon name="check-square" class="ticket-title-icon" />
				<span class="ticket-list-title">{t.plan.tickets}</span>
				{#if boardSettled}
					<span class="ticket-settled-chip is-{boardSettled}">{settledChip}</span>
				{/if}
			</div>
			<div class="ticket-list-counts-wrap">
				<span class="ticket-list-counts">{t.plan.ticketCounts(openTicketCount(detail.ticket_counts), countedTickets, parkedTicketCount(detail.ticket_counts))}</span>
				{#if countedTickets > 0}
					<span class="ticket-completion-pill mono" class:is-done={completionPct === 100}>{completionPct}%</span>
				{/if}
			</div>
		</div>

		{#if countedTickets > 0}
			<div class="ticket-progress-track" aria-hidden="true">
				<div class="ticket-progress-fill" style:width="{completionPct}%"></div>
			</div>
		{/if}

		{#if boardSettled && hasOpenCards}
			<!-- Said once, in a line, and it does not promise the job picks up again when a ticket moves. -->
			<p class="ticket-settled-hint">{t.plan.board.settled[boardSettled]}</p>
		{/if}
		{#if tickets.length > 0}
			<p class="ticket-list-hint">{t.plan.links.ticketsHint}</p>
		{/if}
		{#if edits.conflictNote}
			<p class="ticket-board-conflict">{t.plan.board.conflictDropped}</p>
		{/if}
	</div>

	{#if tickets.length === 0}
		<p class="ticket-list-empty">{t.plan.ticketsNone}</p>
	{:else}
		<div class="ticket-board" class:is-settled={boardSettled !== null}>
			{#each columns as column (column.status)}
				<section
					class="ticket-column is-{column.status}"
					class:is-focused={statusFilter === column.status}
					class:is-drop={drag?.over === column.status && drag.from !== column.status}
					data-board-status={column.status}
					bind:this={columnFocus[column.status]}
					aria-label={t.plan.ticketStatus[column.status]}
				>
					<header class="ticket-column-head">
						<span class="ticket-column-name">{t.plan.ticketStatus[column.status]}</span>
						<span class="ticket-column-count mono">{column.tickets.length}</span>
						{#if statusFilter === column.status}
							<button type="button" class="ticket-column-clear" onclick={() => (statusFilter = 'all')}>{t.plan.board.focusClear}</button>
						{/if}
					</header>
					<div class="ticket-column-cards">
						{#if column.tickets.length === 0}
							<p class="ticket-column-empty">{t.plan.board.emptyColumn}</p>
						{/if}
			{#each column.tickets as ticket (ticket.id)}
				{@const face = actorFace(ticket.worker ?? '', botsById, youLabel, deletedLabel)}
				{@const node = latestTurnOfTicket(nodes, ticket.id)}
				{@const picked = ticket.id === selectedId}
				{@const ball = ballLabel(ticket, detail, t, (id) => actorName(id, botsById, youLabel, deletedLabel))}
				<!-- A closed ticket waits on nothing and nobody is still on it: 「已通过 · 设计师在做 · 要等 #02」 read as contradictory (2026-10-03). -->
				{@const closed = ticket.status === 'done' || ticket.status === 'parked'}
				{@const waits = closed ? null : dependsLabel(ticket)}
				<!-- Making a ticket the sample is offered on the picked card, where its other actions are. -->
				{@const sampleable = Boolean(api) && picked && canMakeSample(ticket, detail)}
				<!-- A press on the card drags it; from the keyboard the status menu moves it. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="ticket-row is-{edits.columnOfTicket(ticket)}"
					class:is-selected={picked}
					class:is-dragging={drag?.ticketId === ticket.id}
					data-ticket-id={ticket.id}
					title={api ? t.plan.board.dragHint : undefined}
					onpointerdown={(event) => pressCard(event, ticket)}
				>
					<div class="ticket-head">
						<button type="button" class="ticket-main" aria-pressed={picked} onclick={() => select(ticket.id)} onkeydown={(event) => moveFocus(event, ticket)}>
							<span class="ticket-tag mono">{ticketTag(ticket.seq)}</span>
							<span class="ticket-title">{ticket.title}</span>
							{#if ticket.sample}<span class="ticket-sample" title={t.plan.sampleHint}>{t.plan.sample}</span>{/if}
						</button>
						{#if ticket.parts && ticket.parts.total > 0}
							<span class="ticket-parts mono">{t.plan.partsApproved(ticket.parts.approved, ticket.parts.total)}</span>
						{/if}
						<!-- The status is its own menu: one place says it and changes it. -->
						{#if api}
							<Select
								class="ticket-status is-{ticket.status}"
								value={ticket.status}
								options={statusOptionsFor(ticket, t)}
								size="sm"
								ariaLabel={t.plan.changeStatus}
								disabled={edits.patchingId === ticket.id}
								onchange={(value) => edits.changeStatus(ticket, value)}
							/>
						{:else}
							<span class="ticket-status is-{ticket.status}">{stageLabel(ticket, t)}</span>
						{/if}
					</div>
					<!-- The rest of the card picks it too, as the title does; the title is the control a keyboard reaches. -->
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
					<div class="ticket-body" onclick={() => select(ticket.id)}>
						<div class="ticket-meta">
							<!-- Set aside or dropped, it is nobody's: no 「X做的」 for work never done. -->
							{#if ticket.status !== 'parked'}
							<span class="ticket-who">
								{#if ticket.worker}
									<span
										class="ticket-avatar"
										style:background={face.palette?.bg}
										style:color={face.palette?.text}
										style:border-color={face.palette?.border}
										aria-hidden="true"
									>
										{#if face.src}
											<img src={face.src} alt="" class="ticket-avatar-img" />
										{:else}
											{face.letter}
										{/if}
									</span>
								{:else}
									<span class="ticket-avatar is-nobody" aria-hidden="true">
										<Icon name="user" size={12} />
									</span>
								{/if}
								<span class="ticket-who-text">
									{ticket.worker ? (closed ? t.plan.workerDone(actorName(ticket.worker, botsById, youLabel, deletedLabel)) : t.plan.worker(actorName(ticket.worker, botsById, youLabel, deletedLabel), ticket.status !== "todo")) : t.plan.nobody}
								</span>
							</span>
							{/if}
							{#if ball}<span class="ticket-meta-item ticket-ball">{ball}</span>{/if}
							{#if waits}<span class="ticket-meta-item ticket-depends">{waits}</span>{/if}
							<!-- Picked, the menus below say these; otherwise the line does, only when one is set. -->
							{#if !picked && detail.submissions_on && ticket.reviewer_bot_id}
								<span class="ticket-meta-item ticket-meta-reviewer">{t.plan.reviewedBy(actorName(ticket.reviewer_bot_id, botsById, youLabel, deletedLabel))}</span>
							{/if}
							{#if !picked && detail.routing_on && ticket.model_override}
								<span class="ticket-meta-item ticket-meta-model mono">{t.plan.onModel(ticket.model_override.model)}</span>
							{/if}
							<!-- Why its lead dropped it, on a line of its own: no 「·」 in front of it. -->
							{#if isDropped(ticket) && ticket.dropped_why}
								<span class="ticket-dropped-why">{t.plan.droppedWhy(ticket.dropped_why)}</span>
							{/if}
						</div>
						{#if ticket.spec}
							<p class="ticket-spec">{ticket.spec}</p>
						{/if}
					</div>
					{#if ticket.artifacts.length > 0 || node || (picked && onShowInTrace) || sampleable}
						<div class="ticket-links">
							{#if ticket.artifacts.length > 0}
								<button type="button" class="ticket-artifacts" onclick={() => onOpenArtifacts(ticket)}>
									<Icon name="file" size={12} />
									<span>{t.plan.artifacts(ticket.artifacts.length)}</span>
								</button>
							{/if}
							{#if node}
								<button type="button" class="ticket-jump" onclick={() => onJump(node.session_id, node.focus_message_id)}>
									<Icon name="corner-down-left" size={12} />
									<span>{t.plan.jumpToTurn}</span>
								</button>
							{/if}
							{#if picked && node && onShowInTrace}
								<!-- The board hides the trace; this brings it back on the picked ticket's rounds. -->
								<button type="button" class="ticket-jump ticket-show-trace" onclick={() => onShowInTrace(ticket.id)}>
									<Icon name="hierarchy" size={12} />
									<span>{t.plan.links.showInTrace}</span>
								</button>
							{/if}
							{#if sampleable}
								<button type="button" class="ticket-jump ticket-make-sample" title={t.plan.makeSampleHint} disabled={edits.patchingId === ticket.id} onclick={() => edits.makeSample(ticket)}>
									<Icon name="star" size={12} />
									<span>{t.plan.makeSample}</span>
								</button>
							{/if}
						</div>
					{/if}
					{#if details && picked}
						<TicketDetail {api} {detail} {ticket} {t} {bots} {youLabel} {deletedLabel} {edits} {onShowSpec} bind:dependsOpen />
					{/if}
					{#if details && dependsOpen === ticket.id}
						<TicketDepends {detail} {ticket} {t} {edits} />
					{/if}
					<TicketConfirm {ticket} {t} {edits} />
				</div>
						{/each}
					</div>
				</section>
			{/each}
		</div>
	{/if}
	{#if drag}
		{@const dragging = drag}
		{@const ghost = tickets.find((row) => row.id === dragging.ticketId)}
		{#if ghost}
			<div class="ticket-ghost" style:left="{dragging.x}px" style:top="{dragging.y}px">
				<span class="ticket-tag mono">{ticketTag(ghost.seq)}</span>
				<span>{ghost.title}</span>
			</div>
		{/if}
	{/if}
</section>

<style>
	/* The list fills its view: the heading on top, the board in all the height left under it. */
	.ticket-list {
		display: flex;
		flex-direction: column;
		flex: 1;
		gap: 10px;
		min-width: 0;
		min-height: 0;
		height: 100%;
		padding: 12px 14px 14px;
		font: 12px/1.5 var(--font);
		color: var(--ink-secondary);
	}

	.ticket-list-header-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.ticket-list-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}

	.ticket-list-title-wrap {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.ticket-list-title-wrap :global(.ticket-title-icon) {
		color: var(--accent);
		flex: none;
	}

	.ticket-list-title {
		font-weight: 700;
		font-size: 13px;
		color: var(--ink);
		letter-spacing: -0.01em;
	}

	.ticket-list-counts-wrap {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: none;
	}

	.ticket-list-counts {
		font-size: 11px;
		color: var(--muted);
	}

	.ticket-completion-pill {
		padding: 1px 5px;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 10px;
		font-weight: 700;
	}

	.ticket-completion-pill.is-done {
		background: var(--ok-bg);
		color: var(--ok-text);
	}

	/*
	 * A job nobody works on any more: the board's own word for it, as quiet as the header's status
	 * pill (the same shape; dormant dashed, like the header's) — it says what is, it asks for nothing.
	 */
	.ticket-settled-chip {
		display: inline-block;
		padding: 0 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--muted);
		font-size: 11px;
		font-weight: 600;
		line-height: 16px;
		white-space: nowrap;
	}

	.ticket-settled-chip.is-ended {
		border-color: var(--ok-line);
		background: var(--ok-bg);
		color: var(--ok-text);
	}

	.ticket-settled-chip.is-dormant {
		border-style: dashed;
		border-color: var(--line-hover);
		background: transparent;
	}

	.ticket-settled-hint {
		margin: 0;
		font-size: 11px;
		line-height: 1.45;
		color: var(--muted);
	}

	/* Progress bar */
	.ticket-progress-track {
		width: 100%;
		height: 3px;
		border-radius: var(--radius-full);
		background: var(--line);
		overflow: hidden;
	}

	.ticket-progress-fill {
		height: 100%;
		border-radius: var(--radius-full);
		background: var(--ok);
		transition: width 0.3s ease;
	}

	/* Empty state */
	.ticket-list-empty {
		margin: 12px 0;
		padding: 16px 12px;
		text-align: center;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		font-size: 12px;
		color: var(--muted);
	}

	.ticket-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 10px 8px 9px;
		border: 1px solid var(--line);
		border-left: 3.5px solid var(--muted-light);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: 0 1px 2px rgba(18, 28, 32, 0.03);
		transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.1s ease;
	}

	/*
	 * The status menu hangs out of the card over the ones below, so the card itself clips
	 * nothing (`.ticket-main` clips the text), and the one whose menu is open sits on top —
	 * at full opacity, or a parked card would show the next card through its menu.
	 */
	.ticket-row:has(:global(.real-select.is-open)) {
		position: relative;
		z-index: 1;
		opacity: 1;
	}

	/*
	 * On a settled board the cards still open are the ones nobody will pick up: they sit back, their
	 * accent off — a doing or review card drawn as a todo one, only fainter. Moving or opening them
	 * still works; and the one picked, or whose menu is open, comes forward again.
	 */
	.ticket-board.is-settled .ticket-row.is-todo,
	.ticket-board.is-settled .ticket-row.is-doing,
	.ticket-board.is-settled .ticket-row.is-review {
		border-color: var(--line);
		border-left-color: var(--muted-light);
		background: var(--pane);
		opacity: 0.55;
	}

	/* The one picked, or with its menu open, comes forward: it is the one being read. */
	.ticket-board.is-settled .ticket-row.is-selected,
	.ticket-board.is-settled .ticket-row:has(:global(.real-select.is-open)) {
		opacity: 1;
	}

	.ticket-row:hover {
		border-color: var(--line-hover);
		box-shadow: var(--shadow-xs);
	}

	.ticket-row.is-doing {
		/* The solid accent, not `--accent-border`: in the dark that wash is the same grey-teal as a
		   done row's line. */
		border-color: var(--accent);
		border-left-color: var(--accent);
		background: linear-gradient(135deg, var(--accent-tint) 0%, var(--pane) 50%);
	}

	.ticket-row.is-review {
		border-color: var(--purple);
		border-left-color: var(--purple);
		background: linear-gradient(135deg, var(--purple-bg) 0%, var(--pane) 50%);
	}

	.ticket-row.is-done {
		/* The solid green, not `--ok-line`: in the dark that wash reads as the same teal as a row
		   that is still being done. */
		border-color: var(--ok);
		border-left-color: var(--ok);
		background: linear-gradient(135deg, var(--ok-bg) 0%, var(--pane) 50%);
	}

	.ticket-row.is-todo {
		border-color: var(--line);
		border-left-color: var(--muted-light);
		background: var(--pane);
	}

	.ticket-row.is-parked {
		border-color: var(--line);
		border-left-color: var(--muted);
		background: var(--chip);
		opacity: 0.85;
	}

	.ticket-row.is-selected {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
		box-shadow: 0 0 0 1px var(--accent), var(--shadow-sm);
	}

	/* Title row: the title picks the ticket; the status beside it is its own menu. */
	/*
	 * A card is a column wide: the title keeps room to be read, and the status menu goes under it
	 * when both do not fit on one line — a long stage name never squeezes the title to nothing.
	 */
	.ticket-head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 4px 6px;
		min-width: 0;
	}

	.ticket-main {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		flex: 1 1 140px;
		min-width: 0;
		padding: 0;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		font: inherit;
		color: inherit;
	}

	.ticket-main:hover .ticket-title {
		color: var(--accent);
	}

	.ticket-tag {
		flex: none;
		font-size: 10px;
		font-weight: 700;
		color: var(--muted);
		background: var(--line-subtle);
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		line-height: 14px;
	}

	/* Two lines before it gives up: a ticket's title is most of what a card says. */
	.ticket-title {
		flex: 1 1 auto;
		min-width: 0;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
		font-size: 13px;
		line-height: 1.4;
		font-weight: 600;
		color: var(--ink);
		letter-spacing: -0.01em;
		transition: color 0.12s ease;
	}

	/* The job's sample (ADR 0060): a quiet tag beside its title, not a status. */
	.ticket-sample {
		flex: none;
		padding: 0 5px;
		border: 1px solid var(--line);
		border-radius: 4px;
		font-size: 10.5px;
		line-height: 16px;
		color: var(--ink-secondary);
	}

	.ticket-parts {
		flex: none;
		font-size: 10.5px;
		color: var(--muted);
	}

	/* The status, as a pill: plain text without an api, its own menu with one. */
	.ticket-status {
		display: inline-flex;
		align-items: center;
		flex: none;
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
	}

	span.ticket-status::before,
	.ticket-head :global(.ticket-status .real-select-trigger)::before {
		content: "";
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
		flex: none;
	}

	span.ticket-status::before {
		margin-right: 4px;
	}

	.ticket-head :global(.real-select.ticket-status) {
		width: auto;
	}

	.ticket-head :global(.ticket-status .real-select-trigger) {
		gap: 4px;
		padding: 2px 4px 2px 7px;
		border-color: transparent;
		border-radius: var(--radius-full);
		background: transparent;
		box-shadow: none;
		font-size: 11px;
		font-weight: 600;
		line-height: 16px;
		color: inherit;
	}

	.ticket-head :global(.ticket-status .real-select-trigger:hover:not(:disabled)) {
		border-color: var(--line);
		background: var(--line-subtle);
	}

	.ticket-head :global(.ticket-status .real-select-value) {
		color: inherit;
		font-weight: 600;
	}

	.ticket-head :global(.ticket-status .real-select-arrow) {
		color: inherit;
		opacity: 0.7;
	}

	.ticket-head :global(.ticket-status .real-select-arrow svg) {
		width: 11px;
		height: 11px;
	}

	.ticket-status.is-doing,
	.ticket-head :global(.ticket-status.is-doing) {
		color: var(--accent);
	}

	.ticket-status.is-review,
	.ticket-head :global(.ticket-status.is-review) {
		color: var(--purple);
	}

	.ticket-status.is-done,
	.ticket-head :global(.ticket-status.is-done) {
		color: var(--ok-text);
	}

	.ticket-status.is-todo,
	.ticket-status.is-parked,
	.ticket-head :global(.ticket-status.is-todo),
	.ticket-head :global(.ticket-status.is-parked) {
		color: var(--muted);
	}

	/* Who is on it, who has the ball, what it waits for: one line that wraps. The card picks the ticket too. */
	.ticket-body {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
		cursor: pointer;
	}

	.ticket-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px 0;
		min-width: 0;
		font-size: 11px;
		color: var(--muted);
	}

	.ticket-meta-item {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.ticket-meta-item::before {
		content: "·";
		margin: 0 5px;
		color: var(--muted-light);
	}

	.ticket-ball {
		color: var(--ink-secondary);
	}

	/* Why its lead dropped it: muted, a line of its own, no leading dot. */
	.ticket-dropped-why {
		flex: 1 1 100%;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--muted);
	}

	/* Worker line */
	.ticket-who {
		display: flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
	}

	.ticket-avatar {
		width: 16px;
		height: 16px;
		flex: none;
		border-radius: 50%;
		border: 1px solid var(--line);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		user-select: none;
	}

	.ticket-avatar.is-nobody {
		background: var(--line-subtle);
		color: var(--muted-light);
	}

	.ticket-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.ticket-who-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--muted);
	}

	.ticket-spec {
		margin: 0;
		box-sizing: border-box;
		font-size: 12px;
		color: var(--ink-secondary);
		line-height: 1.4;
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		/*
		 * The top and bottom inset is a transparent border, not padding: overflow clips at the
		 * padding edge, so bottom padding would show the top of the third line under the clamp.
		 */
		padding: 0 6px;
		border-block: 3px solid transparent;
		border-radius: var(--radius-xs);
		background: var(--line-subtle);
	}

	/* The ticket's files and its latest turn: light links, one line. */
	.ticket-links {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px 10px;
		margin-left: -4px;
	}

	.ticket-artifacts,
	.ticket-jump {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 11px;
		font-weight: 500;
		line-height: 1;
		padding: 3px 4px;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.ticket-artifacts:hover,
	.ticket-jump:hover {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.ticket-list-hint {
		margin: 0;
		font-size: 11px;
		line-height: 1.45;
		color: var(--muted-light);
	}

	.ticket-board-conflict {
		margin: 0;
		font-size: 11px;
		line-height: 1.45;
		color: var(--warn-text);
	}

	/*
	 * The board: five columns across, each scrolling on its own under a head that stays put. Too
	 * many for the pane, the board scrolls sideways; a card held at its edge scrolls it too.
	 */
	.ticket-board {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: minmax(220px, 1fr);
		grid-template-rows: minmax(0, 1fr);
		flex: 1;
		min-width: 0;
		min-height: 0;
		gap: 8px;
		overflow-x: auto;
		overflow-y: hidden;
	}

	.ticket-column {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		min-height: 0;
		overflow-y: auto;
		/* No top padding: the sticky head carries it, or cards scroll into view above the head. */
		padding: 0 8px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--line-subtle);
	}

	.ticket-column.is-focused > .ticket-column-head {
		color: var(--accent);
	}

	.ticket-column.is-drop {
		outline: 1px dashed var(--accent-border);
		outline-offset: 2px;
		border-radius: var(--radius-md);
	}

	.ticket-column-head {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		padding: 8px 0 4px;
		background: var(--line-subtle);
		font-size: 11px;
		font-weight: 650;
		color: var(--muted);
	}

	.ticket-column-count {
		font-size: 10px;
		color: var(--muted-light);
	}

	.ticket-column-clear {
		margin-left: auto;
		border: none;
		background: none;
		padding: 0;
		color: var(--accent);
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}

	.ticket-column-cards {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	.ticket-column-empty {
		margin: 0;
		font-size: 11px;
		color: var(--muted-light);
	}

	.ticket-row.is-dragging {
		opacity: 0.45;
	}

	/* Follows the pointer. It must not catch the pointer, or the drop lands on it instead of a column. */
	.ticket-ghost {
		position: fixed;
		z-index: 50;
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 220px;
		padding: 6px 8px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-md);
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
		pointer-events: none;
		transform: translate(-16px, -12px);
	}

	/* Mobile screen adaptations: bigger targets, same layout. */
	@media (max-width: 560px) {
		.ticket-list {
			padding: 10px 8px 24px;
			gap: 8px;
		}

		.ticket-row {
			padding: 10px 12px 10px 11px;
		}

		.ticket-title {
			font-size: 14px;
		}

		.ticket-head :global(.ticket-status .real-select-trigger) {
			min-height: 30px;
			padding: 4px 6px 4px 9px;
			font-size: 12px;
		}

		.ticket-artifacts,
		.ticket-jump {
			min-height: 32px;
			padding: 5px 6px;
			font-size: 12px;
		}
	}
</style>
