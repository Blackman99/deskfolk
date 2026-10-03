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

	function label(action: RequirementAction): string {
		const r = t.plan.requirements;
		if (action === 'confirm') return r.confirm;
		if (action === 'reject') return r.reject;
		if (action === 'waive') return r.waive;
		if (action === 'not_here') return r.notHere;
		if (action === 'here_again') return r.hereAgain;
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
	<li class="plan-req" class:is-ticket-mine={binding === 'mine'} class:is-ticket-other={binding === 'other'} data-requirement={entry.id}>
		<div class="plan-req-line">
			<span class="plan-req-seq mono">R-{entry.seq}</span>
			<span class="plan-req-quote">「{entry.quote}」</span>
		</div>
		{#if entry.restated}
			<div class="plan-req-restated">{t.plan.requirements.restated(entry.restated)}</div>
		{/if}
		{#if entry.supersedes}
			<div class="plan-req-restated">{t.plan.requirements.replaces(entry.supersedes.seq, entry.supersedes.quote)}</div>
		{/if}
		<div class="plan-req-meta">
			{#if entry.source?.session_id && entry.source.message_id}
				<button type="button" class="plan-req-jump" title={t.plan.requirements.jump} onclick={() => onJump(entry.source!.session_id!, entry.source!.message_id!)}>{requirementSource(entry, t.plan.requirements)}</button>
			{:else}
				<span>{requirementSource(entry, t.plan.requirements)}</span>
			{/if}
			{#if times}<span class="plan-req-times">{times}</span>{/if}
			{#if ownTicket && onShowTicket && detail.tickets.some((ticket) => ticket.id === ownTicket)}
				<button type="button" class="plan-req-ticket" onclick={() => onShowTicket(ownTicket)}>{requirementScope(entry, detail, t.plan.requirements)}</button>
			{:else}
				<span>{requirementScope(entry, detail, t.plan.requirements)}</span>
			{/if}
		</div>
		{#if api}
			{@const actions = requirementActions(entry, detail)}
			{#if actions.length > 0}
				<div class="plan-req-actions">
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
				</div>
			{/if}
		{/if}
	</li>
{/snippet}

<section class="plan-reqs" aria-label={t.plan.requirements.title}>
	<div class="plan-reqs-head">
		<span class="plan-reqs-title">{t.plan.requirements.title}</span>
		{#if total > 0}<span class="plan-reqs-count mono">{total}</span>{/if}
	</div>
	{#if (detail.requirements ?? []).length === 0}
		<p class="plan-reqs-empty">{t.plan.requirements.none}</p>
	{:else}
		<p class="plan-reqs-hint">{t.plan.requirements.hint}</p>
		{#if groups.own.length > 0}
			<ul class="plan-reqs-list">
				{#each groups.own as entry (entry.id)}{@render row(entry)}{/each}
			</ul>
		{/if}
		{#each groups.inherited as group (group.taskId)}
			<div class="plan-reqs-group">
				<span class="plan-reqs-group-title">{t.plan.requirements.inherited(group.title, group.entries.length)}</span>
				<ul class="plan-reqs-list">
					{#each group.entries as entry (entry.id)}{@render row(entry)}{/each}
				</ul>
			</div>
		{/each}
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

	.plan-reqs-hint,
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
		gap: 8px;
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

	.plan-req {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.plan-reqs-list.is-excluded .plan-req-quote {
		color: var(--muted);
		text-decoration: line-through;
	}

	.plan-req-line {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
	}

	.plan-req-seq {
		flex: none;
		font-size: 10px;
		font-weight: 700;
		color: var(--muted);
	}

	.plan-req-quote {
		min-width: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.plan-req-restated {
		font-size: 11px;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.plan-req-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		font-size: 11px;
		color: var(--muted);
	}

	.plan-req-times {
		color: var(--ink-secondary);
		font-weight: 600;
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
		padding: 3px 6px;
		border-radius: var(--radius-xs);
		background: var(--accent-tint);
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.plan-req.is-ticket-other {
		opacity: 0.45;
	}

	.plan-req-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 5px;
		margin-top: 3px;
	}

	.plan-req-btn {
		min-height: 24px;
		padding: 2px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 500;
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
