<script lang="ts">
	import { tick } from 'svelte';
	import type { Bot, Provider, TaskDetail, TaskTraceNode, Ticket, TicketStatus, TicketWithArtifacts } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import Select from '../Select.svelte';
	import { endpointModelOptions } from '../model-source.ts';
	import {
		TICKET_STATUS_ORDER,
		actorFace,
		actorName,
		completionPercentage,
		latestTurnOfTicket,
		openTicketCount,
		ticketObligations,
		ticketTag,
		totalTicketCount,
		type TicketObligations
	} from './plan-board.ts';
	import { boardColumns, enqueueMove, nextQueuedMove } from './ticket-board.ts';
	import { beginCardDrag, type CardDrag } from './ticket-board-drag.ts';
	import { badgeOf, describeCheck } from './acceptance-checks.ts';

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
		onShowInTrace
	}: Props = $props();

	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot] as const)));
	const tickets = $derived([...detail.tickets].sort((a, b) => a.seq - b.seq));
	const statusOptions = TICKET_STATUS_ORDER.map((status) => ({ value: status, label: t.plan.ticketStatus[status] }));

	/** The card whose patch is on its way, so its own controls wait. Reviewer, model and depends edits set it too. */
	let patchingId = $state<string | null>(null);
	/**
	 * Requests on their way, of any kind. The plan's revision is one number for every card, so a
	 * queued move goes out only when none is: sent beside another, one of the two would be refused.
	 */
	let requestsOut = 0;
	let errorId = $state<string | null>(null);
	/** Where a card should go, until its own request comes back. A reload of the plan does not clear it. */
	let pending = $state<Map<string, TicketStatus>>(new Map());
	/** Where a card is drawn while its move has not come back. Separate from `pending`, cleared per card. */
	let optimistic = $state<Map<string, TicketStatus>>(new Map());
	/** A hand-over still waiting (submitted, in review) asked before the move goes out. */
	let confirming = $state<{ id: string; status: TicketStatus } | null>(null);
	/** Set when a 409 drops the queue, until the next move that lands or the plan changes. */
	let conflictNote = $state(false);
	/** The card under the pointer, once the press has travelled far enough to be a drag. */
	let drag = $state<CardDrag | null>(null);
	/** The column elements, so a lit column can be scrolled into view. */
	let columnFocus = $state<Partial<Record<TicketStatus, HTMLElement>>>({});
	/** This list. Cards are looked up inside it: another pane can show the same plan. */
	let rootEl = $state<HTMLElement | null>(null);

	const totalTickets = $derived(totalTicketCount(detail.ticket_counts));
	const completionPct = $derived(completionPercentage(detail.ticket_counts));
	const columns = $derived(boardColumns(tickets, optimistic));

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
		conflictNote = false;
	});

	/**
	 * The status menu, its current entry named as the row reads (a stage in its place: 审查中, 返工), so
	 * the menu's face is the one label the row has.
	 */
	function statusOptionsFor(ticket: TicketWithArtifacts): Array<{ value: string; label: string }> {
		const current = stageLabel(ticket);
		return statusOptions.map((option) => (option.value === ticket.status ? { ...option, label: current } : option));
	}

	/** A stage the status alone does not say (ADR 0046) shows in its place: 审查中, 返工, 已交付, 已通过. */
	function stageLabel(ticket: TicketWithArtifacts): string {
		const stage = ticket.stage;
		if (stage === 'submitted' || stage === 'in_review' || stage === 'rework' || stage === 'approved') return t.plan.ticketStage[stage];
		return t.plan.ticketStatus[ticket.status];
	}

	/** What every ticket meets from the spec, in words: 「验收 4 条、规则 13 条、你的要求 20 条」. */
	function planWideLine(owes: TicketObligations): string {
		const links = t.plan.links;
		const parts: string[] = [];
		if (owes.acceptance > 0) parts.push(links.acceptanceCount(owes.acceptance));
		if (owes.rules > 0) parts.push(links.rulesCount(owes.rules));
		if (owes.planRequirements > 0) parts.push(links.requirementsCount(owes.planRequirements));
		return parts.length > 0 ? links.planWide(parts.join(links.join)) : links.planWideNone;
	}

	function select(ticketId: string): void {
		onSelect(selectedId === ticketId ? null : ticketId);
	}

	function errorStatus(err: unknown): number | undefined {
		if (err && typeof err === 'object' && 'status' in err) {
			const status = (err as { status?: unknown }).status;
			return typeof status === 'number' ? status : undefined;
		}
		return undefined;
	}

	/** Who may review a ticket (ADR 0046, from level 5): a Bot of the plan's conversation, never the one on it. */
	function reviewerOptions(ticket: TicketWithArtifacts): Array<{ value: string; label: string }> {
		const owner = ticket.owner_bot_id ?? ticket.worker;
		const able = new Set(detail.reviewer_ids ?? []);
		const options = bots.filter((bot) => able.has(bot.id) && bot.id !== owner).map((bot) => ({ value: bot.id, label: bot.name }));
		// The one set now stays readable by name even once it left the plan's conversation.
		const current = ticket.reviewer_bot_id;
		if (current && !options.some((option) => option.value === current)) {
			options.push({ value: current, label: actorName(current, botsById, youLabel, deletedLabel) });
		}
		return options;
	}

	async function changeReviewer(ticket: TicketWithArtifacts, reviewer: string): Promise<void> {
		if (!api || reviewer === (ticket.reviewer_bot_id ?? '')) return;
		patchingId = ticket.id;
		requestsOut += 1;
		errorId = null;
		try {
			const result = await api.patchTicket(ticket.id, { reviewer_bot_id: reviewer || null, if_revision: detail.revision });
			onPatched(result);
		} catch (err) {
			if (errorStatus(err) === 409) {
				onConflict();
			} else {
				errorId = ticket.id;
			}
		} finally {
			requestsOut -= 1;
			patchingId = null;
		}
		// A status move queued while this was on its way waits for it.
		void pump();
	}

	/** Who an open ticket waits on (ADR 0045, from level 4), in the board's words. */
	function ballLabel(ticket: TicketWithArtifacts): string | null {
		const ball = ticket.ball;
		if (!ball) return null;
		// Waiting for another ticket (ADR 0060): which one, and whether it is the sample you approve.
		if (ball.kind === 'app' && ball.reason === 'waits' && ball.waits_for) {
			const other = detail.tickets.find((row) => row.id === ball.waits_for);
			return other ? t.plan.ballWaits(`#${ticketTag(other.seq)}`, Boolean(other.sample)) : null;
		}
		// Below level 5 a ticket waiting on you is one to mark done on the board, not an approval card.
		const key = ball.kind === 'user' && ball.reason === 'review' && !detail.submissions_on ? 'acceptance'
			: ball.kind === 'app' || ball.kind === 'user' ? (ball.reason ?? '') : ball.kind;
		const label = t.plan.ball[key];
		if (typeof label === 'function') return label(actorName(ball.bot_id ?? '', botsById, youLabel, deletedLabel));
		return label ?? null;
	}

	/** The tickets this one waits for, by their tags (「#02、#03」); null for none. */
	function dependsTags(ticket: TicketWithArtifacts): string | null {
		const tags = (ticket.depends_on ?? []).flatMap((id) => {
			const other = detail.tickets.find((row) => row.id === id);
			return other ? [`#${ticketTag(other.seq)}`] : [];
		});
		return tags.length > 0 ? tags.join('、') : null;
	}

	function dependsLabel(ticket: TicketWithArtifacts): string | null {
		const tags = dependsTags(ticket);
		return tags ? t.plan.dependsOn(tags) : null;
	}


	let dependsOpen = $state<string | null>(null);

	/** Whether `other` already waits on `ticket`, directly or through others: choosing it would make a loop. */
	function wouldLoop(ticket: TicketWithArtifacts, other: TicketWithArtifacts): boolean {
		const byId = new Map(detail.tickets.map((row) => [row.id, row] as const));
		const seen = new Set<string>();
		const stack = [...(other.depends_on ?? [])];
		while (stack.length > 0) {
			const id = stack.pop()!;
			if (id === ticket.id) return true;
			if (seen.has(id)) continue;
			seen.add(id);
			stack.push(...(byId.get(id)?.depends_on ?? []));
		}
		return false;
	}

	async function toggleDepends(ticket: TicketWithArtifacts, otherId: string): Promise<void> {
		if (!api) return;
		const current = ticket.depends_on ?? [];
		const next = current.includes(otherId) ? current.filter((id) => id !== otherId) : [...current, otherId];
		patchingId = ticket.id;
		requestsOut += 1;
		errorId = null;
		try {
			const result = await api.patchTicket(ticket.id, { depends_on: next, if_revision: detail.revision });
			onPatched(result);
		} catch (err) {
			if (errorStatus(err) === 409) {
				onConflict();
			} else {
				errorId = ticket.id;
			}
		} finally {
			requestsOut -= 1;
			patchingId = null;
		}
		// A status move queued while this was on its way waits for it.
		void pump();
	}

	/** The models a ticket can be given (ADR 0049, level 7): every model an endpoint lists. */
	const modelOptions = $derived(
		endpointModelOptions(providers, t, (provider_id, model) => JSON.stringify({ provider_id, model }))
	);

	/** The picked ticket has a menu to show below it: a reviewer (level 5), a model (level 7) or what it waits for (level 4). */
	const hasSettings = $derived(
		Boolean(detail.submissions_on) || (Boolean(detail.routing_on) && modelOptions.length > 0) || (Boolean(detail.supervision_on) && detail.tickets.length > 1)
	);

	function modelValue(ticket: TicketWithArtifacts): string {
		return ticket.model_override ? JSON.stringify({ provider_id: ticket.model_override.provider_id, model: ticket.model_override.model }) : '';
	}

	async function changeModel(ticket: TicketWithArtifacts, value: string): Promise<void> {
		if (!api || value === modelValue(ticket)) return;
		patchingId = ticket.id;
		requestsOut += 1;
		errorId = null;
		try {
			const result = await api.patchTicket(ticket.id, { model_override: value ? (JSON.parse(value) as { provider_id: string; model: string }) : null, if_revision: detail.revision });
			onPatched(result);
		} catch (err) {
			if (errorStatus(err) === 409) {
				onConflict();
			} else {
				errorId = ticket.id;
			}
		} finally {
			requestsOut -= 1;
			patchingId = null;
		}
		// A status move queued while this was on its way waits for it.
		void pump();
	}

	/** A stage a hand-over is still waiting in (ADR 0046). Moving it drops that hand-over, so it asks first. */
	function awaitingReview(ticket: TicketWithArtifacts): boolean {
		return ticket.stage === 'submitted' || ticket.stage === 'in_review';
	}

	/**
	 * Send the next queued move, one at a time: the plan's revision is one number for every card,
	 * so a second request sent before the first comes back is refused.
	 */
	async function pump(): Promise<void> {
		if (requestsOut > 0) return;
		const next = nextQueuedMove(pending, detail.tickets, null);
		if (!next || !api) return;
		const ticket = detail.tickets.find((row) => row.id === next.id);
		if (!ticket) {
			pending = new Map([...pending].filter(([id]) => id !== next.id));
			optimistic = new Map([...optimistic].filter(([id]) => id !== next.id));
			return;
		}
		patchingId = next.id;
		requestsOut += 1;
		errorId = null;
		try {
			const result = await api.patchTicket(next.id, { status: next.status, if_revision: detail.revision });
			pending = settled(pending, next);
			optimistic = settled(optimistic, next);
			conflictNote = false;
			onPatched(result);
		} catch (err) {
			pending = settled(pending, next);
			if (errorStatus(err) === 409) {
				// The conflict line says it for every card; 「保存失败」 would say it twice.
				pending = new Map();
				optimistic = new Map();
				confirming = null;
				conflictNote = true;
				onConflict();
			} else {
				const focused = cardHasFocus(next.id);
				optimistic = settled(optimistic, next);
				// Set after the card is back in its own column, so the note is not left on the node that unmounted.
				errorId = next.id;
				if (focused) void keepFocus(next.id);
			}
		} finally {
			requestsOut -= 1;
			// Another edit may have taken patchingId meanwhile; it frees it itself.
			if (patchingId === next.id) patchingId = null;
		}
		void pump();
	}

	/** The map without this move — unless the card was moved again meanwhile: that later move stays. */
	function settled(map: ReadonlyMap<string, TicketStatus>, move: { id: string; status: TicketStatus }): Map<string, TicketStatus> {
		const next = new Map(map);
		if (next.get(move.id) === move.status) next.delete(move.id);
		return next;
	}

	/** A status from the menu or a drop. A card still in review asks before it is queued. */
	function requestStatus(ticket: TicketWithArtifacts, status: TicketStatus): void {
		if (!api || status === columnOfTicket(ticket)) return;
		conflictNote = false;
		if (awaitingReview(ticket)) {
			confirming = { id: ticket.id, status };
			return;
		}
		queueMove(ticket.id, status);
	}

	function columnOfTicket(ticket: TicketWithArtifacts): TicketStatus {
		return optimistic.get(ticket.id) ?? ticket.status;
	}

	function queueMove(ticketId: string, status: TicketStatus): void {
		const focused = cardHasFocus(ticketId);
		confirming = confirming?.id === ticketId ? null : confirming;
		pending = enqueueMove(pending, ticketId, status);
		optimistic = enqueueMove(optimistic, ticketId, status);
		errorId = errorId === ticketId ? null : errorId;
		if (focused) void keepFocus(ticketId);
		void pump();
	}

	function keepCard(ticketId: string): void {
		if (confirming?.id === ticketId) confirming = null;
	}

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

	async function changeStatus(ticket: TicketWithArtifacts, status: string): Promise<void> {
		requestStatus(ticket, status as TicketStatus);
	}

	/** A press on the card. Touch scrolls the board; it does not drag. */
	function pressCard(event: PointerEvent, ticket: TicketWithArtifacts): void {
		if (!api) return;
		beginCardDrag(event, ticket.id, {
			from: () => columnOfTicket(ticket),
			busy: () => patchingId === ticket.id,
			onDrag: (next) => (drag = next),
			onDrop: (status) => requestStatus(ticket, status)
		});
	}

	/** Left and right move the focus to the neighbouring column. They do not change a status. */
	function moveFocus(event: KeyboardEvent, ticket: TicketWithArtifacts): void {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		const drawn = columnOfTicket(ticket);
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
				<svg class="ticket-title-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M9 11l3 3L22 4"></path>
					<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
				</svg>
				<span class="ticket-list-title">{t.plan.tickets}</span>
			</div>
			<div class="ticket-list-counts-wrap">
				<span class="ticket-list-counts">{t.plan.ticketCounts(openTicketCount(detail.ticket_counts), totalTickets)}</span>
				{#if totalTickets > 0}
					<span class="ticket-completion-pill mono" class:is-done={completionPct === 100}>{completionPct}%</span>
				{/if}
			</div>
		</div>

		{#if totalTickets > 0}
			<div class="ticket-progress-track" aria-hidden="true">
				<div class="ticket-progress-fill" style:width="{completionPct}%"></div>
			</div>
		{/if}

		{#if tickets.length > 0}
			<p class="ticket-list-hint">{t.plan.links.ticketsHint}</p>
		{/if}
		{#if conflictNote}
			<p class="ticket-board-conflict">{t.plan.board.conflictDropped}</p>
		{/if}
	</div>

	{#if tickets.length === 0}
		<p class="ticket-list-empty">{t.plan.ticketsNone}</p>
	{:else}
		<div class="ticket-board">
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
				{@const ball = ballLabel(ticket)}
				<!-- A closed ticket waits on nothing and nobody is still on it: 「已通过 · 设计师在做 · 要等 #02」 read as contradictory (2026-10-03). -->
				{@const closed = ticket.status === 'done' || ticket.status === 'parked'}
				{@const waits = closed ? null : dependsLabel(ticket)}
				<!-- A press on the card drags it; from the keyboard the status menu moves it. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="ticket-row is-{columnOfTicket(ticket)}"
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
								options={statusOptionsFor(ticket)}
								size="sm"
								ariaLabel={t.plan.changeStatus}
								disabled={patchingId === ticket.id}
								onchange={(value) => changeStatus(ticket, value)}
							/>
						{:else}
							<span class="ticket-status is-{ticket.status}">{stageLabel(ticket)}</span>
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
										<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
											<circle cx="12" cy="7" r="4"></circle>
										</svg>
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
						</div>
						{#if ticket.spec}
							<p class="ticket-spec">{ticket.spec}</p>
						{/if}
					</div>
					{#if ticket.artifacts.length > 0 || node || (picked && onShowInTrace)}
						<div class="ticket-links">
							{#if ticket.artifacts.length > 0}
								<button type="button" class="ticket-artifacts" onclick={() => onOpenArtifacts(ticket)}>
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
										<polyline points="14 2 14 8 20 8"></polyline>
									</svg>
									<span>{t.plan.artifacts(ticket.artifacts.length)}</span>
								</button>
							{/if}
							{#if node}
								<button type="button" class="ticket-jump" onclick={() => onJump(node.session_id, node.focus_message_id)}>
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<polyline points="9 10 4 15 9 20"></polyline>
										<path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
									</svg>
									<span>{t.plan.jumpToTurn}</span>
								</button>
							{/if}
							{#if picked && node && onShowInTrace}
								<!-- The board hides the trace; this brings it back on the picked ticket's rounds. -->
								<button type="button" class="ticket-jump ticket-show-trace" onclick={() => onShowInTrace(ticket.id)}>
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<rect x="9" y="3" width="6" height="5" rx="1"></rect>
										<rect x="3" y="16" width="6" height="5" rx="1"></rect>
										<rect x="15" y="16" width="6" height="5" rx="1"></rect>
										<path d="M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"></path>
									</svg>
									<span>{t.plan.links.showInTrace}</span>
								</button>
							{/if}
						</div>
					{/if}
					{#if picked}
						{@const owes = ticketObligations(detail, ticket.id)}
						<!-- What the picked ticket answers to: the spec, as every ticket does, and what is held to it alone. -->
						<div class="ticket-owes" role="group" aria-label={t.plan.links.heldTo}>
							<div class="ticket-owes-head">
								<span class="ticket-owes-title">{t.plan.links.heldTo}</span>
								{#if onShowSpec}
									<button type="button" class="ticket-owes-spec" onclick={onShowSpec}>
										<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
											<polyline points="14 2 14 8 20 8"></polyline>
										</svg>
										<span>{t.plan.links.showSpec}</span>
									</button>
								{/if}
							</div>
							<p class="ticket-owes-plan">{planWideLine(owes)}</p>
							{#if owes.requirements.length > 0 || owes.checks.length > 0}
								<span class="ticket-owes-sub">{t.plan.links.onlyThis}</span>
								<ul class="ticket-owes-list">
									{#each owes.requirements as entry (entry.id)}
										<li><span class="ticket-owes-seq mono">R-{entry.seq}</span><span class="ticket-owes-text">「{entry.quote}」</span></li>
									{/each}
									{#each owes.checks as check (check.id)}
										{@const badge = badgeOf(check)}
										<li><span class="ticket-owes-check is-{badge}">{t.plan.checks.status[badge]}</span><span class="ticket-owes-text">{describeCheck(check, t)}</span></li>
									{/each}
								</ul>
							{/if}
						</div>
						{#if api && hasSettings}
							<!-- Who reviews it, the model it runs on, what it waits for: set on the picked ticket only, label beside menu. -->
							<div class="ticket-settings">
								{#if detail.submissions_on}
									<span class="ticket-setting-label">{t.plan.reviewer}</span>
									<div class="ticket-select-wrap ticket-reviewer-wrap">
										<Select
											value={ticket.reviewer_bot_id ?? ''}
											options={reviewerOptions(ticket)}
											emptyLabel={t.plan.noReviewer}
											size="sm"
											ariaLabel={t.plan.reviewer}
											disabled={patchingId === ticket.id}
											onchange={(value) => changeReviewer(ticket, value)}
										/>
									</div>
								{/if}
								{#if detail.routing_on && modelOptions.length > 0}
									<span class="ticket-setting-label">{t.plan.modelShort}</span>
									<div class="ticket-select-wrap ticket-model-wrap">
										<Select
											value={modelValue(ticket)}
											options={modelOptions}
											emptyLabel={t.plan.modelOwn}
											size="sm"
											ariaLabel={t.plan.modelOverride}
											disabled={patchingId === ticket.id}
											onchange={(value) => changeModel(ticket, value)}
										/>
									</div>
								{/if}
								{#if detail.supervision_on && detail.tickets.length > 1}
									<span class="ticket-setting-label">{t.plan.editDepends}</span>
									<button
										type="button"
										class="ticket-depends-toggle"
										aria-expanded={dependsOpen === ticket.id}
										title={t.plan.dependsHint}
										onclick={() => (dependsOpen = dependsOpen === ticket.id ? null : ticket.id)}
									>
										<span class="ticket-depends-value">{dependsTags(ticket) ?? t.plan.dependsNothing}</span>
										<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<polyline points="6 9 12 15 18 9"></polyline>
										</svg>
									</button>
								{/if}
							</div>
						{/if}
					{/if}
					{#if dependsOpen === ticket.id}
						<div class="ticket-depends-editor" role="group" aria-label={t.plan.dependsHint}>
							<span class="ticket-depends-hint">{t.plan.dependsHint}</span>
							{#each detail.tickets.filter((other) => other.id !== ticket.id) as other (other.id)}
								{@const chosen = (ticket.depends_on ?? []).includes(other.id)}
								{@const loops = !chosen && wouldLoop(ticket, other)}
								{@const parked = !chosen && other.status === 'parked'}
								<label class="ticket-depends-option" class:is-loop={loops || parked} title={loops ? t.plan.dependsLoop : parked ? t.plan.dependsParked : undefined}>
									<input
										type="checkbox"
										checked={chosen}
										disabled={patchingId === ticket.id || loops || parked}
										onchange={() => toggleDepends(ticket, other.id)}
									/>
									<span class="mono">{ticketTag(other.seq)}</span>
									<span class="ticket-depends-title">{other.title}</span>
								</label>
							{/each}
						</div>
					{/if}
					{#if confirming?.id === ticket.id}
						<div class="ticket-confirm" role="group" aria-label={t.plan.board.pendingMove(t.plan.ticketStatus[confirming.status])}>
							<p>{t.plan.board.pendingMove(t.plan.ticketStatus[confirming.status])}</p>
							<div class="ticket-confirm-actions">
								<button type="button" class="ticket-confirm-go" onclick={() => confirming && queueMove(ticket.id, confirming.status)}>{t.plan.board.moveAnyway}</button>
								<button type="button" class="ticket-confirm-keep" onclick={() => keepCard(ticket.id)}>{t.plan.board.keep}</button>
							</div>
						</div>
					{/if}
					{#if errorId === ticket.id}
						<p class="ticket-error">{t.plan.saveFailed}</p>
					{/if}
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

	.ticket-title-icon {
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

	.ticket-depends-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		width: 100%;
		min-width: 0;
		padding: 3px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: inherit;
		font-size: 12px;
		line-height: 18px;
		text-align: left;
		cursor: pointer;
	}

	.ticket-depends-toggle svg {
		flex: none;
		color: var(--muted);
		transition: transform 0.2s ease;
	}

	.ticket-depends-toggle:hover,
	.ticket-depends-toggle[aria-expanded='true'] {
		border-color: var(--accent-border);
	}

	.ticket-depends-toggle[aria-expanded='true'] svg {
		transform: rotate(180deg);
		color: var(--accent);
	}

	.ticket-depends-value {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ticket-depends-editor {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		box-sizing: border-box;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
	}

	.ticket-depends-hint {
		font-size: 11px;
		color: var(--muted);
	}

	.ticket-depends-option {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--ink-secondary);
		min-width: 0;
	}

	.ticket-depends-option.is-loop {
		opacity: 0.55;
	}

	.ticket-depends-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

	/* The picked ticket's settings: a short label, then its menu, in two aligned columns. */
	.ticket-settings {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 5px 10px;
		min-width: 0;
	}

	.ticket-setting-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		white-space: nowrap;
	}

	.ticket-select-wrap {
		min-width: 0;
	}

	.ticket-settings :global(.real-select-trigger) {
		padding: 3px 8px;
		font-size: 12px;
		line-height: 18px;
		box-shadow: none;
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

	.ticket-confirm {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		background: var(--warn-bg);
		color: var(--warn-text);
		font-size: 11px;
		line-height: 1.45;
	}

	.ticket-confirm p {
		margin: 0;
	}

	.ticket-confirm-actions {
		display: flex;
		gap: 8px;
	}

	.ticket-confirm-go,
	.ticket-confirm-keep {
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		padding: 2px 8px;
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}

	.ticket-confirm-go {
		border-color: var(--warn-line);
		color: var(--warn-text);
		font-weight: 600;
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

	/* The picked ticket's obligations: the spec it meets with every ticket, and what is its alone. */
	.ticket-owes {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 7px 9px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-sm);
		background: var(--accent-tint);
		font-size: 11.5px;
		color: var(--ink-secondary);
		min-width: 0;
	}

	.ticket-owes-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
	}

	.ticket-owes-title {
		font-size: 11px;
		font-weight: 700;
		color: var(--accent);
	}

	.ticket-owes-spec {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--accent);
		font-size: 11px;
		font-weight: 500;
		line-height: 1;
		padding: 4px 7px;
		min-height: 22px;
		cursor: pointer;
	}

	.ticket-owes-spec:hover {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}

	.ticket-owes-plan {
		margin: 0;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.ticket-owes-sub {
		margin-top: 2px;
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
	}

	.ticket-owes-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ticket-owes-list li {
		display: flex;
		align-items: baseline;
		gap: 5px;
		min-width: 0;
	}

	.ticket-owes-seq {
		flex: none;
		font-size: 10px;
		font-weight: 700;
		color: var(--muted);
	}

	.ticket-owes-text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.ticket-owes-check {
		flex: none;
		padding: 0 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--muted);
		font-size: 10px;
		font-weight: 600;
		line-height: 15px;
	}

	.ticket-owes-check.is-pass {
		border-color: var(--ok-line);
		background: var(--ok-bg);
		color: var(--ok-text);
	}

	.ticket-owes-check.is-fail {
		border-color: var(--danger-line);
		background: var(--danger-bg);
		color: var(--danger-text);
	}

	.ticket-owes-check.is-blocked,
	.ticket-owes-check.is-error {
		border-color: var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
	}

	.ticket-error {
		margin: 0;
		font-size: 11px;
		color: var(--danger-text);
		overflow-wrap: anywhere;
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

		.ticket-settings :global(.real-select-trigger),
		.ticket-depends-toggle {
			min-height: 34px;
			font-size: 13px;
		}
	}
</style>
