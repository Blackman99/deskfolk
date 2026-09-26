<script lang="ts">
	import type { Bot, TaskDetail, TaskTraceNode, Ticket, TicketStatus, TicketWithArtifacts } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import Select from '../Select.svelte';
	import {
		TICKET_STATUS_ORDER,
		actorFace,
		actorName,
		completionPercentage,
		countsEntries,
		latestTurnOfTicket,
		openTicketCount,
		ticketTag,
		totalTicketCount
	} from './plan-board.ts';

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
		onSelect: (ticketId: string | null) => void;
		onJump: (sessionId: string, messageId: string) => void;
		onOpenArtifacts: (ticket: TicketWithArtifacts) => void;
		onPatched: (ticket: Ticket) => void;
		onConflict: () => void;
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
		onSelect,
		onJump,
		onOpenArtifacts,
		onPatched,
		onConflict
	}: Props = $props();

	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot] as const)));
	const tickets = $derived([...detail.tickets].sort((a, b) => a.seq - b.seq));
	const statusOptions = TICKET_STATUS_ORDER.map((status) => ({ value: status, label: t.plan.ticketStatus[status] }));

	let patchingId = $state<string | null>(null);
	let errorId = $state<string | null>(null);
	let statusFilter = $state<TicketStatus | 'all'>('all');

	const totalTickets = $derived(totalTicketCount(detail.ticket_counts));
	const completionPct = $derived(completionPercentage(detail.ticket_counts));

	const displayedTickets = $derived(
		statusFilter === 'all' ? tickets : tickets.filter((tk) => tk.status === statusFilter)
	);

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

	async function changeStatus(ticket: TicketWithArtifacts, status: string): Promise<void> {
		if (!api || status === ticket.status) return;
		patchingId = ticket.id;
		errorId = null;
		try {
			const result = await api.patchTicket(ticket.id, { status: status as Ticket['status'], if_revision: detail.revision });
			onPatched(result);
		} catch (err) {
			if (errorStatus(err) === 409) {
				onConflict();
			} else {
				errorId = ticket.id;
			}
		} finally {
			patchingId = null;
		}
	}
</script>

<section class="ticket-list" aria-label={t.plan.tickets}>
	<div class="ticket-list-header-group">
		<div class="ticket-list-head">
			<div class="ticket-list-title-wrap">
				<svg class="ticket-title-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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

		{#if tickets.length > 2}
			<div class="ticket-filters" role="tablist" aria-label="Filter status">
				<button
					type="button"
					class="ticket-filter-btn"
					class:is-active={statusFilter === 'all'}
					onclick={() => (statusFilter = 'all')}
				>
					<span>全部</span>
					<span class="ticket-filter-badge mono">{tickets.length}</span>
				</button>
				{#each countsEntries(detail.ticket_counts) as entry (entry.status)}
					<button
						type="button"
						class="ticket-filter-btn is-{entry.status}"
						class:is-active={statusFilter === entry.status}
						onclick={() => (statusFilter = statusFilter === entry.status ? 'all' : entry.status)}
					>
						<span>{t.plan.ticketStatus[entry.status]}</span>
						<span class="ticket-filter-badge mono">{entry.count}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if tickets.length === 0}
		<p class="ticket-list-empty">{t.plan.ticketsNone}</p>
	{:else if displayedTickets.length === 0}
		<div class="ticket-list-empty-filter">
			<p>当前筛选下无任务</p>
			<button type="button" class="ticket-reset-filter" onclick={() => (statusFilter = 'all')}>查看全部</button>
		</div>
	{:else}
		<div class="ticket-rows">
			{#each displayedTickets as ticket (ticket.id)}
				{@const face = actorFace(ticket.worker ?? '', botsById, youLabel, deletedLabel)}
				{@const node = latestTurnOfTicket(nodes, ticket.id)}
				<div class="ticket-row is-{ticket.status}" class:is-selected={ticket.id === selectedId}>
					<button type="button" class="ticket-main" onclick={() => select(ticket.id)}>
						<span class="ticket-line">
							<span class="ticket-tag mono">{ticketTag(ticket.seq)}</span>
							<span class="ticket-title">{ticket.title}</span>
							<span class="ticket-status is-{ticket.status}">{t.plan.ticketStatus[ticket.status]}</span>
						</span>
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
									<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
										<circle cx="12" cy="7" r="4"></circle>
									</svg>
								</span>
							{/if}
							<span class="ticket-who-text">
								{ticket.worker ? t.plan.worker(actorName(ticket.worker, botsById, youLabel, deletedLabel)) : t.plan.nobody}
							</span>
						</span>
						{#if ticket.spec}
							<span class="ticket-spec">{ticket.spec}</span>
						{/if}
					</button>
					<div class="ticket-actions">
						{#if ticket.artifacts.length > 0}
							<button type="button" class="ticket-artifacts" onclick={() => onOpenArtifacts(ticket)}>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
									<polyline points="14 2 14 8 20 8"></polyline>
								</svg>
								<span>{t.plan.artifacts(ticket.artifacts.length)}</span>
							</button>
						{/if}
						{#if node}
							<button type="button" class="ticket-jump" onclick={() => onJump(node.session_id, node.focus_message_id)}>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<polyline points="9 10 4 15 9 20"></polyline>
									<path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
								</svg>
								<span>{t.plan.jumpToTurn}</span>
							</button>
						{/if}
						{#if api}
							<div class="ticket-select-wrap">
								<Select
									value={ticket.status}
									options={statusOptions}
									size="sm"
									ariaLabel={t.plan.changeStatus}
									disabled={patchingId === ticket.id}
									onchange={(value) => changeStatus(ticket, value)}
								/>
							</div>
						{/if}
					</div>
					{#if errorId === ticket.id}
						<p class="ticket-error">{t.plan.saveFailed}</p>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	.ticket-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
		padding: 12px 10px 20px;
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
		border-radius: 9999px;
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
		border-radius: 9999px;
		background: var(--line);
		overflow: hidden;
	}

	.ticket-progress-fill {
		height: 100%;
		border-radius: 9999px;
		background: var(--ok);
		transition: width 0.3s ease;
	}

	/* Filters */
	.ticket-filters {
		display: flex;
		align-items: center;
		gap: 4px;
		overflow-x: auto;
		padding: 2px 0 4px;
		scrollbar-width: none;
	}

	.ticket-filters::-webkit-scrollbar {
		display: none;
	}

	.ticket-filter-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
		border: 1px solid var(--line);
		border-radius: 9999px;
		background: var(--pane);
		color: var(--muted);
		font-size: 10.5px;
		font-weight: 500;
		padding: 2px 7px;
		cursor: pointer;
		transition: all 0.15s ease;
		user-select: none;
	}

	.ticket-filter-btn:hover {
		border-color: var(--line-hover);
		color: var(--ink);
	}

	.ticket-filter-btn.is-active {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
		font-weight: 600;
	}

	.ticket-filter-badge {
		font-size: 9.5px;
		opacity: 0.8;
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

	.ticket-list-empty-filter {
		margin: 8px 0;
		padding: 12px;
		text-align: center;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		font-size: 11.5px;
		color: var(--muted);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
	}

	.ticket-list-empty-filter p {
		margin: 0;
	}

	.ticket-reset-filter {
		border: none;
		background: none;
		padding: 0;
		color: var(--accent);
		font-size: 11px;
		cursor: pointer;
		font-weight: 500;
	}

	/* Ticket rows */
	.ticket-rows {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	.ticket-row {
		border: 1px solid var(--line);
		border-left: 3.5px solid var(--muted-light);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
		overflow: hidden;
		transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.1s ease;
	}

	.ticket-row:hover {
		border-color: var(--line-hover);
		box-shadow: var(--shadow-xs);
	}

	.ticket-row.is-doing {
		border-color: var(--accent-border);
		border-left-color: var(--accent);
		background: linear-gradient(135deg, var(--accent-tint) 0%, var(--pane) 50%);
	}

	.ticket-row.is-review {
		border-color: var(--purple-line);
		border-left-color: var(--purple);
		background: linear-gradient(135deg, var(--purple-bg) 0%, var(--pane) 50%);
	}

	.ticket-row.is-done {
		border-color: var(--ok-line);
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

	/* Ticket Main Button */
	.ticket-main {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 5px;
		width: 100%;
		box-sizing: border-box;
		padding: 9px 11px 7px;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		font: inherit;
		color: inherit;
		transition: background 0.12s ease;
	}

	.ticket-main:hover {
		background: rgba(15, 23, 42, 0.02);
	}

	.ticket-line {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		min-width: 0;
	}

	.ticket-tag {
		flex: none;
		font-size: 10px;
		font-weight: 700;
		color: var(--muted);
		background: var(--line-subtle);
		padding: 1px 5px;
		border-radius: 3px;
		line-height: 14px;
	}

	.ticket-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink);
		letter-spacing: -0.01em;
	}

	.ticket-status {
		display: inline-flex;
		align-items: center;
		flex: none;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--muted);
	}

	.ticket-status::before {
		content: "";
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
		margin-right: 4px;
		vertical-align: middle;
		flex: none;
	}

	.ticket-status.is-doing {
		color: var(--accent);
	}

	.ticket-status.is-doing::before {
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	.ticket-status.is-review {
		color: var(--purple);
	}

	.ticket-status.is-done {
		color: var(--ok-text);
	}

	.ticket-status.is-todo,
	.ticket-status.is-parked {
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
		font-size: 9px;
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
		width: 100%;
		box-sizing: border-box;
		font-size: 11.5px;
		color: var(--ink-secondary);
		line-height: 1.4;
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		padding: 3px 6px;
		border-radius: 4px;
		background: var(--line-subtle);
	}

	/* Actions */
	.ticket-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		padding: 2px 10px 8px;
	}

	.ticket-artifacts,
	.ticket-jump {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 500;
		line-height: 1;
		padding: 4px 7px;
		cursor: pointer;
		min-height: 24px;
		transition: all 0.15s ease;
	}

	.ticket-artifacts:hover,
	.ticket-jump:hover {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.ticket-select-wrap {
		margin-left: auto;
	}

	.ticket-actions :global(.real-select) {
		width: auto;
		min-width: 88px;
	}

	.ticket-error {
		margin: 0;
		padding: 0 10px 6px;
		font-size: 11px;
		color: var(--danger-text);
		overflow-wrap: anywhere;
	}

	/* Mobile screen adaptations */
	@media (max-width: 560px) {
		.ticket-list {
			padding: 10px 8px 24px;
			gap: 8px;
		}

		.ticket-title {
			font-size: 13.5px;
		}

		.ticket-main {
			padding: 10px 12px 8px;
		}

		.ticket-actions {
			padding: 4px 12px 10px;
			gap: 8px;
		}

		.ticket-artifacts,
		.ticket-jump {
			min-height: 32px;
			padding: 5px 9px;
			font-size: 11.5px;
		}

		.ticket-actions :global(.real-select) {
			min-width: 96px;
		}
	}
</style>
