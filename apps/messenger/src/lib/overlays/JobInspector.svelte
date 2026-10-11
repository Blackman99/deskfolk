<script module lang="ts">
	/**
	 * Beside the trace, what is picked in the job (ADR 0086): a step of the app's own, with its call;
	 * a ticket, with what it answers to and its settings; or, with nothing picked, the whole job's spec.
	 * The host says which, since on a narrow job the switch above decides it.
	 */
	export type InspectorView = 'step' | 'ticket' | 'spec';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Bot, BuiltinModelRole, TaskTraceNode, TicketStatus, TicketWithArtifacts } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import Select from '../Select.svelte';
	import PlanSpecPanel from './PlanSpecPanel.svelte';
	import TicketConfirm from './TicketConfirm.svelte';
	import TicketDepends from './TicketDepends.svelte';
	import TicketDetail from './TicketDetail.svelte';
	import TraceStepDetail from './TraceStepDetail.svelte';
	import type { JobState } from './job-state.svelte.ts';
	import { actorName, latestTurnOfTicket, ticketTag } from './plan-board.ts';
	import type { TicketEdits } from './ticket-edits.svelte.ts';
	import { ballLabel, canMakeSample, isDropped, stageLabel, statusOptionsFor } from './ticket-labels.ts';
	import type { TraceStepGroup } from './trace-steps.ts';

	interface Props {
		api: MessengerApi | null;
		job: JobState;
		edits: TicketEdits;
		view: InspectorView;
		/** The step whose panel is open, for the step view. */
		stepGroup: TraceStepGroup | null;
		/** The trace's cards, for a ticket's latest turn. */
		nodes: readonly TaskTraceNode[];
		bots: readonly Bot[];
		youLabel: string;
		deletedLabel: string;
		t: Copy;
		/** The spec held to the picked ticket, opened from the ticket's 「在要点里看」. */
		specHeld: boolean;
		/** Wide: the inspector takes the whole tab. */
		expanded: boolean;
		/** Whether widening is offered: only beside the board, not as a narrow job's page or sheet. */
		canExpand: boolean;
		callEditor?: Snippet<[BuiltinModelRole]>;
		onJump: (sessionId: string, messageId: string) => void;
		onOpenArtifacts: (ticket: TicketWithArtifacts) => void;
		onShowInTrace: (ticketId: string) => void;
		onShowTickets: (status: TicketStatus | 'all') => void;
		/** A ticket named in the spec: picked, and shown in place of the spec. */
		onShowTicket: (ticketId: string) => void;
	}

	let {
		api,
		job,
		edits,
		view,
		stepGroup,
		nodes,
		bots,
		youLabel,
		deletedLabel,
		t,
		specHeld = $bindable(),
		expanded = $bindable(),
		canExpand,
		callEditor,
		onJump,
		onOpenArtifacts,
		onShowInTrace,
		onShowTickets,
		onShowTicket
	}: Props = $props();

	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot] as const)));
	const ticket = $derived(job.selectedTicket ? (job.detail?.tickets.find((row) => row.id === job.selectedTicket) ?? null) : null);
	const latest = $derived(ticket ? latestTurnOfTicket(nodes, ticket.id) : null);
	/** The ticket whose list of what it waits for is open. */
	let dependsOpen = $state<string | null>(null);

	function nameOf(id: string): string {
		return actorName(id, botsById, youLabel, deletedLabel);
	}
</script>

{#snippet widen()}
	{#if canExpand}
		<button
			type="button"
			class="insp-icon"
			title={expanded ? t.plan.job.collapse : t.plan.job.expand}
			aria-label={expanded ? t.plan.job.collapse : t.plan.job.expand}
			aria-pressed={expanded}
			onclick={() => (expanded = !expanded)}
		>
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				{#if expanded}
					<polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line>
				{:else}
					<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line>
				{/if}
			</svg>
		</button>
	{/if}
{/snippet}

<div class="job-inspector-inner" data-inspector={view}>
	{#if view === 'step' && stepGroup}
		<TraceStepDetail
			group={stepGroup}
			{t}
			fetchRun={api ? (id) => api!.callRun(id) : undefined}
			{onJump}
			{callEditor}
			onClose={() => (job.openStep = null)}
		/>
	{:else if view === 'ticket' && ticket && job.detail}
		{@const detail = job.detail}
		{@const ball = ballLabel(ticket, detail, t, nameOf)}
		<header class="insp-head">
			<span class="insp-tag mono">#{ticketTag(ticket.seq)}</span>
			<h3 class="insp-title" title={ticket.title}>{ticket.title}</h3>
			{@render widen()}
			<button type="button" class="insp-icon" title={t.plan.job.unpick} aria-label={t.plan.job.unpick} onclick={() => (job.selectedTicket = null)}>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
			</button>
		</header>
		<div class="insp-body">
			<div class="insp-status">
				{#if api}
					<Select
						class="insp-status-menu is-{ticket.status}"
						value={ticket.status}
						options={statusOptionsFor(ticket, t)}
						size="sm"
						ariaLabel={t.plan.changeStatus}
						disabled={edits.patchingId === ticket.id}
						onchange={(value) => edits.changeStatus(ticket, value)}
					/>
				{:else}
					<span class="insp-stage">{stageLabel(ticket, t)}</span>
				{/if}
				{#if ticket.parts && ticket.parts.total > 0}
					<span class="insp-meta mono">{t.plan.partsApproved(ticket.parts.approved, ticket.parts.total)}</span>
				{/if}
				{#if ball}<span class="insp-meta">{ball}</span>{/if}
			</div>
			{#if isDropped(ticket) && ticket.dropped_why}
				<p class="insp-dropped">{t.plan.droppedWhy(ticket.dropped_why)}</p>
			{/if}
			{#if ticket.spec}
				<p class="insp-spec">{ticket.spec}</p>
			{/if}
			<div class="insp-links">
				{#if ticket.artifacts.length > 0}
					<button type="button" class="insp-link" onclick={() => onOpenArtifacts(ticket)}>{t.plan.artifacts(ticket.artifacts.length)}</button>
				{/if}
				{#if latest}
					<button type="button" class="insp-link" onclick={() => onShowInTrace(ticket.id)}>{t.plan.links.showInTrace}</button>
					<button type="button" class="insp-link" onclick={() => onJump(latest.session_id, latest.focus_message_id)}>{t.plan.jumpToTurn}</button>
				{/if}
				{#if api && canMakeSample(ticket, detail)}
					<button type="button" class="insp-link" title={t.plan.makeSampleHint} disabled={edits.patchingId === ticket.id} onclick={() => edits.makeSample(ticket)}>{t.plan.makeSample}</button>
				{/if}
			</div>
			<div class="insp-ticket">
				<TicketDetail {api} {detail} {ticket} {t} {bots} {youLabel} {deletedLabel} {edits} onShowSpec={() => (specHeld = true)} bind:dependsOpen />
				{#if dependsOpen === ticket.id}
					<TicketDepends {detail} {ticket} {t} {edits} />
				{/if}
				<TicketConfirm {ticket} {t} {edits} />
			</div>
		</div>
	{:else if view === 'spec' && job.detail}
		{@const held = specHeld && ticket ? ticket : null}
		<header class="insp-head">
			{#if held}
				<button type="button" class="insp-back" onclick={() => (specHeld = false)}>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
					<span>{t.plan.job.backToTicket(`#${ticketTag(held.seq)}`)}</span>
				</button>
			{:else}
				<span class="insp-label">{t.plan.job.wholeJob}</span>
			{/if}
			{@render widen()}
		</header>
		<div class="insp-body is-spec">
			<PlanSpecPanel
				{api}
				detail={job.detail}
				{t}
				onSaved={(next) => (job.detail = next)}
				onConflict={() => job.reloadPlan()}
				{onJump}
				selectedTicket={held?.id ?? null}
				{onShowTicket}
				onClearTicket={() => (specHeld = false)}
				{onShowTickets}
				{bots}
				{deletedLabel}
			/>
		</div>
	{/if}
</div>

<style>
	.job-inspector-inner {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		height: 100%;
		background: var(--pane);
	}

	.insp-head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 40px;
		box-sizing: border-box;
		padding: 6px 8px 6px 12px;
		border-bottom: 1px solid var(--line-subtle);
	}

	.insp-tag {
		flex: none;
		font-size: 11px;
		color: var(--muted);
	}

	.insp-title {
		flex: 1;
		min-width: 0;
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		font-weight: 600;
	}

	.insp-label {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		font-weight: 700;
		color: var(--ink);
	}

	.insp-back {
		flex: 1;
		min-width: 0;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 4px;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--accent);
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}

	.insp-back:hover {
		background: var(--accent-tint);
	}

	.insp-icon {
		flex: none;
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

	.insp-icon:hover,
	.insp-icon[aria-pressed='true'] {
		border-color: var(--line);
		background: var(--line-subtle);
		color: var(--ink);
	}

	.insp-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 10px 12px calc(14px + env(safe-area-inset-bottom));
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	/*
	 * The spec is a page of its own: it lays itself out and scrolls here. A block, not a flex column:
	 * the spec measures its own width (a size container), which as a flex item would be none at all.
	 */
	.insp-body.is-spec {
		display: block;
		padding: 0;
	}

	/* The status menu as wide as what it says, as on the board's card. */
	.insp-status :global(.real-select) {
		width: auto;
		min-width: 132px;
	}

	.insp-status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
		font-size: 12px;
	}

	.insp-stage {
		font-weight: 600;
	}

	.insp-meta {
		font-size: 11px;
		color: var(--muted);
	}

	.insp-dropped {
		margin: 0;
		font-size: 11.5px;
		color: var(--muted);
	}

	.insp-spec {
		margin: 0;
		padding: 6px 8px;
		border-radius: var(--radius-xs);
		background: var(--line-subtle);
		font-size: 12px;
		line-height: 1.5;
		color: var(--ink-secondary);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.insp-links {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 10px;
		margin-left: -4px;
	}

	.insp-link {
		padding: 3px 4px;
		border: 0;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 11.5px;
		font-weight: 500;
		cursor: pointer;
	}

	.insp-link:hover:not(:disabled) {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.insp-ticket {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}
</style>
