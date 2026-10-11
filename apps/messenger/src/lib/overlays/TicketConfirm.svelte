<script lang="ts">
	import type { TicketWithArtifacts } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { TicketEdits } from './ticket-edits.svelte.ts';

	/** A move that waits on your word because a hand-over is still open, and a save that did not go through. */
	interface Props {
		ticket: TicketWithArtifacts;
		t: Copy;
		edits: TicketEdits;
	}

	let { ticket, t, edits }: Props = $props();
</script>

{#if edits.confirming?.id === ticket.id}
	<div class="ticket-confirm" role="group" aria-label={t.plan.board.pendingMove(t.plan.ticketStatus[edits.confirming.status])}>
		<p>{t.plan.board.pendingMove(t.plan.ticketStatus[edits.confirming.status])}</p>
		<div class="ticket-confirm-actions">
			<button type="button" class="ticket-confirm-go" onclick={() => edits.confirming && edits.queueMove(ticket.id, edits.confirming.status)}>{t.plan.board.moveAnyway}</button>
			<button type="button" class="ticket-confirm-keep" onclick={() => edits.keepCard(ticket.id)}>{t.plan.board.keep}</button>
		</div>
	</div>
{/if}
{#if edits.errorId === ticket.id}
	<p class="ticket-error">{t.plan.saveFailed}</p>
{/if}

<style>
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

	.ticket-error {
		margin: 0;
		font-size: 11px;
		color: var(--danger-text);
		overflow-wrap: anywhere;
	}
</style>
