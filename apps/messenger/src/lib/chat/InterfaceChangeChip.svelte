<script lang="ts">
	/** Under a Bot's reply: the interface change it made without a card, and the way back (ADR 0106). Not a message. */
	import type { InterfaceRevisionHead } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';

	interface Props {
		/** The turns the reply belongs to. */
		turnIds: readonly string[];
		recent: readonly InterfaceRevisionHead[];
		t: Copy;
		api: MessengerApi | null;
	}

	let { turnIds, recent, t, api }: Props = $props();
	const chip = $derived(t.ui.chip);
	/** A change a card let through has its Undo on the card. */
	const heads = $derived(recent.filter((row) => row.actor === 'bot' && !row.approval_id && row.turn_id !== null && turnIds.includes(row.turn_id)));

	let undone = $state<Record<string, boolean>>({});
	let failed = $state<Record<string, boolean>>({});
	let busy = $state<string | null>(null);

	async function undo(id: string): Promise<void> {
		if (!api || busy) return;
		busy = id;
		try {
			await api.undoInterfaceRevision(id);
			undone = { ...undone, [id]: true };
		} catch {
			failed = { ...failed, [id]: true };
		} finally {
			busy = null;
		}
	}
</script>

{#each heads as head (head.id)}
	<div class="interface-chip">
		<span class="interface-chip-label">{chip.changed}</span>
		{#if head.changes[0]}<span class="interface-chip-text" title={head.changes.join('\n')}>{head.changes[0]}</span>{/if}
		{#if undone[head.id]}
			<span class="interface-chip-note">{chip.undone}</span>
		{:else if head.undoable && !failed[head.id]}
			<button type="button" class="interface-chip-undo" data-floor="interface-undo" disabled={busy === head.id} onclick={() => void undo(head.id)}>{chip.undo}</button>
		{:else}
			<span class="interface-chip-note">{chip.cannotUndo}</span>
		{/if}
	</div>
{/each}

<style>
	.interface-chip {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		max-width: 100%;
		margin-top: 6px;
		font-size: 12px;
		color: var(--muted);
	}

	.interface-chip-label {
		flex-shrink: 0;
		font-weight: 600;
	}

	.interface-chip-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink-secondary);
	}

	.interface-chip-note {
		flex-shrink: 0;
	}

	.interface-chip-undo {
		flex-shrink: 0;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
	}

	.interface-chip-undo:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
