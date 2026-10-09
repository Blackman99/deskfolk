<script lang="ts">
	import type { PlanRequirement, RequirementAction, TaskDetail } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import {
		requirementActions,
		requirementGroups,
		requirementScope,
		requirementSource,
		requirementTimes
	} from './plan-requirements.ts';
	import { requirementTicket, ticketBinding } from './plan-board.ts';

	interface Props {
		api: MessengerApi | null;
		detail: TaskDetail;
		t: Copy;
		/** The plan comes back whole after a press; the parent replaces its copy. */
		onSaved: (detail: TaskDetail) => void;
		onJump: (sessionId: string, messageId: string) => void;
		/** The ticket picked on the board: entries held to it alone stand out, those held to another dim. */
		selectedTicket?: string | null;
		/** An entry held to one ticket names it; pressing the name shows that ticket. Absent, the name is plain text. */
		onShowTicket?: (ticketId: string) => void;
	}

	/**
	 * What you asked of the job, from the requirements ledger (ADR 0040 P3): your words, a restatement
	 * beside them, how often you said each, where it holds and where you said it; what the plan
	 * inherits from the rest of its conversation; what waits for you; the old rules nobody found your
	 * words for. Each press goes to the daemon and the plan comes back.
	 */
	let { api, detail, t, onSaved, onJump, selectedTicket = null, onShowTicket }: Props = $props();

	const groups = $derived(requirementGroups(detail.requirements ?? []));
	const total = $derived((detail.requirements ?? []).filter((entry) => !entry.excluded && entry.status === 'open').length);
	let pending = $state<string | null>(null);
	let failed = $state<string | null>(null);

	/**
	 * The plan's own entries, said most often first, the first few shown; the rest a press away. A
	 * picked ticket shows them all, so none it is held to is out of sight.
	 */
	const SHOWN = 10;
	let showAll = $state(false);
	const ownShown = $derived(showAll || selectedTicket ? groups.own : groups.own.slice(0, SHOWN));
	const ownHidden = $derived(groups.own.length - ownShown.length);

	function label(action: RequirementAction): string {
		const r = t.plan.requirements;
		if (action === 'confirm') return r.confirm;
		if (action === 'reject') return r.reject;
		if (action === 'waive') return r.waive;
		if (action === 'not_here') return r.notHere;
		if (action === 'here_again') return r.hereAgain;
		if (action === 'keep') return r.keep;
		return r.wholeProject;
	}

	async function press(entry: PlanRequirement, action: RequirementAction): Promise<void> {
		if (!api || pending) return;
		pending = `${entry.id}:${action}`;
		failed = null;
		try {
			onSaved(await api.requirementAction(entry.id, { action, task_id: detail.id }));
		} catch {
			failed = entry.id;
		} finally {
			pending = null;
		}
	}
</script>

{#snippet row(entry: PlanRequirement)}
	{@const times = requirementTimes(entry, t.plan.requirements)}
	{@const ownTicket = requirementTicket(entry)}
	{@const binding = ticketBinding(ownTicket, selectedTicket)}
	{@const actions = api ? requirementActions(entry, detail) : []}
	<!--
		Two lines: your words and how often you said them; then the restatement, where they came from,
		where they hold and what you can do. In force, the buttons stay quiet until the row is pointed at.
	-->
	<li
		class="plan-req"
		class:is-ticket-mine={binding === 'mine'}
		class:is-ticket-other={binding === 'other'}
		class:is-settled={entry.status === 'open' && !entry.excluded}
		data-requirement={entry.id}
	>
		<span class="plan-req-seq mono">R-{entry.seq}</span>
		<div class="plan-req-body">
			<div class="plan-req-line">
				<span class="plan-req-quote">「{entry.quote}」</span>
				{#if times}<span class="plan-req-times">{times}</span>{/if}
			</div>
			<div class="plan-req-sub">
				{#if entry.restated}
					<span class="plan-req-restated">{t.plan.requirements.restated(entry.restated)}</span>
				{/if}
				{#if entry.supersedes}
					<span class="plan-req-restated">{t.plan.requirements.replaces(entry.supersedes.seq, entry.supersedes.quote)}</span>
				{/if}
				<span class="plan-req-meta">
					{#if entry.source?.session_id && entry.source.message_id}
						<button type="button" class="plan-req-jump" title={t.plan.requirements.jump} onclick={() => onJump(entry.source!.session_id!, entry.source!.message_id!)}>{requirementSource(entry, t.plan.requirements)}</button>
					{:else}
						<span>{requirementSource(entry, t.plan.requirements)}</span>
					{/if}
					{#if ownTicket && onShowTicket && detail.tickets.some((ticket) => ticket.id === ownTicket)}
						<button type="button" class="plan-req-ticket" onclick={() => onShowTicket(ownTicket)}>{requirementScope(entry, detail, t.plan.requirements)}</button>
					{:else}
						<span>{requirementScope(entry, detail, t.plan.requirements)}</span>
					{/if}
				</span>
				{#if actions.length > 0}
					<span class="plan-req-actions">
						{#each actions as action (action)}
							<button
								type="button"
								class="plan-req-btn"
								class:is-primary={action === 'confirm'}
								disabled={pending !== null}
								aria-busy={pending === `${entry.id}:${action}` ? 'true' : undefined}
								onclick={() => void press(entry, action)}>{label(action)}</button
							>
						{/each}
						{#if failed === entry.id}<span class="plan-req-error" role="status">{t.plan.requirements.failed}</span>{/if}
					</span>
				{/if}
			</div>
		</div>
	</li>
{/snippet}

<section class="plan-reqs" aria-label={t.plan.requirements.title}>
	<div class="plan-reqs-head" title={t.plan.requirements.hint}>
		<span class="plan-reqs-title">{t.plan.requirements.title}</span>
		{#if total > 0}<span class="plan-reqs-count mono">{total}</span>{/if}
	</div>
	{#if (detail.requirements ?? []).length === 0}
		<p class="plan-reqs-empty">{t.plan.requirements.none}</p>
	{:else}
		{#if groups.own.length > 0}
			<ul class="plan-reqs-list">
				{#each ownShown as entry (entry.id)}{@render row(entry)}{/each}
			</ul>
			{#if ownHidden > 0 || (showAll && groups.own.length > SHOWN)}
				<button type="button" class="plan-reqs-more" aria-expanded={showAll} onclick={() => (showAll = !showAll)}>
					{showAll ? t.plan.requirements.showFewer : t.plan.requirements.showAll(ownHidden)}
				</button>
			{/if}
		{/if}
		{#each groups.inherited as group (group.taskId)}
			<div class="plan-reqs-group">
				<span class="plan-reqs-group-title">{t.plan.requirements.inherited(group.title, group.entries.length)}</span>
				<ul class="plan-reqs-list">
					{#each group.entries as entry (entry.id)}{@render row(entry)}{/each}
				</ul>
			</div>
		{/each}
		{#if groups.withdrawn.length > 0}
			<div class="plan-reqs-group is-aside is-withdrawn">
				<span class="plan-reqs-group-title">{t.plan.requirements.withdrawn}</span>
				<span class="plan-reqs-group-hint">{t.plan.requirements.withdrawnHint}</span>
				<ul class="plan-reqs-list">
					{#each groups.withdrawn as entry (entry.id)}{@render row(entry)}{/each}
				</ul>
			</div>
		{/if}
		{#if groups.proposed.length > 0}
			<div class="plan-reqs-group is-aside">
				<span class="plan-reqs-group-title">{t.plan.requirements.proposed}</span>
				<span class="plan-reqs-group-hint">{t.plan.requirements.proposedHint}</span>
				<ul class="plan-reqs-list">
					{#each groups.proposed as entry (entry.id)}{@render row(entry)}{/each}
				</ul>
			</div>
		{/if}
		{#if groups.unverified.length > 0}
			<div class="plan-reqs-group is-aside">
				<span class="plan-reqs-group-title">{t.plan.requirements.unverified}</span>
				<span class="plan-reqs-group-hint">{t.plan.requirements.unverifiedHint}</span>
				<ul class="plan-reqs-list">
					{#each groups.unverified as entry (entry.id)}{@render row(entry)}{/each}
				</ul>
			</div>
		{/if}
		{#if groups.excluded.length > 0}
			<div class="plan-reqs-group is-aside">
				<span class="plan-reqs-group-title">{t.plan.requirements.excluded}</span>
				<ul class="plan-reqs-list is-excluded">
					{#each groups.excluded as entry (entry.id)}{@render row(entry)}{/each}
				</ul>
			</div>
		{/if}
	{/if}
</section>

<style>
	.plan-reqs {
		display: flex;
		flex-direction: column;
		gap: 7px;
		min-width: 0;
		padding: 10px 11px;
		border-radius: var(--radius-md);
		border: 1px solid var(--line);
		background: var(--pane);
	}

	.plan-reqs-head {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.plan-reqs-title {
		font-weight: 600;
		color: var(--muted);
		font-size: 12px;
	}

	.plan-reqs-count {
		padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 10px;
		font-weight: 700;
		line-height: 15px;
	}

	.plan-reqs-empty,
	.plan-reqs-group-hint {
		margin: 0;
		font-size: 11px;
		color: var(--muted-light);
	}

	.plan-reqs-empty {
		font-style: italic;
	}

	.plan-reqs-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
	}

	.plan-reqs-more {
		align-self: flex-start;
		border: none;
		background: none;
		padding: 2px 0;
		color: var(--accent);
		font: inherit;
		font-size: 11px;
		font-weight: 600;
		cursor: pointer;
	}

	.plan-reqs-more:hover {
		text-decoration: underline;
	}

	.plan-reqs-group {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding-top: 8px;
		border-top: 1px dashed var(--line);
	}

	.plan-reqs-group-title {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
	}

	/* The number in its own column; the words, then one line of everything about them. */
	.plan-req {
		display: grid;
		grid-template-columns: 3.4em minmax(0, 1fr);
		column-gap: 6px;
		min-width: 0;
		padding: 6px 0;
		border-top: 1px solid var(--line-subtle);
	}

	.plan-req:first-child {
		border-top: none;
	}

	.plan-req-body {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.plan-reqs-list.is-excluded .plan-req-quote {
		color: var(--muted);
		text-decoration: line-through;
	}

	.plan-req-line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 8px;
		min-width: 0;
	}

	.plan-req-seq {
		padding-top: 2px;
		font-size: 10px;
		font-weight: 700;
		line-height: 1.45;
		color: var(--muted);
	}

	.plan-req-quote {
		min-width: 0;
		font-size: 13px;
		font-weight: 500;
		line-height: 1.45;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	/* Said more than once: the words you had to repeat are the ones to look at. */
	.plan-req-times {
		flex: none;
		padding: 0 6px;
		border: 1px solid var(--warn-line);
		border-radius: var(--radius-full);
		background: var(--warn-bg);
		color: var(--warn-text);
		font-size: 10px;
		font-weight: 700;
		line-height: 16px;
	}

	.plan-req-sub {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 10px;
		min-width: 0;
		font-size: 11px;
		line-height: 1.5;
	}

	.plan-req-restated {
		min-width: 0;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.plan-req-meta {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 8px;
		color: var(--muted);
	}

	.plan-req-jump {
		border: none;
		background: none;
		padding: 0;
		color: var(--accent);
		font: inherit;
		cursor: pointer;
	}

	.plan-req-jump:hover {
		text-decoration: underline;
	}

	/* Where an entry held to one ticket says which: pressing it shows that ticket. */
	.plan-req-ticket {
		border: none;
		background: none;
		padding: 0;
		color: var(--accent);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.plan-req-ticket:hover {
		text-decoration: underline;
	}

	/* A ticket is picked: what is held to it alone stands out, what is held to another steps back. */
	.plan-req.is-ticket-mine {
		margin-inline: -6px;
		padding-inline: 6px;
		border-radius: var(--radius-xs);
		background: var(--accent-tint);
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.plan-req.is-ticket-other {
		opacity: 0.45;
	}

	.plan-req-actions {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		margin-left: auto;
		transition: opacity 0.15s ease;
	}

	/*
	 * In force, an entry's buttons wait to be pointed at, over the end of its second line, so hidden
	 * they take no room even where they would wrap; on a touch screen they stay in the line.
	 */
	@media (hover: hover) {
		.plan-req.is-settled {
			position: relative;
		}

		.plan-req.is-settled .plan-req-actions {
			position: absolute;
			right: 0;
			bottom: 4px;
			padding-left: 12px;
			background: linear-gradient(to right, transparent, var(--pane) 12px);
			opacity: 0;
			pointer-events: none;
		}

		.plan-req.is-settled:hover .plan-req-actions,
		.plan-req.is-settled:focus-within .plan-req-actions {
			opacity: 1;
			pointer-events: auto;
		}
	}

	.plan-req-btn {
		min-height: 20px;
		padding: 1px 7px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 500;
		line-height: 1.4;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.plan-req-btn:hover:not(:disabled) {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.plan-req-btn.is-primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}

	.plan-req-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.plan-req-error {
		font-size: 11px;
		color: var(--danger-text);
	}

	@media (max-width: 560px) {
		.plan-req-btn {
			min-height: 32px;
			padding: 4px 10px;
		}
	}
</style>
