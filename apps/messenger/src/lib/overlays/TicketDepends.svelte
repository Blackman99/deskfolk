<script lang="ts">
	import type { TaskDetail, TicketWithArtifacts } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { ticketTag } from './plan-board.ts';
	import type { TicketEdits } from './ticket-edits.svelte.ts';

	/** What a ticket waits for, as a list of the plan's other tickets to tick, opened from its settings. */
	interface Props {
		detail: TaskDetail;
		ticket: TicketWithArtifacts;
		t: Copy;
		edits: TicketEdits;
	}

	let { detail, ticket, t, edits }: Props = $props();

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
</script>

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
				disabled={edits.patchingId === ticket.id || loops || parked}
				onchange={() => edits.toggleDepends(ticket, other.id)}
			/>
			<span class="mono">{ticketTag(other.seq)}</span>
			<span class="ticket-depends-title">{other.title}</span>
		</label>
	{/each}
</div>

<style>
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
</style>
